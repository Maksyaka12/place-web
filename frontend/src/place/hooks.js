// React Query hooks over the Place API, IPFS reads and the transaction flow every Place action uses.
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, encodeFunctionData } from 'viem';
import { placeApi, fetchIpfsJson } from './api.js';
import { PLACE_CHAIN, PLACE_CHAIN_ID, placeClient } from './chain.js';
import { usePlaceWallets } from '../hooks/usePlaceWallets';
import { appendBuilderSuffix } from '../config/builderCode';
import { blockInDemo, guardProvider, isDemoModeError } from '../config/demo';
import { isWalletRejection } from '../config/walletTx';

const lc = (a) => (a ? String(a).toLowerCase() : a);

export const placeKeys = {
  all: ['place', PLACE_CHAIN_ID],
  campaigns: (q) => ['place', PLACE_CHAIN_ID, 'campaigns', q],
  campaign: (hub, id, address) => ['place', PLACE_CHAIN_ID, 'campaign', lc(hub), String(id), lc(address) || null],
  claims: (address) => ['place', PLACE_CHAIN_ID, 'claims', lc(address)],
  token: (address) => ['place', PLACE_CHAIN_ID, 'token', lc(address)],
  collections: (q) => ['place', PLACE_CHAIN_ID, 'collections', q],
  holders: (q) => ['place', PLACE_CHAIN_ID, 'holders', q],
  ipfs: (uri) => ['ipfs', uri],
};

export function useCampaigns(q = {}, options = {}) {
  return useQuery({ queryKey: placeKeys.campaigns(q), queryFn: ({ signal }) => placeApi.campaigns(q, signal), ...options });
}

export function useCampaign({ hub, id, address }) {
  return useQuery({
    queryKey: placeKeys.campaign(hub, id, address),
    queryFn: ({ signal }) => placeApi.campaign({ hub, id, address }, signal),
    placeholderData: keepPreviousData,
    enabled: Boolean(hub && id != null),
  });
}

export function useClaims(address) {
  return useQuery({ queryKey: placeKeys.claims(address), queryFn: ({ signal }) => placeApi.claims(address, signal), enabled: Boolean(address) });
}

export function useToken(address) {
  return useQuery({ queryKey: placeKeys.token(address), queryFn: ({ signal }) => placeApi.token(address, signal), enabled: Boolean(address) });
}

export function useCollections(q = {}, options = {}) {
  return useQuery({ queryKey: placeKeys.collections(q), queryFn: ({ signal }) => placeApi.collections(q, signal), ...options });
}

/** Holder preview for the Create form; reads the chain, so it only runs on request (`enabled`). */
export function useHolders(q, enabled) {
  return useQuery({
    queryKey: placeKeys.holders(q),
    queryFn: ({ signal }) => placeApi.holders(q, signal),
    enabled: Boolean(enabled && q?.target),
    staleTime: 60_000,
    retry: 0,
  });
}

export function useIpfsJson(uri, options = {}) {
  return useQuery({
    queryKey: placeKeys.ipfs(uri),
    queryFn: ({ signal }) => fetchIpfsJson(uri, { signal }),
    enabled: Boolean(uri) && /^ipfs:\/\//.test(uri),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
    ...options,
  });
}

/** Campaign name, description and banner from metadataURI (all optional). */
export function useCampaignMeta(campaign) {
  return useIpfsJson(campaign?.metadataURI);
}

/** The address the portal shows: the demo holder, else the active wallet. */
export function usePlaceAccount() {
  const { activeAddress, isDemo } = usePlaceWallets();
  return { address: activeAddress ? activeAddress.toLowerCase() : null, isDemo };
}

/** A clock for countdowns and status changes. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Plain-words message for a failed transaction (DESIGN.md §8, transaction states). */
export function txErrorMessage(e) {
  const raw = e?.shortMessage || e?.details || e?.message || 'Transaction failed';
  const known = raw.match(/reverted with the following reason:\s*([^\n]+)/) || raw.match(/error\s+([A-Z][A-Za-z]+)\(/);
  if (/insufficient funds/i.test(raw)) return 'Not enough ETH for this transaction and its gas';
  if (known) return `Transaction would fail: ${known[1]}`;
  return raw.split('\n')[0].slice(0, 200);
}

/**
 * One on-chain action: idle → wallet → pending → success | error. `send(steps)` takes a list of calls
 * ({to, abi, functionName, args, value} or {to, data, value}, each with an optional `label` and `preview`)
 * and sends them one after another from the active wallet on the Place chain, waiting for each receipt.
 * Rejecting in the wallet returns to idle quietly; in the read-only demo the first call shows its preview.
 */
export function usePlaceTx({ onSuccess } = {}) {
  const { wallets } = useWallets();
  const { activeAddress } = usePlaceWallets();
  const queryClient = useQueryClient();
  const [state, setState] = useState({ status: 'idle', step: null, hash: null, error: null });

  const reset = useCallback(() => setState({ status: 'idle', step: null, hash: null, error: null }), []);

  const send = useCallback(
    async (calls) => {
      const list = Array.isArray(calls) ? calls : [calls];
      try {
        const first = list[0];
        blockInDemo(first.preview || { action: first.label || 'Send transaction', contract: first.to, method: first.functionName || '' });
        const wallet = wallets?.find((w) => w.address?.toLowerCase() === activeAddress?.toLowerCase()) || wallets?.[0];
        if (!wallet) throw new Error('Connect a wallet first');
        setState({ status: 'wallet', step: first.label || null, hash: null, error: null });
        if (Number(String(wallet.chainId || '').split(':').pop()) !== PLACE_CHAIN_ID) await wallet.switchChain(PLACE_CHAIN_ID);
        const provider = guardProvider(await wallet.getEthereumProvider());
        const walletClient = createWalletClient({ account: wallet.address, chain: PLACE_CHAIN, transport: custom(provider) });
        const client = placeClient();
        let hash = null;
        let receipt = null;
        for (const call of list) {
          setState((s) => ({ ...s, status: 'wallet', step: call.label || s.step }));
          const data = call.data || encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
          hash = await walletClient.sendTransaction({ to: call.to, data: appendBuilderSuffix(data), value: BigInt(call.value || 0) });
          setState((s) => ({ ...s, status: 'pending', hash }));
          receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
          if (receipt.status !== 'success') throw new Error('Transaction reverted on Base');
        }
        setState({ status: 'success', step: null, hash, error: null });
        // Everything Place shows can change after a transaction; the API catches up within a minute.
        queryClient.invalidateQueries({ queryKey: placeKeys.all });
        setTimeout(() => queryClient.invalidateQueries({ queryKey: placeKeys.all }), 20_000);
        onSuccess?.(receipt);
        return receipt;
      } catch (e) {
        if (isDemoModeError(e) || isWalletRejection(e)) {
          reset();
          return null;
        }
        setState({ status: 'error', step: null, hash: null, error: txErrorMessage(e) });
        return null;
      }
    },
    [wallets, activeAddress, queryClient, onSuccess, reset]
  );

  return { ...state, busy: state.status === 'wallet' || state.status === 'pending', send, reset };
}
