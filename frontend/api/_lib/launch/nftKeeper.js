// The keeper's part for NFT launchpad collections (PlaceNftCollection 0.3.1).
//
// The holders pool of a collection accrues on its own (lazily, by whole UTC days): no keeper is needed for claims.
// What waits for somebody to send a transaction:
//   buyback(maxEthIn)        ETH of the burn share that could not buy the pair token during a mint (price impact,
//                            guard not ready): the whole amount, or a quarter of it when the whole does not fit
//   processPending(asset)    royalties that reached the collection (ETH, WETH, the pair token, the reward token) and
//                            holders shares still waiting to be swapped into the reward token
//   payOut(asset)            what the creator and the platform are owed, in ETH, the pair token and the reward token
//   PlacePriceGuard.observeRoute(route)
//                            a route the guard never saw (e.g. ETH -> a third-party reward token, which no mint
//                            observes): the first observation starts its warm-up, the swap runs on a later pass
// Every swap waits until the guard is ready for its route (quote does not revert): processPending would succeed
// anyway and leave the amount waiting, i.e. burn gas for nothing.
//
// Thresholds keep the keeper from paying gas for dust (env):
//   PLACE_KEEPER_NFT_MIN_ETH       ETH amounts, in ETH (default 0.0005)
//   PLACE_KEEPER_NFT_MIN_TOKENS    token amounts, in whole tokens of the token's decimals (default 1)
//   PLACE_KEEPER_NFT_INTERVAL_S    how often one collection is looked at (default 6 h)
// Rows in keeper_runs: vault = the collection, token = its pair token, action nft_buyback | nft_process |
// nft_payout | nft_observe. A pass that found nothing is logged once per interval as nft_process / nothing.
import { parseAbi, parseEther } from 'viem';
import { NFT_COLLECTION_ABI, NFT_FACTORY_ABI, NFT_SWAPPER_ABI, PRICE_GUARD_ABI } from '../../../src/launch/nftAbi.js';
import { nftDeployment } from '../../../src/launch/deployments.js';
import { retry } from '../place/chain.js';
import { iso } from '../place/http.js';

const ETH = '0x0000000000000000000000000000000000000000';
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
export const NFT_ACTIONS = ['nft_buyback', 'nft_process', 'nft_payout', 'nft_observe'];
const TOO_BIG = /PriceImpactTooHigh|Slippage|PartialFill/;

export function nftKeeperConfig(env = process.env) {
  return {
    intervalS: Number(env.PLACE_KEEPER_NFT_INTERVAL_S || 21_600),
    minEth: parseEther(String(env.PLACE_KEEPER_NFT_MIN_ETH || '0.0005')),
    minTokens: String(env.PLACE_KEEPER_NFT_MIN_TOKENS || '1'),
  };
}

/** `whole` tokens (a decimal string) in base units of a token with `decimals`. */
export function tokenThreshold(whole, decimals) {
  const [i, f = ''] = String(whole).split('.');
  const d = Number(decimals);
  return BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0');
}

const errorOf = (e) => {
  const hit = typeof e?.walk === 'function' ? e.walk((x) => x?.data?.errorName) : null;
  return hit ? { name: hit.data.errorName, args: hit.data.args || [] } : { name: null, args: [], message: e?.shortMessage || e?.message || String(e) };
};

/**
 * One pass over the chain's NFT collections. `k` is the keeper's toolbox from runKeeper:
 * { db, client, chainId, now, attempt(row, call, gasCap?), nothing(row, detail), outOfTime(), done }.
 */
