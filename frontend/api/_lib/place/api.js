// Public Place API, one router behind /api/place/*. Read endpoints are open to the site and to
// agents (CORS *); writes are an IPFS upload with a per-IP limit and admin-signed storefront moderation.
//
//   GET  /api/place/campaigns    ?chain&status=live|upcoming|ended|all&target&creator&kind&limit&offset
//   GET  /api/place/campaign     ?chain&hub&id[&address]
//   GET  /api/place/claims       ?chain&address          claimable, claimed, expired + ready claimMany txs
//   GET  /api/place/token        ?chain&address          asset info and its campaigns
//   GET  /api/place/collections  ?chain[&creator]
//   GET  /api/place/holders      ?chain&target&kind[&min&limit]   preview for the Create form
//   POST /api/place/pin          {kind: rules|metadata|image|folder, …}   folder: NFT images or metadata as one IPFS folder
//   POST /api/place/admin/hide   {chainId, action, type, target, admin, issuedAt, signature}
//   GET  /api/place/launch/*     Place Launch: tokens, token, candles, trades, holders, creator, predict, pairs (../launch/api.js)
import { encodeFunctionData } from 'viem';
import { PLACE_HUB_ABI } from '../../../src/place/abi.js';
import { DEPLOYMENTS, activeHub } from '../../../src/place/deployments.js';
import { campaignStatus, PUBLISH_GRACE_SECONDS } from '../../../src/place/status.js';
import { moderationMessage, DEFAULT_ADMINS } from '../../../src/place/moderation.js';
import { validateRules, canonicalJson, encodeRules } from '../../../src/place/snapshot/rules.js';
import { proofFromDb } from './snapshotJob.js';
import { transfersPage, erc20BalancesAt, nftHoldingsAt, autoExclusions, retry } from './chain.js';
import { reply, bad, HttpError, fail, chainOf, addressOf, limits, iso, str } from './http.js';
import { LAUNCH_ROUTES } from '../launch/api.js';
import { reviewRegistration } from '../launch/projects.js';
import { ensureTokenMeta } from './tokenMeta.js';

export { ensureTokenMeta };

export const ETH = '0x0000000000000000000000000000000000000000';
const PIN_LIMIT_PER_HOUR = 30;
const MAX_METADATA_BYTES = 10 * 1024;
const MAX_IMAGE_BYTES = 600 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_FOLDER_BYTES = 3_500_000; // under the 4.5 MB request limit of serverless functions, after base64
const MAX_FOLDER_FILES = 1000;
const FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const NFT_IMAGE_LINK = /^(ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*|https:\/\/\S+)$/;

/** One file of a folder pin: an image, or NFT metadata JSON (name, description, image, attributes). */
function folderFile(f) {
  if (!f || !FILE_NAME.test(String(f.name || ''))) fail('Each file needs a name of letters, digits, dot, dash or underscore');
  if (f.contentType === 'application/json') {
    let m;
    try {
      m = typeof f.content === 'string' ? JSON.parse(f.content) : f.content;
    } catch {
      fail(`${f.name}: not valid JSON`);
    }
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 200) fail(`${f.name}: name must be 1–200 characters`);
    if (m.description != null && (typeof m.description !== 'string' || m.description.length > 2000)) fail(`${f.name}: description is too long`);
    if (m.image != null && !NFT_IMAGE_LINK.test(m.image)) fail(`${f.name}: image must be an ipfs:// or https:// link`);
    if (m.attributes != null && (!Array.isArray(m.attributes) || m.attributes.length > 50)) fail(`${f.name}: attributes must be a list of up to 50`);
    const attributes = m.attributes ? { attributes: m.attributes.map((a) => ({ trait_type: String(a?.trait_type ?? '').slice(0, 64), value: String(a?.value ?? '').slice(0, 128) })) } : {};
    const clean = { name: m.name.trim(), description: m.description ?? null, image: m.image ?? null, ...attributes };
    return { name: f.name, bytes: Buffer.from(canonicalJson(clean)), contentType: 'application/json' };
  }
  if (!IMAGE_TYPES.includes(f.contentType)) fail(`${f.name}: contentType must be application/json or one of ${IMAGE_TYPES.join(', ')}`);
  const bytes = Buffer.from(String(f.data || ''), 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail(`${f.name}: image must be 1 byte to ${MAX_IMAGE_BYTES / 1024} KB`);
  return { name: f.name, bytes, contentType: f.contentType };
}
const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * @param {object} req  { method, path ('campaigns', 'admin/hide', …), query, body, ip }
 * @param {object} deps { db, client(chainId), pin(bytes, {name, contentType}), now() → unix seconds }
 */
