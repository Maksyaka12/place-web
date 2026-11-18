// React Query hooks for Place Launch. Keys live under ['place', chain, 'launch', …], so every Place
// transaction (usePlaceTx invalidates ['place', chain]) refreshes the launchpad too.
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { launchApi } from './client.js';
import { readContractUri } from './meta.js';
import { PLACE_CHAIN_ID, placeClient } from '../place/chain.js';
import { launchDeployment } from './deployments.js';
import { ERC20_ABI, PERMIT2_ABI, ETH, quoteAddress } from './swap.js';
import { LAUNCH_HOOK_ABI } from './abi.js';

const lc = (a) => (a ? String(a).toLowerCase() : a);
export const launchKeys = {
  all: ['place', PLACE_CHAIN_ID, 'launch'],
  tokens: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'tokens', q],
  token: (a) => ['place', PLACE_CHAIN_ID, 'launch', 'token', lc(a)],
  candles: (a, i) => ['place', PLACE_CHAIN_ID, 'launch', 'candles', lc(a), i],
  trades: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'trades', q],
  holders: (a) => ['place', PLACE_CHAIN_ID, 'launch', 'holders', lc(a)],
  stats: () => ['place', PLACE_CHAIN_ID, 'launch', 'stats'],
  pairs: () => ['place', PLACE_CHAIN_ID, 'launch', 'pairs'],
  stocks: () => ['place', PLACE_CHAIN_ID, 'launch', 'stocks'],
  creator: (a, s) => ['place', PLACE_CHAIN_ID, 'launch', 'creator', lc(a), s],
  profile: (a) => ['place', PLACE_CHAIN_ID, 'launch', 'profile', lc(a)],
  balances: (a, t, q) => ['place', PLACE_CHAIN_ID, 'launch', 'balances', lc(a), lc(t), lc(q)],
  pool: (id) => ['place', PLACE_CHAIN_ID, 'launch', 'pool', id],
  staking: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'staking', q],
  position: (id, a) => ['place', PLACE_CHAIN_ID, 'launch', 'staking-position', id, lc(a)],
  fundQuote: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'fund-quote', q],
  rewardTokens: (quote) => ['place', PLACE_CHAIN_ID, 'launch', 'reward-tokens', lc(quote)],
  rewards: (a, t) => ['place', PLACE_CHAIN_ID, 'launch', 'rewards', lc(a), lc(t) ?? null],
  hub: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'hub', q],
  hubStream: (id, a) => ['place', PLACE_CHAIN_ID, 'launch', 'hub-stream', id, lc(a) ?? null],
  hubAsset: (a, acc) => ['place', PLACE_CHAIN_ID, 'launch', 'hub-asset', lc(a), lc(acc) ?? null],
  collections: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'collections', q],
  collection: (a, acc) => ['place', PLACE_CHAIN_ID, 'launch', 'collection', lc(a), lc(acc) ?? null],
  nftAccount: (a) => ['place', PLACE_CHAIN_ID, 'launch', 'nft-account', lc(a)],
  nftPairs: () => ['place', PLACE_CHAIN_ID, 'launch', 'nft-pairs'],
  projects: (q) => ['place', PLACE_CHAIN_ID, 'launch', 'projects', q],
};

export const launchD = () => launchDeployment(PLACE_CHAIN_ID);

