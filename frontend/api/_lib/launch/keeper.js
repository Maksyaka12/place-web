// The Place keeper: once a day per 0.2.0 creator vault it calls
//   process()               when the vault's interval has passed and there is something to burn or book
//                           (pending fees + burn reserve at least a threshold), and
//   startDefaultCampaign()  when the community fund was not spent for defaultCampaignDelay (30 days) and holds at
//                           least the frozen minimum.
// Both are permissionless, so the keeper wallet (env PLACE_KEEPER_PRIVATE_KEY, a hot wallet with a little ETH for
// gas, separate from the publisher) can only pay gas. Every call is dry-run first; a call whose gas estimate is
// above the cap is skipped. Each attempt is written to keeper_runs (GET launch/keeper shows the log).
//
// Runs inside the Place cron tick (/api/place-cron, GitHub Actions every 30 min): the daily cadence comes from
// keeper_runs, not from the schedule.
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CREATOR_VAULT_ABI } from '../../../src/launch/abi.js';
import { launchDeployment } from '../../../src/launch/deployments.js';
import { DATA_SUFFIX } from '../../../src/config/builderCode.js';
import { NETWORKS, alchemyUrl, retry } from '../place/chain.js';
import { reply, chainOf, iso } from '../place/http.js';
import { revertReason } from './economy.js';

const ETH = '0x0000000000000000000000000000000000000000';
const MIN_BURN_AMOUNT = 1_000n; // PlaceCreatorVault.MIN_BURN_AMOUNT: smaller reserves are carried over
const READS = ['nextProcessAt', 'pendingFees', 'burnReserve', 'burnBps', 'communityBps', 'lastFundSpendAt', 'settings', 'quote'];

export function keeperConfig(env = process.env) {
  return {
    privateKey: env.PLACE_KEEPER_PRIVATE_KEY || null,
    intervalS: Number(env.PLACE_KEEPER_INTERVAL_S || 86_400), // once a day per vault and action
    maxGas: BigInt(env.PLACE_KEEPER_MAX_GAS || 800_000), // per call
    maxCalls: Number(env.PLACE_KEEPER_MAX_CALLS || 20), // per tick
  };
}