export async function runNftKeeper(k, config) {
  const n = nftDeployment(k.chainId);
  if (!n) return { collections: 0 };
  const { db, client, chainId, now } = k;
  const collections = await db.query('select address, token, reward_token from nft_launch_collections where chain_id = $1 order by created_block', [chainId]);
  if (!collections.length) return { collections: 0 };
  const last = new Map(
    (
      await db.query(
        `select vault, max(at) as at from keeper_runs where chain_id = $1 and action = any($2::text[]) and status <> 'error' group by vault`,
        [chainId, NFT_ACTIONS]
      )
    ).map((r) => [r.vault, r.at])
  );
  const due = collections.filter((c) => {
    const at = last.get(c.address);
    return !at || now - new Date(at).getTime() / 1000 >= config.intervalS;
  });
  if (!due.length) return { collections: collections.length, checked: 0 };

  let weth = null;
  try {
    weth = String(await retry(() => client.readContract({ address: n.factory, abi: NFT_FACTORY_ABI, functionName: 'weth' }))).toLowerCase();
    if (weth === ETH) weth = null;
  } catch {
    weth = null;
  }
  const decimals = new Map();
  async function minOf(asset) {
    if (asset === ETH) return config.minEth;
    if (!decimals.has(asset)) {
      const d = await retry(() => client.readContract({ address: asset, abi: ERC20, functionName: 'decimals' })).catch(() => 18);
      decimals.set(asset, Number(d));
    }
    return tokenThreshold(config.minTokens, decimals.get(asset));
  }

  let checked = 0;
  for (const c of due) {
    if (k.outOfTime()) break;
    checked++;
    const address = c.address;
    const token = c.token || ETH;
    const reward = c.reward_token || ETH;
    const row = { chainId, now, vault: address, token: c.token };
    const coll = (functionName, args = []) => ({ address, abi: NFT_COLLECTION_ABI, functionName, args });
    // Assets the collection may hold: ETH, the pair token, the reward token.
    const assets = [...new Set([ETH, token, reward])];

    async function read() {
      const calls = [coll('buybackPending'), coll('launchPool')];
      for (const a of assets) calls.push(coll('pendingHolders', [a]), coll('reserved', [a]), coll('creatorOwed', [a]), coll('platformOwed', [a]));
      for (const a of assets) if (a !== ETH) calls.push({ address: a, abi: ERC20, functionName: 'balanceOf', args: [address] });
      if (weth) calls.push({ address: weth, abi: ERC20, functionName: 'balanceOf', args: [address] });
      const res = await retry(() => client.multicall({ contracts: calls, allowFailure: false }));
      const ethBalance = await retry(() => client.getBalance({ address }));
      let i = 2;
      const s = { buybackPending: res[0], launchPool: res[1], pending: {}, reserved: {}, owed: {}, balance: { [ETH]: ethBalance } };
      for (const a of assets) {
        s.pending[a] = res[i++];
        s.reserved[a] = res[i++];
        s.owed[a] = res[i] + res[i + 1];
        i += 2;
      }
      for (const a of assets) if (a !== ETH) s.balance[a] = res[i++];
      s.weth = weth ? res[i++] : 0n;
      // Royalties not split yet: anything above what the collection owes.
      s.royalty = Object.fromEntries(assets.map((a) => [a, s.balance[a] > s.reserved[a] ? s.balance[a] - s.reserved[a] : 0n]));
      return s;
    }

    /** Can the guard price this swap now (`burn`: the ETH -> pair route, else ETH or pair -> reward token)? { ready } or { ready: false, detail, route (to observe) }. */
    async function guardReady(input, output, amount, burn = false) {
      let route;
      try {
        route = burn
          ? await retry(() => client.readContract({ address: n.swapper, abi: NFT_SWAPPER_ABI, functionName: 'ethRoute', args: [token, s.launchPool] }))
          : await retry(() => client.readContract({ address: n.swapper, abi: NFT_SWAPPER_ABI, functionName: 'rewardRoute', args: [token, s.launchPool, input, output] }));
      } catch (e) {
        const err = errorOf(e);
        return { ready: false, detail: `no swap route (${err.name || err.message})` };
      }
      try {
        await client.readContract({ address: n.priceGuard, abi: PRICE_GUARD_ABI, functionName: 'quote', args: [route, input, amount] });
        return { ready: true };
      } catch (e) {
        const err = errorOf(e);
        if (err.name === 'PriceNotReady') {
          const at = Number(err.args[1] || 0);
          return at === 0 ? { ready: false, detail: 'price guard never observed this route', route } : { ready: false, detail: `price guard ready at ${iso(at * 1000)}` };
        }
        if (err.name === 'PriceDeviation') return { ready: false, detail: `price moved too far from the guard reference (${err.args[1]} bps)` };
        return { ready: false, detail: `price guard: ${err.name || err.message}` };
      }
    }
    const observed = new Set();
    async function notReady(action, g) {
      if (g.route && n.priceGuard) {
        const key = JSON.stringify(g.route, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
        if (observed.has(key)) return;
        observed.add(key);
        await k.attempt({ ...row, action: 'nft_observe', detail: 'start the price guard warm-up' }, { address: n.priceGuard, abi: PRICE_GUARD_ABI, functionName: 'observeRoute', args: [g.route] });
      } else {
        await k.nothing({ ...row, action }, g.detail);
      }
    }

    let s;
    try {
      s = await read();
    } catch (e) {
      k.done.push({ vault: address, action: 'nft_read', status: 'error', detail: e.shortMessage || e.message });
      continue;
    }
    let acted = false;
    const minEth = config.minEth;

    // 1. Buyback & burn of the waiting ETH (the whole, or a quarter when the whole moves the price too much).
    if (token !== ETH && s.buybackPending >= minEth) {
      const g = await guardReady(ETH, token, s.buybackPending, true);
      if (g.ready) {
        const all = await k.attempt({ ...row, action: 'nft_buyback', detail: `all ${s.buybackPending}` }, coll('buyback', [s.buybackPending]));
        if (all?.status === 'reverted-dry-run' && TOO_BIG.test(all.detail || '')) {
          const quarter = s.buybackPending / 4n;
          if (quarter >= minEth) await k.attempt({ ...row, action: 'nft_buyback', detail: `a quarter ${quarter}` }, coll('buyback', [quarter]));
        }
      } else await notReady('nft_buyback', g);
      acted = true;
    }

    // 2. ETH / WETH royalties and holders shares waiting to become the reward token: processPending(ETH or WETH)
    //    splits the royalties and retries every waiting swap.
    if (k.outOfTime()) break;
    const why = [];
    if (s.royalty[ETH] + s.weth >= minEth) why.push(`royalties ${s.royalty[ETH] + s.weth} wei`);
    for (const a of assets) {
      if (a === reward || s.pending[a] < (await minOf(a))) continue;
      const g = await guardReady(a, reward, s.pending[a]);
      if (g.ready) why.push(`holders share ${s.pending[a]} of ${a} to swap`);
      else {
        await notReady('nft_process', g);
        acted = true;
      }
    }
    if (why.length) {
      await k.attempt({ ...row, action: 'nft_process', detail: why.join(', ') }, coll('processPending', [s.weth > 0n ? weth : ETH]));
      acted = true;
    }
    // ERC-20 royalties in the pair token or the reward token.
    for (const a of assets) {
      if (a === ETH || k.outOfTime()) continue;
      if (s.royalty[a] >= (await minOf(a))) {
        await k.attempt({ ...row, action: 'nft_process', detail: `royalties ${s.royalty[a]} of ${a}` }, coll('processPending', [a]));
        acted = true;
      }
    }

    // 3. Creator and platform payouts (owed amounts read again when something above may have changed them).
    if (k.outOfTime()) break;
    if (acted) {
      try {
        s = await read();
      } catch (e) {
        k.done.push({ vault: address, action: 'nft_read', status: 'error', detail: e.shortMessage || e.message });
        continue;
      }
    }
    for (const a of assets) {
      if (k.outOfTime()) break;
      if (s.owed[a] > 0n && s.owed[a] >= (await minOf(a))) {
        await k.attempt({ ...row, action: 'nft_payout', detail: `${s.owed[a]} of ${a === ETH ? 'ETH' : a}` }, coll('payOut', [a]));
        acted = true;
      }
    }
    if (!acted) await k.nothing({ ...row, action: 'nft_process' }, 'nothing waiting above the thresholds');
  }
  return { collections: collections.length, checked };
}
