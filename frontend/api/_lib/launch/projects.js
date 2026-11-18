// Register token: an external token becomes a project on Place without a new contract.
//
//   GET  launch/projects/check     ?chain&token[&account]   what the API sees: the token, whether it is already a Place
//                                                          token, who controls it (owner() / admin()), its liquidity
//   POST launch/projects/register  {chainId, token, account, issuedAt, signature}   the creator signs registerMessage()
//   GET  launch/projects           ?chain[&token&creator&status]   registered projects
//
// Status: verified when the signer is the token's owner() or admin() and the token has at least
// MIN_PROJECT_LIQUIDITY_USD of liquidity; review otherwise (Place checks by hand, admins verify or reject through
// POST moderate). A verified project gets a project page; collections and campaigns can be made for any token anyway.
// Swap routes for a new token (needed for NFT collections and reward tokens) are added by a Place admin on chain.
import { parseAbi } from 'viem';
import { reply, fail, chainOf, addressOf, iso } from '../place/http.js';
import { retry } from '../place/chain.js';
import { ensureTokenMeta } from '../place/tokenMeta.js';
import { registerMessage, REGISTER_SIGNATURE_MAX_AGE_MS, MIN_PROJECT_LIQUIDITY_USD } from '../../../src/launch/projects.js';

const ETH = '0x0000000000000000000000000000000000000000';
const RIGHTS_ABI = parseAbi(['function owner() view returns (address)', 'function admin() view returns (address)']);
// GeckoTerminal indexes Base mainnet pools; testnet liquidity cannot be measured, so testnet registrations go to review.
const GECKO_NETWORK = { 8453: 'base' };
const GECKO_TOKEN = 'https://api.geckoterminal.com/api/v2/networks';
const lower = (a) => (a == null ? a : String(a).toLowerCase());

/** owner() and admin() of a token (null where it has none). */
export async function tokenRights(client, token) {
  const read = async (functionName) => {
    try {
      const a = lower(await retry(() => client.readContract({ address: token, abi: RIGHTS_ABI, functionName }), 2));
      return a && a !== ETH ? a : null;
    } catch {
      return null;
    }
  };
  const [owner, admin] = await Promise.all([read('owner'), read('admin')]);
  return { owner, admin };
}