export async function handlePlace(req, deps) {
  if (req.method === 'OPTIONS') return reply(204, null);
  const route = `${req.method} ${String(req.path || '').replace(/^\/+|\/+$/g, '')}`;
  const handlers = {
    'GET campaigns': listCampaigns,
    'GET campaign': getCampaign,
    'GET claims': getClaims,
    'GET token': getToken,
    'GET collections': listCollections,
    'GET holders': holdersPreview,
    'POST pin': pin,
    'POST admin/hide': moderate,
    ...LAUNCH_ROUTES,
  };
  const h = handlers[route];
  if (!h) return bad(`No route ${route}`, 404);
  try {
    return await h(req, deps);
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    return bad(`Internal error: ${e.message}`, 500);
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

export function campaignView(r, now) {
  return {
    chainId: Number(r.chain_id),
    hub: r.hub,
    id: str(r.campaign_id),
    creator: r.creator,
    kind: Number(r.kind) === 1 ? 'nft-holders' : 'token-holders',
    target: r.target,
    targetMeta: r.t_symbol != null || r.t_name != null ? { name: r.t_name, symbol: r.t_symbol, decimals: r.t_decimals ?? null } : null,
    rewardToken: r.reward_token === ETH ? 'eth' : r.reward_token,
    rewardMeta:
      r.reward_token === ETH
        ? { name: 'Ether', symbol: 'ETH', decimals: 18 }
        : r.r_symbol != null || r.r_name != null
          ? { name: r.r_name, symbol: r.r_symbol, decimals: r.r_decimals ?? null }
          : null,
    pool: str(r.pool),
    fee: str(r.fee),
    totalAllocated: str(r.total_allocated),
    claimed: str(r.claimed),
    snapshotAt: iso(r.snapshot_at),
    claimDuration: Number(r.claim_duration),
    claimEnd: iso(r.claim_end),
    refundableAt: r.merkle_root ? null : iso(new Date(r.snapshot_at).getTime() + PUBLISH_GRACE_SECONDS * 1000),
    leftover: r.burn_leftover ? 'burn' : 'return',
    status: campaignStatus(r, now),
    merkleRoot: r.merkle_root,
    rulesHash: r.rules_hash,
    rulesURI: r.rules_uri,
    metadataURI: r.metadata_uri || null,
    proofsURI: r.proofs_uri,
    hidden: Boolean(r.hidden || r.asset_hidden),
    // Place Launch: the target was launched on Place; the campaign came from its creator vault's rewards pool.
    launchedOnPlace: Boolean(r.launch_vault !== undefined && r.launch_token),
    fromLaunchVault: Boolean(r.launch_vault && r.launch_vault === r.creator),
    // Official = from the launch creator or the token community fund; the rest is from the community.
    section: r.launch_token && (r.creator === r.launch_vault || r.creator === r.launch_creator || r.creator === r.launch_original_creator) ? 'official' : 'community',
    createdAt: iso(r.created_at),
    createdTx: r.created_tx,
  };
}

const CAMPAIGN_SELECT = `
  select c.*, tm.name as t_name, tm.symbol as t_symbol, tm.decimals as t_decimals,
         rm.name as r_name, rm.symbol as r_symbol, rm.decimals as r_decimals,
         (ha.address is not null) as asset_hidden, lt.token as launch_token, lt.vault as launch_vault,
         lt.current_creator as launch_creator, lt.original_creator as launch_original_creator
  from campaigns c
  left join launch_tokens lt on lt.chain_id = c.chain_id and lt.token = c.target
  left join token_meta tm on tm.chain_id = c.chain_id and tm.address = c.target
  left join token_meta rm on rm.chain_id = c.chain_id and rm.address = c.reward_token
  left join hidden_assets ha on ha.chain_id = c.chain_id and ha.address = c.target`;

// ─────────────────────────────── campaigns ───────────────────────────────

async function listCampaigns({ query: q }, deps) {
  const chainId = chainOf(q);
  const now = deps.now();
  const { limit, offset } = limits(q);
  const where = ['c.chain_id = $1'];
  const params = [chainId];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const nowIso = new Date(now * 1000).toISOString();
  const status = q.status || 'all';
  let order = 'c.created_at desc, c.pk desc';
  if (status === 'live') {
    where.push(`c.stage = 'open' and c.merkle_root is not null`);
    add('c.claim_end > ?', nowIso);
    order = 'c.claim_end asc';
  } else if (status === 'upcoming') {
    where.push(`c.stage = 'open' and c.merkle_root is null`);
    add(`c.snapshot_at + interval '${PUBLISH_GRACE_SECONDS} seconds' > ?`, nowIso);
    order = 'c.snapshot_at asc';
  } else if (status === 'ended') {
    params.push(nowIso);
    const p = `$${params.length}`;
    where.push(`(c.stage <> 'open' or (c.merkle_root is not null and c.claim_end <= ${p})
                 or (c.merkle_root is null and c.snapshot_at + interval '${PUBLISH_GRACE_SECONDS} seconds' <= ${p}))`);
  } else if (status !== 'all') fail('status must be live, upcoming, ended or all');
  if (q.target) add('c.target = ?', addressOf(q.target, 'target'));
  if (q.creator) add('c.creator = ?', addressOf(q.creator, 'creator'));
  if (q.kind) add('c.kind = ?', q.kind === 'nft-holders' ? 1 : q.kind === 'token-holders' ? 0 : fail('kind'));
  if (q.includeHidden !== '1') where.push('not c.hidden and ha.address is null');

  const rows = await deps.db.query(`${CAMPAIGN_SELECT} where ${where.join(' and ')} order by ${order} limit ${limit + 1} offset ${offset}`, params);
  const page = rows.slice(0, limit);
  await ensureTokenMeta(deps, chainId, page.flatMap((r) => [r.target, r.reward_token]));
  const fresh = page.length ? await deps.db.query(`${CAMPAIGN_SELECT} where c.pk = any($1::bigint[]) order by ${order}`, [page.map((r) => String(r.pk))]) : [];
  return reply(200, { campaigns: fresh.map((r) => campaignView(r, now)), nextOffset: rows.length > limit ? offset + limit : null }, 'public, max-age=15');
}

async function getCampaign({ query: q }, deps) {
  const chainId = chainOf(q);
  const hub = q.hub ? addressOf(q.hub, 'hub') : activeHub(chainId).address;
  if (q.id == null || !/^\d+$/.test(String(q.id))) fail('Bad id');
  const find = () => deps.db.query(`${CAMPAIGN_SELECT} where c.chain_id = $1 and c.hub = $2 and c.campaign_id = $3`, [chainId, hub, String(q.id)]);
  let [row] = await find();
  if (!row) fail('Campaign not found (it may not be indexed yet)', 404);
  await ensureTokenMeta(deps, chainId, [row.target, row.reward_token]);
  [row] = await find();
  const [stats] = await deps.db.query(
    `select (select count(*)::int from allocations where campaign_pk = $1) as wallets,
            (select count(*)::int from claims where campaign_pk = $1) as claims`,
    [row.pk]
  );
  const [job] = await deps.db.query('select status, step, error, updated_at from snapshot_jobs where campaign_pk = $1', [row.pk]);
  const out = {
    campaign: campaignView(row, deps.now()),
    stats,
    snapshot: job ? { status: job.status, step: job.step, error: job.status === 'rejected' ? job.error : null, updatedAt: iso(job.updated_at) } : null,
  };
  if (q.address) {
    const account = addressOf(q.address);
    const [a] = await deps.db.query('select amount::text as amount, balance::text as balance, capped, leaf_index from allocations where campaign_pk = $1 and account = $2', [row.pk, account]);
    const [cl] = await deps.db.query('select amount::text as amount, tx from claims where campaign_pk = $1 and account = $2', [row.pk, account]);
    out.you = a
      ? { eligible: true, amount: a.amount, balance: a.balance, capped: a.capped, proof: await proofFromDb(deps.db, row.pk, a.leaf_index), claimed: Boolean(cl), claimTx: cl?.tx ?? null }
      : { eligible: false };
  }
  return reply(200, out, 'public, max-age=10');
}

// ─────────────────────────────── claims ───────────────────────────────

async function getClaims({ query: q }, deps) {
  const chainId = chainOf(q);
  const account = addressOf(q.address);
  const now = deps.now();
  const rows = await deps.db.query(
    `${CAMPAIGN_SELECT.replace('select c.*,', 'select c.*, a.amount::text as alloc, a.leaf_index, cl.tx as claim_tx, cl.amount::text as claimed_amount,')}
     join allocations a on a.campaign_pk = c.pk and a.account = $2
     left join claims cl on cl.campaign_pk = c.pk and cl.account = $2
     where c.chain_id = $1 order by c.claim_end asc nulls last`,
    [chainId, account]
  );
  await ensureTokenMeta(deps, chainId, rows.flatMap((r) => [r.target, r.reward_token]));

  // The database can lag the chain: check isClaimed on-chain for everything it thinks is still open.
  const open = rows.filter((r) => !r.claim_tx && campaignStatus(r, now) === 'live');
  const onchain = open.length
    ? await retry(() =>
        deps.client(chainId).multicall({
          contracts: open.map((r) => ({ address: r.hub, abi: PLACE_HUB_ABI, functionName: 'isClaimed', args: [BigInt(r.campaign_id), account] })),
          allowFailure: false,
        })
      )
    : [];
  const claimedOnchain = new Set(open.filter((_, i) => onchain[i]).map((r) => String(r.pk)));

  const claimable = [];
  const claimed = [];
  const expired = [];
  for (const r of rows) {
    const view = { ...campaignView(r, now), amount: r.alloc };
    if (r.claim_tx || claimedOnchain.has(String(r.pk))) claimed.push({ ...view, claimTx: r.claim_tx || null });
    else if (campaignStatus(r, now) === 'live') claimable.push({ ...view, proof: await proofFromDb(deps.db, r.pk, r.leaf_index) });
    else expired.push(view);
  }

  // One claimMany per hub ("Claim all"); anyone may send it, the reward always goes to `account`.
  const byHub = new Map();
  for (const c of claimable) {
    if (!byHub.has(c.hub)) byHub.set(c.hub, []);
    byHub.get(c.hub).push(c);
  }
  const transactions = [...byHub].map(([hub, list]) => ({
    to: hub,
    value: '0',
    campaigns: list.map((c) => c.id),
    data: encodeFunctionData({
      abi: PLACE_HUB_ABI,
      functionName: 'claimMany',
      args: [account, list.map((c) => BigInt(c.id)), list.map((c) => BigInt(c.amount)), list.map((c) => c.proof)],
    }),
  }));
  return reply(200, { chainId, account, claimable, claimed, expired, transactions });
}

// ─────────────────────────────── assets ───────────────────────────────

async function getToken({ query: q }, deps) {
  const chainId = chainOf(q);
  const address = addressOf(q.address);
  await ensureTokenMeta(deps, chainId, [address]);
  const [meta] = await deps.db.query('select name, symbol, decimals, is_nft from token_meta where chain_id = $1 and address = $2', [chainId, address]);
  const [hidden] = await deps.db.query('select reason from hidden_assets where chain_id = $1 and address = $2', [chainId, address]);
  const [collection] = await deps.db.query('select creator, created_at, created_tx from nft_collections where chain_id = $1 and address = $2', [chainId, address]);
  const [launched] = await deps.db.query(
    'select kind, quote, pool_id, vault, current_creator, original_creator, created_at, created_tx, price from launch_tokens where chain_id = $1 and token = $2',
    [chainId, address]
  );
  const now = deps.now();
  const rows = await deps.db.query(`${CAMPAIGN_SELECT} where c.chain_id = $1 and c.target = $2 and not c.hidden order by c.created_at desc limit 200`, [chainId, address]);
  await ensureTokenMeta(deps, chainId, rows.map((r) => r.reward_token));
  const campaigns = (rows.length ? await deps.db.query(`${CAMPAIGN_SELECT} where c.chain_id = $1 and c.target = $2 and not c.hidden order by c.created_at desc limit 200`, [chainId, address]) : []).map((r) =>
    campaignView(r, now)
  );
  return reply(
    200,
    {
      chainId,
      address,
      name: meta?.name ?? null,
      symbol: meta?.symbol ?? null,
      decimals: meta?.decimals ?? null,
      kind: meta?.is_nft ? 'nft' : 'token',
      hidden: Boolean(hidden),
      placeCollection: collection ? { creator: collection.creator, createdAt: iso(collection.created_at), createdTx: collection.created_tx } : null,
      // Launched on Place Launch: the token page is /api/place/launch/token?address=…
      placeLaunch: launched
        ? {
            kind: launched.kind,
            quote: launched.quote === ETH ? 'eth' : launched.quote,
            poolId: launched.pool_id,
            vault: launched.vault,
            creator: launched.current_creator,
            originalCreator: launched.original_creator,
            price: launched.price == null ? null : Number(launched.price),
            createdAt: iso(launched.created_at),
            createdTx: launched.created_tx,
          }
        : null,
      campaigns,
    },
    'public, max-age=30'
  );
}

async function listCollections({ query: q }, deps) {
  const chainId = chainOf(q);
  const { limit, offset } = limits(q);
  const params = [chainId];
  let where = 'c.chain_id = $1 and not c.hidden';
  if (q.creator) {
    params.push(addressOf(q.creator, 'creator'));
    where += ` and c.creator = $${params.length}`;
  }
  const rows = await deps.db.query(
    `select c.*, tm.name, tm.symbol from nft_collections c left join token_meta tm on tm.chain_id = c.chain_id and tm.address = c.address
     where ${where} order by c.created_at desc limit ${limit + 1} offset ${offset}`,
    params
  );
  const page = rows.slice(0, limit);
  await ensureTokenMeta(deps, chainId, page.filter((r) => r.name == null).map((r) => r.address));
  const metas = new Map(
    (await deps.db.query('select address, name, symbol from token_meta where chain_id = $1 and address = any($2::text[])', [chainId, page.map((r) => r.address)])).map((m) => [m.address, m])
  );
  return reply(
    200,
    {
      collections: page.map((r) => ({
        chainId,
        address: r.address,
        name: metas.get(r.address)?.name ?? null,
        symbol: metas.get(r.address)?.symbol ?? null,
        creator: r.creator,
        implementation: r.implementation,
        createdAt: iso(r.created_at),
        createdTx: r.created_tx,
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    },
    'public, max-age=30'
  );
}

/**
 * Who holds the asset right now, for the Create form: the creator sees the top holders, which ones are
 * contracts, and which ones Place excludes on its own, and picks what else to exclude.
 * Big tokens are cut off after `maxPages` pages of transfers: the answer then says partial.
 */
async function holdersPreview({ query: q }, deps) {
  const chainId = chainOf(q);
  const target = addressOf(q.target, 'target');
  const nft = q.kind === 'nft-holders';
  const min = q.min ? BigInt(q.min) : 1n;
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
  const client = deps.client(chainId);
  const block = await client.getBlock({ blockTag: 'latest' });
  const into = { receivers: new Set(), tokenIds: new Set() };
  let pageKey = null;
  let pages = 0;
  const maxPages = deps.previewMaxPages ?? 20;
  do {
    const p = await transfersPage({ chainId, key: deps.alchemyKey, contract: target, category: nft ? 'erc721' : 'erc20', toBlock: block.number, pageKey, fetchFn: deps.fetchFn });
    p.receivers.forEach((r) => into.receivers.add(r));
    p.tokenIds.forEach((t) => into.tokenIds.add(t));
    pageKey = p.pageKey;
    pages++;
  } while (pageKey && pages < maxPages);
  const balances = nft
    ? await nftHoldingsAt(client, target, into.tokenIds, block.number)
    : await erc20BalancesAt(client, target, [...into.receivers].filter((a) => a !== ETH), block.number);
  const over = balances.filter((b) => b.balance >= min && b.balance > 0n).sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
  const top = over.slice(0, limit);
  const excluded = await autoExclusions(client, { chainId, hub: activeHub(chainId).address, holders: top.map((h) => h.account), blockNumber: block.number });
  const codes = await Promise.all(top.map((h) => retry(() => client.getCode({ address: h.account }))));
  return reply(200, {
    chainId,
    target,
    kind: nft ? 'nft-holders' : 'token-holders',
    block: block.number.toString(),
    partial: Boolean(pageKey),
    holders: over.length,
    top: top.map((h, i) => ({
      account: h.account,
      balance: h.balance.toString(),
      // EIP-7702 accounts carry a 0xef0100 delegation but belong to a person.
      type: !codes[i] || codes[i] === '0x' ? 'wallet' : codes[i].startsWith('0xef0100') ? 'smart-account' : 'contract',
      autoExcluded: excluded.has(h.account),
    })),
  });
}

// ─────────────────────────────── writes ───────────────────────────────

async function pin(req, deps) {
  const b = req.body || {};
  const ip = String(req.ip || 'unknown');
  const [{ n }] = await deps.db.query(`select count(*)::int as n from pin_log where ip = $1 and created_at > now() - interval '1 hour'`, [ip]);
  if (n >= PIN_LIMIT_PER_HOUR) fail('Too many uploads, try again later', 429);

  let bytes;
  let contentType = 'application/json';
  let extra = {};
  if (b.kind === 'rules') {
    const rules = typeof b.content === 'string' ? JSON.parse(b.content) : b.content;
    try {
      validateRules(rules);
    } catch (e) {
      fail(e.message);
    }
    const d = DEPLOYMENTS[rules.chainId];
    if (!d || !d.hubs.some((h) => h.address === rules.hub)) fail('Rules point to an unknown hub');
    const { json, rulesHash } = encodeRules(rules);
    bytes = json;
    extra = { rulesHash };
  } else if (b.kind === 'metadata') {
    const m = typeof b.content === 'string' ? JSON.parse(b.content) : b.content;
    if (!m || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) fail('metadata.name must be 1–80 characters');
    if (m.description != null && (typeof m.description !== 'string' || m.description.length > 2000)) fail('metadata.description is too long');
    if (m.image != null && !/^ipfs:\/\/[A-Za-z0-9]+$/.test(m.image)) fail('metadata.image must be an ipfs:// URI');
    const clean = { name: m.name.trim(), description: m.description ?? null, image: m.image ?? null };
    bytes = canonicalJson(clean);
    if (bytes.length > MAX_METADATA_BYTES) fail('metadata is too big');
  } else if (b.kind === 'image') {
    if (!IMAGE_TYPES.includes(b.contentType)) fail(`contentType must be one of ${IMAGE_TYPES.join(', ')}`);
    bytes = Buffer.from(String(b.data || ''), 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail(`image must be 1 byte to ${MAX_IMAGE_BYTES / 1024} KB`);
    contentType = b.contentType;
  } else if (b.kind === 'folder') {
    if (!Array.isArray(b.files) || !b.files.length || b.files.length > MAX_FOLDER_FILES) fail(`files must list 1 to ${MAX_FOLDER_FILES} files`);
    const files = b.files.map(folderFile);
    if (new Set(files.map((f) => f.name)).size !== files.length) fail('File names must be unique');
    if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_FOLDER_BYTES) fail('The folder is too big for one upload: send fewer files at a time');
    if (!deps.pinFolder) fail('Folder uploads are not available here', 503);
    const uri = await deps.pinFolder(files, { name: `place-folder-${Date.now()}` });
    await deps.db.query('insert into pin_log (ip, kind, uri) values ($1, $2, $3)', [ip, b.kind, uri]);
    return reply(200, { uri, files: files.length });
  } else {
    fail('kind must be rules, metadata, image or folder');
  }
  const uri = await deps.pin(bytes, { name: `place-${b.kind}-${Date.now()}`, contentType });
  await deps.db.query('insert into pin_log (ip, kind, uri) values ($1, $2, $3)', [ip, b.kind, uri]);
  return reply(200, { uri, ...extra });
}

async function moderate(req, deps) {
  const b = req.body || {};
  const chainId = chainOf({ chain: b.chainId });
  const admin = addressOf(b.admin, 'admin');
  const admins = (process.env.PLACE_ADMINS ? process.env.PLACE_ADMINS.split(',') : DEFAULT_ADMINS).map((a) => a.trim().toLowerCase());
  if (!admins.includes(admin)) fail('This wallet is not a Place admin', 403);
  const review = b.type === 'registration';
  if (!(review ? ['verify', 'reject'] : ['hide', 'unhide']).includes(b.action)) fail(review ? 'action must be verify or reject' : 'action must be hide or unhide');
  if (!['campaign', 'asset', 'collection', 'registration'].includes(b.type)) fail('type must be campaign, asset, collection or registration');
  const issued = Date.parse(b.issuedAt);
  if (Number.isNaN(issued) || Math.abs(deps.now() * 1000 - issued) > SIGNATURE_MAX_AGE_MS) fail('Signature expired, sign again', 401);
  const message = moderationMessage({ admin, chainId, action: b.action, type: b.type, target: b.target, issuedAt: b.issuedAt });
  const valid = await deps
    .client(chainId)
    .verifyMessage({ address: admin, message, signature: b.signature })
    .catch(() => false);
  if (!valid) fail('Signature check failed', 401);

  if (review) {
    const status = await reviewRegistration(deps, chainId, addressOf(b.target, 'target'), b.action);
    return reply(200, { ok: true, action: b.action, type: b.type, target: String(b.target).toLowerCase(), status });
  }
  const hide = b.action === 'hide';
  if (b.type === 'campaign') {
    const [hub, id] = String(b.target).toLowerCase().split(':');
    const r = await deps.db.query('update campaigns set hidden = $4, updated_at = now() where chain_id = $1 and hub = $2 and campaign_id = $3 returning pk', [chainId, addressOf(hub, 'hub'), id, hide]);
    if (!r.length) fail('Campaign not found', 404);
  } else if (b.type === 'collection') {
    const r = await deps.db.query('update nft_collections set hidden = $3 where chain_id = $1 and address = $2 returning address', [chainId, addressOf(b.target, 'target'), hide]);
    if (!r.length) fail('Collection not found', 404);
  } else if (hide) {
    await deps.db.query('insert into hidden_assets (chain_id, address, reason) values ($1, $2, $3) on conflict (chain_id, address) do update set reason = excluded.reason', [
      chainId,
      addressOf(b.target, 'target'),
      b.reason ? String(b.reason).slice(0, 300) : null,
    ]);
  } else {
    await deps.db.query('delete from hidden_assets where chain_id = $1 and address = $2', [chainId, addressOf(b.target, 'target')]);
  }
  return reply(200, { ok: true, action: b.action, type: b.type, target: String(b.target).toLowerCase() });
}
