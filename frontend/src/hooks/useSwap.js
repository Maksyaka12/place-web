import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { publicClient } from '../config/rpc';
import { sendWalletTx, isWalletRejection, waitUntil } from '../config/walletTx';
import { fetchUsdPrices } from '../config/prices';
import { BASE_TOKENS, ERC20_ABI, ETH, USDC, readTokenBalance, resolveToken, tokenKey } from '../config/tokens';
import { usePlaceWallets } from './usePlaceWallets';
import { useDemoMode } from './useDemoMode';
import { isDemoActive, showDemoTxPreview } from '../config/demo';

// Swap between any two tokens on Base, shared by the Swap page.
// - Quotes LI.FI and KyberSwap in parallel and takes the one that gives the user more; a quote older than 30 s or
//   for other inputs is fetched again before swapping.
// - Never sends anything without a real route; approvals are for the exact amount and confirmed before the swap.
// - The result is read from the receipt: a reverted swap (e.g. price moved past slippage) is reported as failed.
// - Tokens come from the default list or by address (?in=0x…&out=0x… in the URL, or pasted in the token picker).

const LIFI_ETH = '0x0000000000000000000000000000000000000000';
const KYBER_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1';
const KYBER_HEADERS = { 'x-client-id': 'place' };
const GAS_RESERVE = parseUnits('0.0001', 18); // left in the wallet when paying ETH with "Max"
const QUOTE_TTL_MS = 30_000;