/** A wallet that sends one vault call and waits for it. Tests pass their own. */
export function makeKeeperWallet({ chainId, alchemyKey, privateKey, readClient }) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: NETWORKS[Number(chainId)].chain, transport: http(alchemyUrl(chainId, alchemyKey), { timeout: 30_000 }), dataSuffix: DATA_SUFFIX });
  return {
    address: account.address.toLowerCase(),
    async estimate(vault, functionName) {
      return readClient.estimateContractGas({ address: vault, abi: CREATOR_VAULT_ABI, functionName, account });
    },
    async send(vault, functionName, gas) {
      const hash = await wallet.writeContract({ address: vault, abi: CREATOR_VAULT_ABI, functionName, gas });
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

/**
 * One keeper pass over the chain's current-release vaults. Returns what it did, per vault and action.
 * deps: { db, client (reads), wallet (makeKeeperWallet or a test double), now (unix s), config }
 */
export async function runKeeper({ db, client, wallet, chainId, now, config = keeperConfig(), budgetMs = 60_000 }) {
  const d = launchDeployment(chainId);
  if (!d) return { skipped: 'no launch deployment' };
  if (!wallet) return { skipped: 'PLACE_KEEPER_PRIVATE_KEY is not set' };
  const started = Date.now();
  const vaults = await db.query(
    `select t.token, t.vault, t.symbol, l.max_burn_per_process::text as max_burn,
       (select max(at) from keeper_runs k where k.chain_id = t.chain_id and k.vault = t.vault and k.action = 'process' and k.status in ('success', 'nothing')) as last_process,
       (select max(at) from keeper_runs k where k.chain_id = t.chain_id and k.vault = t.vault and k.action = 'default_campaign' and k.status in ('success', 'nothing')) as last_default
     from launch_tokens t join launch_economy e on e.chain_id = t.chain_id and e.token = t.token
     left join launch_quote_limits l on l.chain_id = t.chain_id and l.quote = t.quote
     where t.chain_id = $1 and e.version = $2 and t.vault is not null order by t.created_at`,
    [chainId, d.version]
  );
  const done = [];
  let calls = 0;
  const due = (last) => !last || now - new Date(last).getTime() / 1000 >= config.intervalS;
  for (const v of vaults) {
    if (Date.now() - started > budgetMs || calls >= config.maxCalls) break;
    const wantProcess = due(v.last_process);
    const wantDefault = due(v.last_default);
    if (!wantProcess && !wantDefault) continue;
    let s;
    try {
      const res = await retry(() => client.multicall({ contracts: READS.map((functionName) => ({ address: v.vault, abi: CREATOR_VAULT_ABI, functionName })), allowFailure: false }));
      s = Object.fromEntries(READS.map((k, i) => [k, res[i]]));
      s.fund = await retry(() => client.readContract({ address: v.vault, abi: CREATOR_VAULT_ABI, functionName: 'fundBalance', args: [s.quote] }));
    } catch (e) {
      done.push({ vault: v.vault, action: 'read', status: 'error', detail: e.shortMessage || e.message });
      continue;
    }
    const jobs = [];
    if (wantProcess) {
      // Worth a transaction: something to burn now, or fees to book into the baskets.
      const cap = BigInt(v.max_burn || 0);
      const threshold = cap / 100n > MIN_BURN_AMOUNT ? cap / 100n : MIN_BURN_AMOUNT;
      const work = s.burnReserve + (s.pendingFees * BigInt(s.burnBps)) / 10_000n;
      if (Number(s.nextProcessAt) > now) jobs.push({ action: 'process', skip: 'nothing', detail: `next process at ${iso(Number(s.nextProcessAt) * 1000)}` });
      else if (work < threshold && s.pendingFees < threshold) jobs.push({ action: 'process', skip: 'nothing', detail: `below threshold (${work} < ${threshold})` });
      else jobs.push({ action: 'process', fn: 'process' });
    }
    if (wantDefault) {
      const nextAt = Number(s.lastFundSpendAt) + Number(s.settings.defaultCampaignDelay);
      const minimum = s.settings.defaultCampaignMinimum || 1n;
      const fund = s.fund + (s.pendingFees * BigInt(s.communityBps)) / 10_000n;
      if (s.settings.hub === ETH) jobs.push({ action: 'default_campaign', skip: 'nothing', detail: 'no community fund' });
      else if (nextAt > now) jobs.push({ action: 'default_campaign', skip: 'nothing', detail: `fund spent recently, default campaign from ${iso(nextAt * 1000)}` });
      else if (fund < minimum) jobs.push({ action: 'default_campaign', skip: 'nothing', detail: `fund ${fund} below the minimum ${minimum}` });
      else jobs.push({ action: 'default_campaign', fn: 'startDefaultCampaign' });
    }
    for (const j of jobs) {
      const row = { chainId, now, vault: v.vault, token: v.token, action: j.action };
      if (j.skip) {
        await logRun(db, { ...row, status: j.skip, detail: j.detail });
        done.push({ ...row, status: j.skip, detail: j.detail });
        continue;
      }
      if (calls >= config.maxCalls) break;
      let gas;
      try {
        gas = await wallet.estimate(v.vault, j.fn);
      } catch (e) {
        const detail = revertReason(e);
        await logRun(db, { ...row, status: 'reverted-dry-run', detail });
        done.push({ ...row, status: 'reverted-dry-run', detail });
        continue;
      }
      if (gas > config.maxGas) {
        const detail = `gas estimate ${gas} above the cap ${config.maxGas}`;
        await logRun(db, { ...row, status: 'skipped-gas', detail });
        done.push({ ...row, status: 'skipped-gas', detail });
        continue;
      }
      calls++;
      try {
        const r = await wallet.send(v.vault, j.fn, (gas * 12n) / 10n);
        const status = r.status === 'success' ? 'success' : 'reverted';
        await logRun(db, { ...row, status, tx: r.hash, gasUsed: r.gasUsed, detail: `gas estimate ${gas}` });
        done.push({ ...row, status, tx: r.hash, gasUsed: r.gasUsed?.toString() });
      } catch (e) {
        const detail = revertReason(e);
        await logRun(db, { ...row, status: 'error', detail });
        done.push({ ...row, status: 'error', detail });
      }
    }
  }
  return { vaults: vaults.length, calls, done, keeper: wallet.address };
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