/** Total liquidity of a token's pools in USD (GeckoTerminal), or null when it cannot be measured. */
export async function tokenLiquidityUsd(fetchFn, chainId, token) {
  const net = GECKO_NETWORK[Number(chainId)];
  if (!net || !fetchFn) return null;
  try {
    const res = await fetchFn(`${GECKO_TOKEN}/${net}/tokens/${token}`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!res.ok) return res.status === 404 ? 0 : null;
    const body = await res.json();
    const v = Number(body?.data?.attributes?.total_reserve_in_usd);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Decides the method and status of a registration. */
export function decideRegistration({ account, rights, liquidityUsd }) {
  const method = rights.owner === account ? 'owner' : rights.admin === account ? 'admin' : 'manual';
  const notes = [];
  if (method === 'manual') notes.push('This wallet is not the owner() or admin() of the token, so the Place team checks it by hand');
  if (liquidityUsd == null) notes.push('Liquidity could not be measured on this network, so the Place team checks it by hand');
  else if (liquidityUsd < MIN_PROJECT_LIQUIDITY_USD) notes.push(`Liquidity is below $${MIN_PROJECT_LIQUIDITY_USD.toLocaleString('en-US')}`);
  const low = liquidityUsd != null && liquidityUsd < MIN_PROJECT_LIQUIDITY_USD;
  const status = method !== 'manual' && liquidityUsd != null && !low ? 'verified' : 'review';
  return { method, status, low, note: notes.join('. ') || null };
}

function registrationView(r) {
  if (!r) return null;
  return {
    token: r.token,
    creator: r.creator,
    method: r.method,
    status: r.status,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals == null ? null : Number(r.decimals),
    liquidityUsd: r.liquidity_usd == null ? null : Number(r.liquidity_usd),
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function inspect(deps, chainId, token, account) {
  await ensureTokenMeta(deps, chainId, [token]);
  const [[meta], [place], [reg]] = await Promise.all([
    deps.db.query('select name, symbol, decimals, is_nft from token_meta where chain_id = $1 and address = $2', [chainId, token]),
    deps.db.query('select token, current_creator from launch_tokens where chain_id = $1 and token = $2', [chainId, token]),
    deps.db.query('select * from project_registrations where chain_id = $1 and token = $2', [chainId, token]),
  ]);
  const client = deps.client(chainId);
  const [rights, liquidityUsd] = await Promise.all([tokenRights(client, token), tokenLiquidityUsd(deps.fetchFn, chainId, token)]);
  const decision = account ? decideRegistration({ account, rights, liquidityUsd }) : null;
  return {
    token: { address: token, name: meta?.name ?? null, symbol: meta?.symbol ?? null, decimals: meta?.decimals == null ? null : Number(meta.decimals), isNft: Boolean(meta?.is_nft) },
    isToken: meta?.symbol != null && !meta?.is_nft,
    placeLaunch: place ? { creator: place.current_creator } : null,
    rights,
    liquidityUsd,
    minLiquidityUsd: MIN_PROJECT_LIQUIDITY_USD,
    registration: registrationView(reg),
    decision,
  };
}

async function check({ query: q }, deps) {
  const chainId = chainOf(q);
  const token = addressOf(q.token, 'token');
  const account = q.account ? addressOf(q.account, 'account') : null;
  return reply(200, { chainId, ...(await inspect(deps, chainId, token, account)) });
}

async function register(req, deps) {
  const b = req.body || {};
  const chainId = chainOf({ chain: b.chainId });
  const token = addressOf(b.token, 'token');
  const account = addressOf(b.account, 'account');
  const issued = Date.parse(b.issuedAt);
  if (Number.isNaN(issued) || Math.abs(deps.now() * 1000 - issued) > REGISTER_SIGNATURE_MAX_AGE_MS) fail('Signature expired, sign again', 401);
  const message = registerMessage({ chainId, token, account, issuedAt: b.issuedAt });
  const valid = await deps
    .client(chainId)
    .verifyMessage({ address: account, message, signature: b.signature })
    .catch(() => false);
  if (!valid) fail('Signature check failed', 401);
  const info = await inspect(deps, chainId, token, account);
  if (!info.isToken) fail('This address is not an ERC-20 token on this network');
  if (info.placeLaunch) fail('This token was launched on Place: it is a project already', 409);
  const prev = info.registration;
  if (prev && prev.status === 'verified' && prev.creator !== account) fail('This token is registered to another wallet', 409);
  const { method, status, note } = info.decision;
  const [row] = await deps.db.query(
    `insert into project_registrations (chain_id, token, creator, method, status, name, symbol, decimals, liquidity_usd, note, signature, issued_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (chain_id, token) do update set creator = excluded.creator, method = excluded.method, status = excluded.status, name = excluded.name,
       symbol = excluded.symbol, decimals = excluded.decimals, liquidity_usd = excluded.liquidity_usd, note = excluded.note,
       signature = excluded.signature, issued_at = excluded.issued_at, updated_at = now()
     returning *`,
    [chainId, token, account, method, status, info.token.name, info.token.symbol, info.token.decimals, info.liquidityUsd, note, String(b.signature), new Date(issued).toISOString()]
  );
  return reply(200, { chainId, registration: registrationView(row) });
}

async function list({ query: q }, deps) {
  const chainId = chainOf(q);
  const where = ['chain_id = $1'];
  const args = [chainId];
  if (q.token) {
    args.push(addressOf(q.token, 'token'));
    where.push(`token = $${args.length}`);
  }
  if (q.creator) {
    args.push(addressOf(q.creator, 'creator'));
    where.push(`creator = $${args.length}`);
  }
  // Without a token or creator filter only verified projects are public.
  if (q.status === 'all' && (q.token || q.creator)) where.push("status <> 'rejected'");
  else if (!q.token && !q.creator) where.push("status = 'verified'");
  const rows = await deps.db.query(`select * from project_registrations where ${where.join(' and ')} order by created_at desc limit 200`, args);
  return reply(200, { chainId, projects: rows.map(registrationView) }, 'public, max-age=10');
}

/** Admin review of a registration (verify or reject), called from the moderation endpoint. */
export async function reviewRegistration(deps, chainId, token, action) {
  const status = action === 'verify' ? 'verified' : 'rejected';
  const r = await deps.db.query("update project_registrations set status = $3, note = case when $3 = 'verified' then null else note end, updated_at = now() where chain_id = $1 and token = $2 returning token", [chainId, token, status]);
  if (!r.length) fail('Registration not found', 404);
  return status;
}

export const PROJECT_ROUTES = {
  'GET launch/projects/check': check,
  'POST launch/projects/register': register,
  'GET launch/projects': list,
};