const parseAmount = (s, decimals) => {
  if (!/^\d*\.?\d*$/.test(s || '') || !s || s === '.') return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

export const fmtAmount = (n) => {
  if (n == null || Number.isNaN(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
};
const fmtUsd = (n) => `~$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function lifiQuote({ tokenIn, tokenOut, amountWei, from, slippage }) {
  const params = new URLSearchParams({
    fromChain: '8453', toChain: '8453',
    fromToken: tokenIn.address || LIFI_ETH,
    toToken: tokenOut.address || LIFI_ETH,
    fromAmount: amountWei.toString(),
    fromAddress: from,
    slippage: String(slippage / 100),
  });
  const res = await fetch(`https://li.quest/v1/quote?${params}`);
  const data = await res.json();
  if (!res.ok || !data?.estimate || !data?.transactionRequest) throw new Error(data?.message || 'LI.FI: no route');
  return {
    engine: 'LI.FI',
    out: BigInt(data.estimate.toAmount),
    minOut: BigInt(data.estimate.toAmountMin),
    spender: data.estimate.approvalAddress || data.transactionRequest.to,
    build: async () => ({ to: data.transactionRequest.to, data: data.transactionRequest.data, value: BigInt(data.transactionRequest.value || 0) }),
  };
}

async function kyberQuote({ tokenIn, tokenOut, amountWei, from, slippage }) {
  const route = await fetch(`${KYBER}/routes?tokenIn=${tokenIn.address || KYBER_ETH}&tokenOut=${tokenOut.address || KYBER_ETH}&amountIn=${amountWei}`, { headers: KYBER_HEADERS }).then((r) => r.json());
  if (route?.code !== 0 || !route.data?.routeSummary) throw new Error(route?.message || 'KyberSwap: no route');
  const out = BigInt(route.data.routeSummary.amountOut);
  return {
    engine: 'KyberSwap',
    out,
    minOut: out - (out * BigInt(Math.round(slippage * 100))) / 10000n,
    spender: route.data.routerAddress,
    build: async () => {
      const built = await fetch(`${KYBER}/route/build`, {
        method: 'POST',
        headers: { ...KYBER_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ routeSummary: route.data.routeSummary, sender: from, recipient: from, slippageTolerance: Math.round(slippage * 100), deadline: Math.floor(Date.now() / 1000) + 1200 }),
      }).then((r) => r.json());
      if (built?.code !== 0 || !built.data?.data) throw new Error(built?.message || 'KyberSwap could not build the swap');
      return { to: built.data.routerAddress || route.data.routerAddress, data: built.data.data, value: tokenIn.address ? 0n : amountWei };
    },
  };
}

/** Best of LI.FI and KyberSwap for these inputs (most tokens out). */
async function bestQuote(args) {
  const results = await Promise.allSettled([kyberQuote(args), lifiQuote(args)]);
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error('No swap route right now, try another amount');
  return ok.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
}

/** Starting pair: ?in= / ?out= token addresses from the URL, else ETH → USDC. */
function initialPair() {
  try {
    const q = new URLSearchParams(window.location.search);
    return { inAddr: q.get('in'), outAddr: q.get('out') };
  } catch {
    return {};
  }
}

export function useSwap() {
  const { authenticated: walletConnected, login } = usePrivy();
  const { demo } = useDemoMode();
  const authenticated = walletConnected || demo; // the read-only demo can quote and preview, never send
  const { wallets } = useWallets();
  const { activeAddress } = usePlaceWallets();

  const [tokenIn, setTokenIn] = useState(ETH);
  const [tokenOut, setTokenOut] = useState(USDC);
  const [customTokens, setCustomTokens] = useState([]);
  const [balances, setBalances] = useState({}); // tokenKey -> raw balance
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [prices, setPrices] = useState({});
  const [fromAmount, setFromAmountRaw] = useState('');
  const [slippage, setSlippage] = useState(1.0);
  const [quote, setQuote] = useState(null); // { key, at, ...bestQuote }
  const [quoteError, setQuoteError] = useState('');
  const [isFetchingQuote, setIsFetchingQuote] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [txStatus, setTxStatus] = useState({ type: '', msg: '', hash: '' });
  const requestId = useRef(0);

  const tokenList = useMemo(() => {
    const seen = new Set();
    return [...BASE_TOKENS, ...customTokens].filter((t) => !seen.has(tokenKey(t)) && seen.add(tokenKey(t)));
  }, [customTokens]);

  /** Adds a token by address (resolved onchain) and returns it. */
  const addToken = useCallback(async (address) => {
    const t = await resolveToken(address);
    setCustomTokens((list) => (list.some((x) => tokenKey(x) === tokenKey(t)) ? list : [...list, t]));
    return t;
  }, []);

  // tokens from the URL
  useEffect(() => {
    const { inAddr, outAddr } = initialPair();
    if (inAddr) addToken(inAddr).then(setTokenIn).catch(() => {});
    if (outAddr) addToken(outAddr).then(setTokenOut).catch(() => {});
  }, [addToken]);

  const resetQuote = () => {
    setQuote(null);
    setQuoteError('');
    setTxStatus({ type: '', msg: '', hash: '' });
  };

  const selectToken = (side, t) => {
    const other = side === 'in' ? tokenOut : tokenIn;
    if (tokenKey(t) === tokenKey(other)) {
      // picking the other side's token flips the pair
      setTokenIn(side === 'in' ? t : tokenOut);
      setTokenOut(side === 'in' ? tokenIn : t);
    } else if (side === 'in') setTokenIn(t);
    else setTokenOut(t);
    setFromAmountRaw('');
    resetQuote();
  };

  const refreshBalances = useCallback(async () => {
    if (!activeAddress) {
      setBalances({});
      return;
    }
    setBalancesLoading(true);
    const pair = [tokenIn, tokenOut];
    const raw = await Promise.all(pair.map((t) => readTokenBalance(t, activeAddress).catch(() => null)));
    setBalances((prev) => ({ ...prev, ...Object.fromEntries(pair.map((t, i) => [tokenKey(t), raw[i]])) }));
    setBalancesLoading(false);
  }, [activeAddress, tokenIn, tokenOut]);

  useEffect(() => {
    refreshBalances();
    const timer = setInterval(refreshBalances, 15_000);
    return () => clearInterval(timer);
  }, [refreshBalances]);

  useEffect(() => {
    let active = true;
    const load = () => fetchUsdPrices([tokenIn.address, tokenOut.address]).then((p) => active && setPrices((prev) => ({ ...prev, ...p }))).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { active = false; clearInterval(t); };
  }, [tokenIn, tokenOut]);

  const amountWei = parseAmount(fromAmount, tokenIn.decimals);
  const from = activeAddress || '0x0000000000000000000000000000000000000001';
  const key = amountWei ? `${tokenKey(tokenIn)}:${tokenKey(tokenOut)}:${amountWei}:${slippage}:${from.toLowerCase()}` : '';
  const balanceIn = balances[tokenKey(tokenIn)] ?? null;
  const balanceOut = balances[tokenKey(tokenOut)] ?? null;
  // the demo only previews, so it can try any amount
  const insufficient = Boolean(!demo && activeAddress && amountWei && balanceIn != null && amountWei > balanceIn);

  const setFromAmount = (v) => {
    setTxStatus({ type: '', msg: '', hash: '' });
    setFromAmountRaw(String(v).replace(',', '.').replace(/[^0-9.]/g, ''));
  };

  // debounced quote; a late answer for older inputs is dropped
  useEffect(() => {
    if (!key) {
      setQuote(null);
      setQuoteError('');
      return undefined;
    }
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setIsFetchingQuote(true);
      try {
        const q = await bestQuote({ tokenIn, tokenOut, amountWei, from, slippage });
        if (id === requestId.current) {
          setQuote({ ...q, key, at: Date.now() });
          setQuoteError('');
        }
      } catch (e) {
        if (id === requestId.current) {
          setQuote(null);
          setQuoteError(e.message);
        }
      } finally {
        if (id === requestId.current) setIsFetchingQuote(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveQuote = quote && quote.key === key ? quote : null;
  const outNum = liveQuote ? Number(formatUnits(liveQuote.out, tokenOut.decimals)) : 0;
  const toAmount = liveQuote ? fmtAmount(outNum) : '';
  const inNum = amountWei ? Number(formatUnits(amountWei, tokenIn.decimals)) : 0;
  const priceOf = (t) => prices[tokenKey(t)] || 0;
  const fromUsd = amountWei && priceOf(tokenIn) ? fmtUsd(inNum * priceOf(tokenIn)) : '';
  const toUsd = liveQuote && priceOf(tokenOut) ? fmtUsd(outNum * priceOf(tokenOut)) : '';
  const fmtBalance = (raw, t) => (raw == null ? '0' : fmtAmount(Number(formatUnits(raw, t.decimals))));

  // 25 / 50 / 75 / Max from the exact onchain balance
  const handlePercentage = (percent) => {
    if (!balanceIn) return;
    let v = (balanceIn * BigInt(percent)) / 100n;
    if (!tokenIn.address && percent === 100) v = v > GAS_RESERVE ? v - GAS_RESERVE : 0n;
    if (v <= 0n) return;
    const text = formatUnits(v, tokenIn.decimals);
    setFromAmount(percent === 100 && tokenIn.address ? text : text.replace(/(\.\d{6})\d+$/, '$1'));
  };

  const handleToggleMode = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setFromAmountRaw('');
    resetQuote();
  };

  const send = (tx) => sendWalletTx({ wallets, address: activeAddress, ...tx });

  const handleSwap = async () => {
    if (!authenticated || !activeAddress) {
      login?.();
      return;
    }
    if (!amountWei || insufficient) return;
    // Read-only demo: preview the swap with the live quote, send nothing.
    if (isDemoActive()) {
      const inLabel = `${formatUnits(amountWei, tokenIn.decimals)} ${tokenIn.symbol}`;
      showDemoTxPreview({
        action: `Swap ${tokenIn.symbol} → ${tokenOut.symbol}${liveQuote ? ` via ${liveQuote.engine}` : ''}`,
        amount: liveQuote ? `${inLabel} → ~${toAmount} ${tokenOut.symbol}` : inLabel,
        contract: liveQuote?.spender || '',
        contractLabel: liveQuote ? `${liveQuote.engine} router` : '',
        note: `Slippage ${slippage}%.${tokenIn.address ? ` First asks for a ${tokenIn.symbol} approval for exactly this amount.` : ''}`,
      });
      return;
    }
    setSwapping(true);
    try {
      // a fresh quote for exactly these inputs
      let q = liveQuote;
      if (!q || Date.now() - q.at > QUOTE_TTL_MS) {
        setTxStatus({ type: 'info', msg: 'Refreshing the best price…', hash: '' });
        q = { ...(await bestQuote({ tokenIn, tokenOut, amountWei, from: activeAddress, slippage })), key, at: Date.now() };
        setQuote(q);
      }

      const needsApproval = Boolean(tokenIn.address);
      if (needsApproval) {
        const allowance = await publicClient.readContract({ address: tokenIn.address, abi: ERC20_ABI, functionName: 'allowance', args: [activeAddress, q.spender] }).catch(() => 0n);
        if (allowance < amountWei) {
          setTxStatus({ type: 'info', msg: `Step 1/2: approve ${tokenIn.symbol} in your wallet…`, hash: '' });
          const approveHash = await send({ to: tokenIn.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [q.spender, amountWei] }) });
          if (approveHash) await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
          const ok = await waitUntil(async () => (await publicClient.readContract({ address: tokenIn.address, abi: ERC20_ABI, functionName: 'allowance', args: [activeAddress, q.spender] })) >= amountWei);
          if (!ok) throw new Error('The approval did not confirm, try again');
        }
      }

      setTxStatus({ type: 'info', msg: needsApproval ? 'Step 2/2: confirm the swap in your wallet…' : 'Confirm the swap in your wallet…', hash: '' });
      const tx = await q.build();
      const before = balanceOut ?? 0n;
      const hash = await send(tx);
      setTxStatus({ type: 'info', msg: 'Swapping on Base…', hash: hash || '' });
      if (hash) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (receipt.status !== 'success') throw Object.assign(new Error('The swap reverted (the price moved more than your slippage). Nothing was swapped.'), { hash });
      } else {
        // smart wallet that reported no hash: wait until the received token arrives
        await waitUntil(async () => (await readTokenBalance(tokenOut, activeAddress)) > before);
      }
      setTxStatus({ type: 'success', msg: `Swapped via ${q.engine}`, hash: hash || '' });
      setFromAmountRaw('');
      setQuote(null);
      refreshBalances();
    } catch (err) {
      setTxStatus({
        type: 'error',
        msg: isWalletRejection(err) ? 'Transaction rejected in wallet' : `Swap failed: ${err?.shortMessage || err?.message || 'Error'}`,
        hash: err?.hash || '',
      });
    } finally {
      setSwapping(false);
    }
  };

  // why the swap button is disabled (null = ready)
  const blocker = useMemo(() => {
    if (!amountWei) return 'Enter an amount';
    if (insufficient) return `Insufficient ${tokenIn.symbol}`;
    if (isFetchingQuote && !liveQuote) return 'Finding the best price…';
    if (!liveQuote) return quoteError || 'No route';
    return null;
  }, [amountWei, insufficient, isFetchingQuote, liveQuote, quoteError, tokenIn]);

  return {
    authenticated, login, tokenIn, tokenOut, tokenList, addToken, selectToken,
    balanceIn: fmtBalance(balanceIn, tokenIn), balanceOut: fmtBalance(balanceOut, tokenOut), balancesLoading,
    fromAmount, setFromAmount, toAmount, slippage, setSlippage,
    isFetchingQuote, swapping, txStatus, fromUsd, toUsd, handlePercentage, handleToggleMode, handleSwap,
    blocker, engine: liveQuote?.engine || null,
  };
}
