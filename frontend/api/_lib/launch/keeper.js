// The Place keeper: permissionless daily calls that keep the launch economies moving.
//
// 0.3.0 (PlaceRewardsDistributor, PlaceCommunityVault):
//   closeStreams(ids)        once a day per distributor, for every stream with a finished UTC day: takes the day's
//                            holder / trader tax from FeeEscrow, converts it into the reward token, funds the day
//                            (EpochClosed); the publisher then builds the day's tables and roots
//   convert(id, maxIn)       for streams whose conversion was deferred (price impact cap): the whole pending input,
//                            or a quarter of it when the whole does not fit
//   startDefaultCampaign()   on a community vault whose fund was not spent for defaultCampaignDelay (30 days) and
//                            holds at least the frozen minimum
//   FeeEscrow.burn(token) is left to the users ("Burn tokens" on the token page).
// 0.2.0 creator vaults (legacy, still live): process() when due and startDefaultCampaign() after 30 days.
//
// The keeper wallet (env PLACE_KEEPER_PRIVATE_KEY, a hot wallet with a little ETH for gas, separate from the
// publisher) can only pay gas. Every call is dry-run first; a call whose gas estimate is above the cap is skipped.
// Each attempt is written to keeper_runs (GET launch/keeper shows the log). Runs inside the Place cron tick: the
// daily cadence comes from keeper_runs, not from the schedule.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COMMUNITY_VAULT_ABI, REWARDS_DISTRIBUTOR_ABI } from '../../../src/launch/abi.js';
import { V020_CREATOR_VAULT_ABI } from '../../../src/launch/abi.legacy.js';
import { launchDeployment, deployedReleases } from '../../../src/launch/deployments.js';
import { DATA_SUFFIX } from '../../../src/config/builderCode.js';
import { NETWORKS, alchemyUrl, retry } from '../place/chain.js';
import { reply, chainOf, iso } from '../place/http.js';
import { revertReason } from './economy.js';
import { releaseGeneration, EPOCH } from './indexer.js';

const ETH = '0x0000000000000000000000000000000000000000';
const MIN_BURN_AMOUNT = 1_000n; // 0.2.0 PlaceCreatorVault.MIN_BURN_AMOUNT: smaller reserves are carried over
const READS_V2 = ['nextProcessAt', 'pendingFees', 'burnReserve', 'burnBps', 'communityBps', 'lastFundSpendAt', 'settings', 'quote'];
const READS_COMMUNITY = ['pendingFees', 'lastFundSpendAt', 'settings', 'quote'];
const CLOSE_BATCH = 40; // stream ids per closeStreams call

export function keeperConfig(env = process.env) {
  return {
    privateKey: env.PLACE_KEEPER_PRIVATE_KEY || null,
    intervalS: Number(env.PLACE_KEEPER_INTERVAL_S || 86_400), // once a day per vault and action
    maxGas: BigInt(env.PLACE_KEEPER_MAX_GAS || 800_000), // per call (closeStreams: per stream in the batch)
    maxCalls: Number(env.PLACE_KEEPER_MAX_CALLS || 20), // per tick
  };
}

/** A wallet that sends one contract call ({address, abi, functionName, args}) and waits for it. Tests pass their own. */
export function makeKeeperWallet({ chainId, alchemyKey, privateKey, readClient }) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: NETWORKS[Number(chainId)].chain, transport: http(alchemyUrl(chainId, alchemyKey), { timeout: 30_000 }), dataSuffix: DATA_SUFFIX });
  return {
    address: account.address.toLowerCase(),
    async estimate(call) {
      return readClient.estimateContractGas({ ...call, account });
    },
    async send(call, gas) {
      const hash = await wallet.writeContract({ ...call, gas });
      const receipt = await readClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      return { hash, status: receipt.status, gasUsed: receipt.gasUsed };
    },
  };
}

async function logRun(db, row) {
  await db.query(
    'insert into keeper_runs (chain_id, at, vault, token, action, status, tx, gas_used, detail) values ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9)',
    [row.chainId, row.now, row.vault, row.token ?? null, row.action, row.status, row.tx ?? null, row.gasUsed?.toString() ?? null, row.detail ?? null]
  );
}