export function useLaunchTokens(q = {}, options = {}) {
  return useQuery({
    queryKey: launchKeys.tokens(q),
    queryFn: ({ signal }) => launchApi.tokens(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    ...options,
  });
}

export function useLaunchToken(address) {
  return useQuery({
    queryKey: launchKeys.token(address),
    queryFn: ({ signal }) => launchApi.token(address, signal),
    enabled: Boolean(address),
    refetchInterval: 10_000,
    // A token launched seconds ago may not be indexed yet: keep asking for a while.
    retry: (n, e) => (e?.status === 404 ? n < 8 : n < 1),
    retryDelay: 3000,
  });
}

export function useCandles(address, interval) {
  return useQuery({
    queryKey: launchKeys.candles(address, interval),
    queryFn: ({ signal }) => launchApi.candles({ address, interval, limit: 200 }, signal),
    enabled: Boolean(address),
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  });
}

export function useLaunchTrades(q, options = {}) {
  return useQuery({
    queryKey: launchKeys.trades(q),
    queryFn: ({ signal }) => launchApi.trades(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
    ...options,
  });
}

export function useLaunchHolders(address) {
  return useQuery({
    queryKey: launchKeys.holders(address),
    queryFn: ({ signal }) => launchApi.holders({ address, limit: 50 }, signal),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });
}

export function useLaunchStats() {
  return useQuery({ queryKey: launchKeys.stats(), queryFn: ({ signal }) => launchApi.stats(signal), refetchInterval: 30_000 });
}

export function usePairs() {
  return useQuery({ queryKey: launchKeys.pairs(), queryFn: ({ signal }) => launchApi.pairs(signal), staleTime: 60_000 });
}

export function useStocks() {
  return useQuery({ queryKey: launchKeys.stocks(), queryFn: ({ signal }) => launchApi.stocks(signal), staleTime: 120_000 });
}

/** 0.3.0: what a launch on this pair may pay rewards in (the pair, the token itself, listed routes). */
export function useRewardTokens(quote) {
  return useQuery({
    queryKey: launchKeys.rewardTokens(quote),
    queryFn: ({ signal }) => launchApi.rewardTokens(quote, signal),
    enabled: Boolean(quote),
    staleTime: 60_000,
  });
}

/** 0.3.0: claimable holder / trader rewards of an account (all tokens, or one), with claimMany transactions. */
export function useRewards(account, token) {
  return useQuery({
    queryKey: launchKeys.rewards(account, token),
    queryFn: ({ signal }) => launchApi.rewards(account, signal, token),
    enabled: Boolean(account),
    refetchInterval: 60_000,
  });
}

export function useCreator(address, slippageBps = 300) {
  return useQuery({
    queryKey: launchKeys.creator(address, slippageBps),
    queryFn: ({ signal }) => launchApi.creator({ address, slippageBps }, signal),
    enabled: Boolean(address),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
}

export function useProfile(address) {
  return useQuery({
    queryKey: launchKeys.profile(address),
    queryFn: ({ signal }) => launchApi.profile(address, signal),
    enabled: Boolean(address),
    staleTime: 30_000,
  });
}

/** Logo and other metadata behind a token's contract URI. Content behind it never changes, so cache forever. */
export function useTokenMeta(contractURI) {
  return useQuery({
    queryKey: ['launch-meta', contractURI],
    queryFn: ({ signal }) => readContractUri(contractURI, { signal }),
    enabled: Boolean(contractURI),
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: 1,
  });
}

/**
 * The wallet's balances of a launch token and its pair asset, plus the Permit2 allowances a sell (token in)
 * or an ERC-20-paid buy (quote in) needs. Read from the chain, refreshed every 10 s.
 */
export function useSwapWallet(account, token, quote) {
  const d = launchD();
  const q = quoteAddress(quote);
  return useQuery({
    queryKey: launchKeys.balances(account, token, q),
    enabled: Boolean(account && token && d),
    refetchInterval: 10_000,
    queryFn: async () => {
      const client = placeClient();
      const erc = (asset) => [
        { address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] },
        { address: asset, abi: ERC20_ABI, functionName: 'allowance', args: [account, d.permit2] },
        { address: d.permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, asset, d.universalRouter] },
      ];
      const contracts = [...erc(token), ...(q === ETH ? [] : erc(q))];
      const [res, eth] = await Promise.all([client.multicall({ contracts, allowFailure: false }), client.getBalance({ address: account })]);
      const pack = (i) => ({ balance: res[i], erc20ToPermit2: res[i + 1], permit2Amount: res[i + 2][0], permit2Expiration: Number(res[i + 2][1]) });
      return { token: pack(0), quote: q === ETH ? { balance: eth } : pack(3), eth };
    },
  });
}

/** Launch time and anti-snipe settings of a pool, from the hook (they never change). */
export function usePoolConfig(poolId, hook) {
  const d = launchD();
  const h = hook || d?.hook; // legacy tokens trade through their own release's hook
  return useQuery({
    queryKey: launchKeys.pool(poolId),
    enabled: Boolean(poolId && d),
    staleTime: Infinity,
    queryFn: async () => {
      const client = placeClient();
      const [cfg, scale] = await client.multicall({
        contracts: [
          { address: h, abi: LAUNCH_HOOK_ABI, functionName: 'poolConfig', args: [poolId] },
          { address: h, abi: LAUNCH_HOOK_ABI, functionName: 'RATE_SCALE' },
        ],
        allowFailure: false,
      });
      const [, tokenIsCurrency0, , , , , , anti, launchTime, antiSnipeEnabled] = cfg;
      return {
        tokenIsCurrency0,
        launchTime: Number(launchTime),
        antiSnipe: antiSnipeEnabled ? { startRate: Number(anti.startTotalFeeRate), windowSeconds: Number(anti.windowSeconds) } : null,
        rateScale: Number(scale),
      };
    },
  });
}

/** PlaceStaking programs (all, or for a token / creator), with the account's position when given. */
export function useStakingPrograms(q = {}, options = {}) {
  return useQuery({
    queryKey: launchKeys.staking(q),
    queryFn: ({ signal }) => launchApi.staking(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    ...options,
  });
}

/** The account's lots and claimable epochs in one program (read from the chain by the API). */
export function useStakingPosition(id, account) {
  return useQuery({
    queryKey: launchKeys.position(id, account),
    queryFn: ({ signal }) => launchApi.stakingPosition({ id, account }, signal),
    enabled: Boolean(id && account),
    refetchInterval: 30_000,
  });
}

/** What the community fund gets in a reward token: the vault's own dry run (swap, minOut, fees). */
export function useFundQuote(q) {
  return useQuery({
    queryKey: launchKeys.fundQuote(q),
    queryFn: ({ signal }) => launchApi.fundQuote(q, signal),
    enabled: Boolean(q?.token && q?.amountIn && q.amountIn !== '0'),
    staleTime: 10_000,
    retry: 0,
  });
}

/** Every reward stream in the Rewards hub (with the account's claims and funded streams when given). */
export function useHubStreams(q = {}, options = {}) {
  return useQuery({
    queryKey: launchKeys.hub(q),
    queryFn: ({ signal }) => launchApi.hub(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    ...options,
  });
}

/** One stream of the Rewards hub with its days and actions. */
export function useHubStream(id, account) {
  return useQuery({
    queryKey: launchKeys.hubStream(id, account),
    queryFn: ({ signal }) => launchApi.hubStream(account ? { id, account } : { id }, signal),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });
}

/** What a token or collection allows in the create form (types, Community Pool). */
export function useHubAsset(address, account) {
  return useQuery({
    queryKey: launchKeys.hubAsset(address, account),
    queryFn: ({ signal }) => launchApi.hubAsset(account ? { address, account } : { address }, signal),
    enabled: Boolean(address),
    staleTime: 30_000,
    retry: 0,
  });
}

/** NFT launchpad collections; `data.deployed` is false before the 0.3.1 deploy. */
export function useCollections(q = {}, options = {}) {
  return useQuery({
    queryKey: launchKeys.collections(q),
    queryFn: ({ signal }) => launchApi.collections(q, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    ...options,
  });
}

export function useCollection(address, account) {
  return useQuery({
    queryKey: launchKeys.collection(address, account),
    queryFn: ({ signal }) => launchApi.collection(address, account, signal),
    enabled: Boolean(address),
    refetchInterval: 10_000,
    // A collection created seconds ago may not be indexed yet: keep asking for a while.
    retry: (n, e) => (e?.status === 404 ? n < 8 : n < 1),
    retryDelay: 3000,
  });
}

export function useNftAccount(account, options = {}) {
  return useQuery({
    queryKey: launchKeys.nftAccount(account),
    queryFn: ({ signal }) => launchApi.nftAccount(account, signal),
    enabled: Boolean(account),
    refetchInterval: 20_000,
    ...options,
  });
}

export function useNftPairs() {
  return useQuery({ queryKey: launchKeys.nftPairs(), queryFn: ({ signal }) => launchApi.nftPairs(signal), staleTime: 60_000 });
}

/** Registered external projects (verified only, unless filtered by token or creator). */
export function useProjects(q = {}, options = {}) {
  return useQuery({ queryKey: launchKeys.projects(q), queryFn: ({ signal }) => launchApi.projects(q, signal), staleTime: 30_000, ...options });
}
