import { useCallback, useEffect, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { publicClient } from '../config/rpc';
import { sendWalletTx, waitUntil } from '../config/walletTx';
import { fetchUsdPrices } from '../config/prices';
import { BASE_TOKENS, ERC20_ABI, readTokenBalance, tokenKey } from '../config/tokens';
import { usePlaceWallets } from './usePlaceWallets';

// Balances and USD value of the user's main and agent wallets on Base, plus sending from either of them.
// Shared by the Wallet, Settings and Agent Zone pages.

export const TOKENS = BASE_TOKENS;

async function readBalances(address) {
  const raw = await Promise.all(TOKENS.map((t) => readTokenBalance(t, address)));
  return Object.fromEntries(TOKENS.map((t, i) => [t.symbol, raw[i]]));
}

async function readPrices() {
  const usd = await fetchUsdPrices(TOKENS.map((t) => t.address));
  return Object.fromEntries(TOKENS.map((t) => [t.symbol, usd[tokenKey(t)] || 0]));
}

export const tokenAmount = (token, raw) => (raw == null ? null : Number(formatUnits(raw, TOKENS.find((t) => t.symbol === token).decimals)));

export function useWalletAssets() {
  const { wallets } = useWallets();
  const pw = usePlaceWallets();
  const { mainAddress, agentAddress, hasAgentWallet } = pw;
  const [balances, setBalances] = useState({});
  const [prices, setPrices] = useState({ USDC: 1 });

  const refresh = useCallback(async () => {
    const addrs = [mainAddress, hasAgentWallet ? agentAddress : null].filter(Boolean);
    const results = await Promise.all(addrs.map((a) => readBalances(a).catch(() => null)));
    const next = {};
    addrs.forEach((a, i) => {
      if (results[i]) next[a.toLowerCase()] = results[i];
    });
    setBalances((prev) => ({ ...prev, ...next }));
  }, [mainAddress, agentAddress, hasAgentWallet]);

  useEffect(() => {
    refresh();
    readPrices().then(setPrices).catch(() => {});
  }, [refresh]);

  const balancesOf = (address) => (address ? balances[address.toLowerCase()] || null : null);

  const usdValue = (address) => {
    const b = balancesOf(address);
    if (!b) return null;
    return TOKENS.reduce((sum, t) => sum + (tokenAmount(t.symbol, b[t.symbol]) || 0) * (prices[t.symbol] || 0), 0);
  };

  /** Sends `amount` (decimal string) of `token` from one of the user's wallets; resolves with the tx hash or null. */
  const send = async ({ from, to, token, amount }) => {
    const t = TOKENS.find((x) => x.symbol === token);
    const value = parseUnits(amount, t.decimals);
    const before = balancesOf(from)?.[token];
    const tx = t.address
      ? { to: t.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, value] }), value: 0n }
      : { to, data: '0x', value };
    const hash = await sendWalletTx({
      wallets,
      address: from,
      ...tx,
      // shown instead of sending while the read-only demo is on
      preview: { action: `Send ${token} to ${to.slice(0, 6)}…${to.slice(-4)}`, amount: `${amount} ${token}`, contract: tx.to, contractLabel: t.address ? token : 'Recipient', method: t.address ? 'transfer(to, amount)' : '' },
    });
    if (hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== 'success') throw new Error('Transaction reverted on Base');
    } else if (before != null) {
      // smart wallet without a reported hash: wait until the sender's balance drops
      await waitUntil(async () => (await readTokenBalance(t, from)) < before);
    }
    await refresh();
    return hash;
  };

  return { ...pw, balancesOf, usdValue, prices, refresh, send };
}