const lastRuns = async (db, chainId, action) =>
  new Map(
    (
      await db.query(
        `select vault, max(at) as at from keeper_runs where chain_id = $1 and action = $2 and status in ('success', 'nothing') group by vault`,
        [chainId, action]
      )
    ).map((r) => [r.vault, r.at])
  );

/**
 * One keeper pass over the chain. Returns what it did, per contract and action.
 * deps: { db, client (reads), wallet (makeKeeperWallet or a test double), now (unix s), config }
 */
export async function runKeeper({ db, client, wallet, chainId, now, config = keeperConfig(), budgetMs = 60_000 }) {
  const d = launchDeployment(chainId);
  if (!d) return { skipped: 'no launch deployment' };
  if (!wallet) return { skipped: 'PLACE_KEEPER_PRIVATE_KEY is not set' };
  const started = Date.now();
  const done = [];
  const state = { calls: 0 };
  const due = (last, interval = config.intervalS) => !last || now - new Date(last).getTime() / 1000 >= interval;
  const outOfTime = () => Date.now() - started > budgetMs || state.calls >= config.maxCalls;

  /** Dry run, gas cap, send, log. `gasCap` defaults to config.maxGas. */
  async function attempt(row, call, gasCap = config.maxGas) {
    if (state.calls >= config.maxCalls) return null;
    let gas;
    try {
      gas = await wallet.estimate(call);
    } catch (e) {
      const detail = revertReason(e);
      await logRun(db, { ...row, status: 'reverted-dry-run', detail });
      done.push({ ...row, status: 'reverted-dry-run', detail });
      return { status: 'reverted-dry-run', detail };
    }
    if (gas > gasCap) {
      const detail = `gas estimate ${gas} above the cap ${gasCap}`;
      await logRun(db, { ...row, status: 'skipped-gas', detail });
      done.push({ ...row, status: 'skipped-gas', detail });
      return { status: 'skipped-gas' };
    }
    state.calls++;
    try {
      const r = await wallet.send(call, (gas * 12n) / 10n);
      const status = r.status === 'success' ? 'success' : 'reverted';
      await logRun(db, { ...row, status, tx: r.hash, gasUsed: r.gasUsed, detail: row.detail ?? `gas estimate ${gas}` });
      done.push({ ...row, status, tx: r.hash, gasUsed: r.gasUsed?.toString() });
      return { status };
    } catch (e) {
      const detail = revertReason(e);
      await logRun(db, { ...row, status: 'error', detail });
      done.push({ ...row, status: 'error', detail });
      return { status: 'error', detail };
    }
  }
  async function nothing(row, detail) {
    await logRun(db, { ...row, status: 'nothing', detail });
    done.push({ ...row, status: 'nothing', detail });
  }

  // ── 0.3.0: close yesterday's epochs of every stream, one batch per distributor
  const current = Math.floor(now / EPOCH);
  const lastClose = await lastRuns(db, chainId, 'close_streams');
  const distributors = deployedReleases(chainId).filter((r) => releaseGeneration(r.version) >= 3 && r.rewardsDistributor);
  for (const r of distributors) {
    if (outOfTime()) break;
    if (!due(lastClose.get(r.rewardsDistributor), config.intervalS - 3_600)) continue; // a little slack so the daily run does not drift later
    const open = await db.query(
      `select stream_id from reward_streams where chain_id = $1 and distributor = $2 and start_epoch <= $3
         and coalesce(last_closed_epoch, start_epoch - 1) < least($3, case when epoch_count > 0 then start_epoch + epoch_count - 1 else $3 end)
       order by created_block`,
      [chainId, r.rewardsDistributor, current - 1]
    );
    const row = { chainId, now, vault: r.rewardsDistributor, token: null, action: 'close_streams' };
    if (!open.length) {
      await nothing(row, 'no stream has a finished day to close');
      continue;
    }
    for (let i = 0; i < open.length && !outOfTime(); i += CLOSE_BATCH) {
      const ids = open.slice(i, i + CLOSE_BATCH).map((s) => s.stream_id);
      await attempt({ ...row, detail: `${ids.length} streams` }, { address: r.rewardsDistributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'closeStreams', args: [ids] }, config.maxGas * BigInt(ids.length));
    }
  }

  // ── 0.3.0: deferred conversions (pair asset still waiting to become the reward token)
  if (distributors.length && !outOfTime()) {
    const lastConvert = await lastRuns(db, chainId, 'convert');
    const pending = await db.query(
      `select s.stream_id, s.distributor, s.token,
              ((select coalesce(sum(e.collected), 0) from reward_epochs e where e.chain_id = s.chain_id and e.stream_id = s.stream_id)
               - (select coalesce(sum(x.amount), 0) from reward_stream_events x where x.chain_id = s.chain_id and x.stream_id = s.stream_id and x.kind = 'converted'))::text as pending
       from reward_streams s where s.chain_id = $1 and s.economy and s.reward_token <> s.source and s.distributor = any($2::text[])`,
      [chainId, distributors.map((r) => r.rewardsDistributor)]
    );
    for (const s of pending) {
      if (outOfTime()) break;
      const amount = BigInt(s.pending);
      if (amount <= 0n || !due(lastConvert.get(s.stream_id))) continue;
      const row = { chainId, now, vault: s.stream_id, token: s.token, action: 'convert' };
      const call = (maxIn) => ({ address: s.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'convert', args: [s.stream_id, maxIn] });
      const all = await attempt({ ...row, detail: `all ${amount}` }, call(0n));
      // Too much price impact at once: a quarter now, the rest on the next days.
      if (all?.status === 'reverted-dry-run' && /PriceImpactTooHigh/.test(all.detail || '')) await attempt({ ...row, detail: `a quarter ${amount / 4n}` }, call(amount / 4n));
    }
  }

  // ── 0.3.0: default campaigns of community vaults
  const communities = await db.query(
    `select e.token, e.community_vault as vault, e.version from launch_economy e where e.chain_id = $1 and e.community_vault is not null order by e.updated_block`,
    [chainId]
  );
  const lastDefault = await lastRuns(db, chainId, 'default_campaign');
  for (const v of communities) {
    if (outOfTime()) break;
    if (releaseGeneration(v.version) < 3 || !due(lastDefault.get(v.vault))) continue;
    const row = { chainId, now, vault: v.vault, token: v.token, action: 'default_campaign' };
    let s;
    try {
      const res = await retry(() => client.multicall({ contracts: READS_COMMUNITY.map((functionName) => ({ address: v.vault, abi: COMMUNITY_VAULT_ABI, functionName })), allowFailure: false }));
      s = Object.fromEntries(READS_COMMUNITY.map((k, i) => [k, res[i]]));
      s.fund = await retry(() => client.readContract({ address: v.vault, abi: COMMUNITY_VAULT_ABI, functionName: 'fundBalance', args: [s.quote] }));
    } catch (e) {
      done.push({ vault: v.vault, action: 'read', status: 'error', detail: e.shortMessage || e.message });
      continue;
    }
    const nextAt = Number(s.lastFundSpendAt) + Number(s.settings.defaultCampaignDelay);
    const minimum = BigInt(s.settings.defaultCampaignMinimum || 0n) || 1n;
    const fund = s.fund + s.pendingFees;
    if (nextAt > now) await nothing(row, `fund spent recently, default campaign from ${iso(nextAt * 1000)}`);
    else if (fund < minimum) await nothing(row, `fund ${fund} below the minimum ${minimum}`);
    else await attempt(row, { address: v.vault, abi: COMMUNITY_VAULT_ABI, functionName: 'startDefaultCampaign', args: [] });
  }

  // ── 0.2.0 creator vaults: process() and default campaigns
  const v2versions = deployedReleases(chainId).filter((r) => releaseGeneration(r.version) === 2).map((r) => r.version);
  const vaults = v2versions.length
    ? await db.query(
        `select t.token, t.vault, t.symbol, l.max_burn_per_process::text as max_burn,
           (select max(at) from keeper_runs k where k.chain_id = t.chain_id and k.vault = t.vault and k.action = 'process' and k.status in ('success', 'nothing')) as last_process,
           (select max(at) from keeper_runs k where k.chain_id = t.chain_id and k.vault = t.vault and k.action = 'default_campaign' and k.status in ('success', 'nothing')) as last_default
         from launch_tokens t join launch_economy e on e.chain_id = t.chain_id and e.token = t.token
         left join launch_quote_limits l on l.chain_id = t.chain_id and l.quote = t.quote
         where t.chain_id = $1 and e.version = any($2::text[]) and t.vault is not null order by t.created_at`,
        [chainId, v2versions]
      )
    : [];
  for (const v of vaults) {
    if (outOfTime()) break;
    const wantProcess = due(v.last_process);
    const wantDefault = due(v.last_default);
    if (!wantProcess && !wantDefault) continue;
    let s;
    try {
      const res = await retry(() => client.multicall({ contracts: READS_V2.map((functionName) => ({ address: v.vault, abi: V020_CREATOR_VAULT_ABI, functionName })), allowFailure: false }));
      s = Object.fromEntries(READS_V2.map((k, i) => [k, res[i]]));
      s.fund = await retry(() => client.readContract({ address: v.vault, abi: V020_CREATOR_VAULT_ABI, functionName: 'fundBalance', args: [s.quote] }));
    } catch (e) {
      done.push({ vault: v.vault, action: 'read', status: 'error', detail: e.shortMessage || e.message });
      continue;
    }
    const call = (functionName) => ({ address: v.vault, abi: V020_CREATOR_VAULT_ABI, functionName, args: [] });
    const row = { chainId, now, vault: v.vault, token: v.token };
    if (wantProcess) {
      // Worth a transaction: something to burn now, or fees to book into the baskets.
      const cap = BigInt(v.max_burn || 0);
      const threshold = cap / 100n > MIN_BURN_AMOUNT ? cap / 100n : MIN_BURN_AMOUNT;
      const work = s.burnReserve + (s.pendingFees * BigInt(s.burnBps)) / 10_000n;
      if (Number(s.nextProcessAt) > now) await nothing({ ...row, action: 'process' }, `next process at ${iso(Number(s.nextProcessAt) * 1000)}`);
      else if (work < threshold && s.pendingFees < threshold) await nothing({ ...row, action: 'process' }, `below threshold (${work} < ${threshold})`);
      else await attempt({ ...row, action: 'process' }, call('process'));
    }
    if (wantDefault && !outOfTime()) {
      const nextAt = Number(s.lastFundSpendAt) + Number(s.settings.defaultCampaignDelay);
      const minimum = s.settings.defaultCampaignMinimum || 1n;
      const fund = s.fund + (s.pendingFees * BigInt(s.communityBps)) / 10_000n;
      if (s.settings.hub === ETH) await nothing({ ...row, action: 'default_campaign' }, 'no community fund');
      else if (nextAt > now) await nothing({ ...row, action: 'default_campaign' }, `fund spent recently, default campaign from ${iso(nextAt * 1000)}`);
      else if (fund < minimum) await nothing({ ...row, action: 'default_campaign' }, `fund ${fund} below the minimum ${minimum}`);
      else await attempt({ ...row, action: 'default_campaign' }, call('startDefaultCampaign'));
    }
  }
  return { vaults: vaults.length, communities: communities.length, distributors: distributors.length, calls: state.calls, done, keeper: wallet.address };
}

/** GET launch/keeper ?chain[&vault&limit] — the keeper's public log. */
async function keeperLog({ query: q }, deps) {
  const chainId = chainOf(q);
  const params = [chainId];
  let where = 'chain_id = $1';
  if (q.vault) {
    params.push(String(q.vault).toLowerCase());
    where += ` and vault = $${params.length}`;
  }
  const limit = Math.min(Number(q.limit) || 50, 200);
  const rows = await deps.db.query(
    `select at, vault, token, action, status, tx, gas_used::text as gas_used, detail from keeper_runs where ${where} order by at desc, id desc limit ${limit}`,
    params
  );
  return reply(200, { chainId, runs: rows.map((r) => ({ at: iso(r.at), vault: r.vault, token: r.token, action: r.action, status: r.status, tx: r.tx, gasUsed: r.gas_used, detail: r.detail })) }, 'public, max-age=30');
}

export const KEEPER_ROUTES = { 'GET launch/keeper': keeperLog };
