// Swap on the token page: You pay and You receive with logos, balances and 20% / 50% / MAX, a flip button between
// them (buy or sell), an asset picker on the pair side ("Select an asset": ETH and USDC always, plus the paired stock
// or other pair), Max slippage with the Trade settings panel behind the gear (Auto / Custom, 1% / 3% / 10% or a
// value), and the folded Trade details (minimum received, trade fees, external pool fees, network fees, price impact).
// An exact-in swap through the Universal Router: the launch pool alone when paying with the pair, or one multi-hop
// swap through the pools the reward-token registry lists between the asset and the pair. Quoted live by Uniswap's
// V4Quoter; the slippage the panel shows is what goes into minAmountOut.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, Check, ChevronDown, Settings, Timer, TriangleAlert, X } from 'lucide-react';
import { formatEther, formatUnits } from 'viem';
import { Alert, Badge, InfoTip } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { parseAmount, formatAmount } from '../../place/format';
import { launchD, useSwapWallet, usePoolConfig, usePairs, launchKeys } from '../hooks.js';
import { poolKey, swapRoute, quoteRoute, withSlippage, swapCalls, antiSnipe, ETH, quoteAddress } from '../swap.js';
import { REWARD_TOKEN_REGISTRY_ABI } from '../abi.js';
import { pairIcon, pairCategory } from '../pairs.js';
import { tokenEconomy, tradePct } from '../economy.js';
import { compact, usd, pct, price as smallText } from '../format.js';
import { TokenLogo } from './parts.jsx';

const AUTO_DIRECT = 300; // 3% on the launch pool alone
const AUTO_ROUTED = 500; // 5% when the swap also crosses another pool
const PRESETS = [1, 3, 10];
const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH kept for gas on MAX
const ROUTER_GAS = 120_000n; // router, settle and take on top of the quoter's estimate
const HIGH_IMPACT = -5;
const VERY_HIGH_IMPACT = -15;
const BLOCK_IMPACT = -50;

const TIPS = {
  swap: 'Trade this token on its Uniswap v4 pool on Base. Pay with the paired asset directly, or with ETH or USDC through the pair.',
  slippage: 'The most the price may move against you before the swap reverts. Auto uses 3% on the token pool and 5% when the swap also crosses another pool.',
  minimum: 'The least you receive after slippage. If the pool would pay less, the swap reverts and you keep your funds.',
  tradeFees: "The token's own fee or tax on this trade, taken by the Place hook. It is already included in the quote.",
  external: 'Fees of the other pools the route crosses, such as ETH/USDC. Already included in the quote.',
  network: 'Estimated Base gas for this swap, paid in ETH by your wallet.',
  impact: 'How much this trade moves the price against you compared with a very small trade on the same route. Fees are not counted here.',
};

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Closes a popover on Escape or a click outside `ref`. */
function useDismiss(open, ref, close) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}

const assetLogo = (a, size = 28) => <TokenLogo token={{ symbol: a.symbol, name: a.name }} src={a.logo || undefined} size={size} shape="round" />;

/**
 * What the swap can pay with or pay out: ETH and USDC always, plus the pair when it is something else (a stock goes
 * into its own "Paired stock" group). Each with its USD price where known.
 */
function useSwapAssets(token) {
  const d = launchD();
  const pairs = usePairs().data?.pairs || [];
  const q = quoteAddress(token.quote.address);
  return useMemo(() => {
    const info = (addr) => pairs.find((p) => quoteAddress(p.address) === addr);
    const usdc = d.quotes?.usdc ? quoteAddress(d.quotes.usdc) : null;
    const list = [
      { address: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, usd: info(ETH)?.usd ?? (q === ETH ? token.quote.usd : null), group: 'crypto' },
      usdc && { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, usd: info(usdc)?.usd ?? 1, group: 'crypto' },
    ].filter(Boolean);
    if (!list.some((a) => a.address === q)) {
      const p = info(q);
      const symbol = token.quote.symbol || p?.symbol || 'PAIR';
      list.push({
        address: q,
        symbol,
        name: p?.name || token.quote.name || symbol,
        decimals: token.quote.decimals ?? p?.decimals ?? 18,
        usd: token.quote.usd ?? p?.usd ?? null,
        group: pairCategory(symbol) === 'stocks' ? 'stock' : 'crypto',
      });
    }
    return list.map((a) => ({ ...a, logo: pairIcon({ symbol: a.symbol }) }));
  }, [d, pairs, q, token.quote]);
}

/** The registry's pools between each asset and the pair, both ways (empty where there is no route). */
function useSwapRoutes(assets, pair) {
  const d = launchD();
  const others = assets.filter((a) => a.address !== pair).map((a) => a.address);
  return useQuery({
    queryKey: [...launchKeys.all, 'swap-routes', d.rewardTokenRegistry, pair, others.join(',')],
    enabled: Boolean(d.rewardTokenRegistry && others.length),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const contracts = others.flatMap((a) => [
        { address: d.rewardTokenRegistry, abi: REWARD_TOKEN_REGISTRY_ABI, functionName: 'routeOf', args: [a, pair] },
        { address: d.rewardTokenRegistry, abi: REWARD_TOKEN_REGISTRY_ABI, functionName: 'routeOf', args: [pair, a] },
      ]);
      const res = await placeClient().multicall({ contracts, allowFailure: true });
      const keys = (r) => (r.status === 'success' ? r.result : []);
      return Object.fromEntries(others.map((a, i) => [a, { buy: keys(res[i * 2]), sell: keys(res[i * 2 + 1]) }]));
    },
  });
}

/** The pair-side asset as a button that opens "Select an asset". */
function AssetPicker({ assets, value, onChange, routes, pair }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useDismiss(open, box, () => setOpen(false));
  const current = assets.find((a) => a.address === value) || assets[0];
  const groups = [
    ['crypto', 'Crypto and stablecoins'],
    ['stock', 'Paired stock'],
  ].map(([id, title]) => [title, assets.filter((a) => a.group === id)]);
  const noRoute = (a) => a.address !== pair && routes && !routes[a.address]?.buy?.length && !routes[a.address]?.sell?.length;
  return (
    <div className="pl-launch-swap-pick" ref={box}>
      <button type="button" className="pl-launch-swap-chip pick" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {assetLogo(current)}
        <span className="pl-launch-swap-chip-name">
          <span className="pl-launch-strong">{current.symbol}</span>
          <span className="pl-launch-muted pl-launch-small">Base</span>
        </span>
        <ChevronDown size={15} className="pl-launch-swap-chip-caret" />
      </button>
      {open && (
        <div className="pl-launch-swap-menu" role="listbox" aria-label="Select an asset">
          <div className="pl-launch-swap-menu-head">
            <span className="pl-launch-strong">Select an asset</span>
            <Badge tone="neutral">{assets.length} assets</Badge>
          </div>
          {groups.map(([title, list]) =>
            list.length ? (
              <div key={title} className="pl-launch-swap-menu-group">
                <span className="pl-launch-swap-menu-title">{title}</span>
                {list.map((a) => (
                  <button
                    key={a.address}
                    type="button"
                    role="option"
                    aria-selected={a.address === current.address}
                    className="pl-launch-swap-menu-item"
                    onClick={() => {
                      onChange(a.address);
                      setOpen(false);
                    }}
                  >
                    {assetLogo(a, 32)}
                    <span className="pl-launch-swap-menu-name">
                      <span className="pl-launch-strong">{a.symbol}</span>
                      <span className="pl-launch-muted pl-launch-small">{a.name}</span>
                    </span>
                    {noRoute(a) && <Badge tone="warn">No route</Badge>}
                    {a.address === current.address && <Check size={16} className="pl-launch-swap-menu-check" />}
                  </button>
                ))}
              </div>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

function StaticChip({ asset }) {
  return (
    <span className="pl-launch-swap-chip">
      {asset.logo}
      <span className="pl-launch-swap-chip-name">
        <span className="pl-launch-strong">{asset.symbol}</span>
        <span className="pl-launch-muted pl-launch-small">Base</span>
      </span>
    </span>
  );
}

/** Trade settings behind the gear: Auto / Custom, presets and a custom value. */
function TradeSettings({ auto, mode, setMode, customText, setCustomText, onClose }) {
  const box = useRef(null);
  useDismiss(true, box, onClose);
  const custom = Number(customText);
  const customOk = customText !== '' && custom > 0 && custom <= 50;
  return (
    <div className="pl-launch-swap-settings-panel" ref={box} role="dialog" aria-label="Trade settings">
      <div className="pl-launch-swap-settings-head">
        <span className="pl-launch-strong">Trade settings</span>
        <button type="button" className="pl-place-icon-btn" aria-label="Close trade settings" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <span className="pl-launch-swap-label">
        Max Slippage <InfoTip text={TIPS.slippage} label="About max slippage" />
      </span>
      <div className="seg pl-launch-swap-mode" role="tablist" aria-label="Slippage mode">
        <button type="button" role="tab" aria-selected={mode === 'auto'} onClick={() => setMode('auto')}>
          Auto <span className="mono">{auto / 100}%</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'custom'}
          onClick={() => {
            setMode('custom');
            if (!customOk) setCustomText(String(auto / 100));
          }}
        >
          Custom <span className="mono">{customOk ? `${custom}%` : '—'}</span>
        </button>
      </div>
      <div className="pl-launch-swap-slip-row">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="pl-launch-swap-preset"
            aria-pressed={mode === 'custom' && custom === p}
            onClick={() => {
              setMode('custom');
              setCustomText(String(p));
            }}
          >
            {p}%
          </button>
        ))}
        <label className={`pl-launch-swap-slip-input ${mode === 'custom' && !customOk ? 'error' : ''}`.trim()}>
          <input
            value={mode === 'custom' ? customText : ''}
            onChange={(e) => {
              setMode('custom');
              setCustomText(e.target.value.replace(/[^\d.]/g, '').slice(0, 5));
            }}
            placeholder={String(auto / 100)}
            inputMode="decimal"
            aria-label="Custom max slippage in percent"
            className="mono"
          />
          %
        </label>
      </div>
      {mode === 'custom' && customText !== '' && !customOk && <span className="pl-place-hint error">Use a value above 0% and up to 50%.</span>}
      {mode === 'custom' && customOk && custom > 15 && <span className="pl-place-hint">High slippage: the price may move a lot before your swap lands.</span>}
    </div>
  );
}

function DetailRow({ label, tip, children }) {
  return (
    <div>
      <dt>
        {label} <InfoTip text={tip} label={`About ${label.toLowerCase()}`} />
      </dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}

export function SwapPanel({ token }) {
  const d = launchD();
  const { address } = usePlaceAccount();
  const [side, setSide] = useState('buy');
  const [text, setText] = useState('');
  const [mode, setMode] = useState('auto');
  const [customText, setCustomText] = useState('');
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState(false);
  const now = useNow(1000);
  const tx = usePlaceTx();
  const hook = token.hook || d.hook;
  const pool = usePoolConfig(token.poolId, hook);
  const econ = tokenEconomy(token);

  const q = quoteAddress(token.quote.address);
  const assets = useSwapAssets(token);
  const routes = useSwapRoutes(assets, q);
  const usdc = assets.find((a) => a.symbol === 'USDC')?.address;
  const [assetAddr, setAssetAddr] = useState(() => (q === ETH || q === usdc || !usdc ? q : usdc));
  const asset = assets.find((a) => a.address === assetAddr) || assets.find((a) => a.address === q);
  const wallet = useSwapWallet(address, token.address, asset.address);

  const key = useMemo(() => poolKey(token.address, q, hook), [token.address, q, hook]);
  const hops = routes.data?.[asset.address]?.[side] || [];
  const route = useMemo(() => swapRoute({ key, side, token: token.address, pair: q, asset: asset.address, hops }), [key, side, token.address, q, asset.address, hops]);
  const routed = asset.address !== q;
  const routeLoading = routed && routes.isLoading;
  const unavailable = routed && !routeLoading && !route;

  const other = { ...asset, logo: assetLogo(asset) };
  const self = { symbol: token.symbol, decimals: 18, usd: token.priceUsd, logo: <TokenLogo token={token} size={28} shape="round" /> };
  const [inAsset, outAsset] = side === 'buy' ? [other, self] : [self, other];
  const amountIn = parseAmount(text, inAsset.decimals);
  const bal = { other: wallet.data?.quote.balance, token: wallet.data?.token.balance };
  const [inBal, outBal] = side === 'buy' ? [bal.other, bal.token] : [bal.token, bal.other];
  const short = amountIn != null && inBal != null && amountIn > inBal;

  const auto = routed ? AUTO_ROUTED : AUTO_DIRECT;
  const custom = Number(customText);
  const customOk = customText !== '' && custom > 0 && custom <= 50;
  const slippage = mode === 'custom' && customOk ? Math.round(custom * 100) : auto;

  const debounced = useDebounced(amountIn ? amountIn.toString() : null, 350);
  const quote = useQuery({
    queryKey: [...launchKeys.all, 'quote', token.address, side, asset.address, route?.kind === 'path' ? route.path.length : 1, debounced],
    enabled: Boolean(debounced && route),
    refetchInterval: 8_000,
    retry: 0,
    queryFn: async () => {
      const client = placeClient();
      const amount = BigInt(debounced);
      const ref = amount / 1000n;
      const [main, small] = await Promise.all([
        quoteRoute(client, { quoter: d.v4Quoter, route, amountIn: amount }),
        ref > 0n ? quoteRoute(client, { quoter: d.v4Quoter, route, amountIn: ref }).catch(() => null) : null,
      ]);
      // Price impact against a trade 1000 times smaller on the same route: fees are a percentage, so they cancel.
      const impact = small && small.amountOut > 0n ? ((Number(main.amountOut) / Number(amount)) / (Number(small.amountOut) / Number(ref)) - 1) * 100 : null;
      return { ...main, impact: impact != null ? Math.min(0, impact) : null };
    },
  });
  const gasPrice = useQuery({
    queryKey: [...launchKeys.all, 'gas-price'],
    queryFn: () => placeClient().getGasPrice(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const fresh = debounced && amountIn && debounced === amountIn.toString() ? quote.data : null;
  const out = fresh?.amountOut ?? null;
  const minOut = out != null ? withSlippage(out, slippage) : null;
  const impact = fresh?.impact ?? null;
  const networkFee = fresh && gasPrice.data ? (BigInt(fresh.gasEstimate) + ROUTER_GAS) * gasPrice.data : null;

  const snipe = pool.data?.antiSnipe ? antiSnipe({ launchTime: pool.data.launchTime, ...pool.data.antiSnipe, rateScale: pool.data.rateScale }, Math.floor(now / 1000)) : null;
  const tradeFee = snipe ? snipe.feePct : econ?.type === 'economy' ? (side === 'buy' ? econ.buyTax : econ.sellTax) : econ ? econ.buyTax : 1;
  const external = route?.external?.length ? route.external.map((f) => tradePct(f / 10_000)).join(' + ') : 'None';

  // USD value of an amount on either side.
  const usdOf = (raw, a) => (raw == null || a.usd == null ? null : Number(formatUnits(raw, a.decimals)) * a.usd);
  const shown = (raw, a) => (raw == null ? '—' : compact(Number(formatUnits(raw, a.decimals)), { decimals: 6 }));

  const pick = (p) => {
    if (!inBal) return;
    let v = (inBal * BigInt(p)) / 100n;
    if (p === 100 && side === 'buy' && asset.address === ETH) v = v > GAS_RESERVE ? v - GAS_RESERVE : 0n;
    setText(formatUnits(v, inAsset.decimals));
  };
  const flip = () => {
    setSide((s) => (s === 'buy' ? 'sell' : 'buy'));
    setText('');
    tx.reset();
  };
  const chooseAsset = (a) => {
    setAssetAddr(a);
    if (side === 'buy') setText('');
    tx.reset();
  };

  const submit = async () => {
    if (!amountIn || minOut == null || !route) return;
    const w = wallet.data;
    const calls = swapCalls({
      d,
      key,
      zeroForOne: route.zeroForOne,
      path: route.kind === 'path' ? route.path : undefined,
      amountIn,
      minOut,
      input: route.input,
      output: route.output,
      deadline: Math.floor(Date.now() / 1000) + 600,
      allowances: side === 'buy' ? w?.quote : w?.token,
      now: Math.floor(Date.now() / 1000),
      label: side === 'buy' ? `Buy ${token.symbol}` : `Sell ${token.symbol}`,
    });
    calls[calls.length - 1].preview = { action: `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`, contract: d.universalRouter, method: 'execute' };
    const r = await tx.send(calls);
    if (r) setText('');
  };

  const blocked = impact != null && impact <= BLOCK_IMPACT;
  const label = unavailable
    ? 'Route unavailable'
    : routeLoading
      ? 'Finding a route...'
      : !amountIn
        ? 'Enter amount'
        : short
          ? `Not enough ${inAsset.symbol}`
          : quote.isError
            ? 'No quote for this amount'
            : out == null
              ? 'Getting a quote...'
              : blocked
                ? 'Price impact too high'
                : side === 'buy'
                  ? `Buy ${token.symbol}`
                  : `Sell ${token.symbol}`;

  const picker = <AssetPicker assets={assets} value={asset.address} onChange={chooseAsset} routes={routes.data} pair={q} />;

  return (
    <div className="card pl-launch-swap">
      <div className="pl-launch-swap-title">
        <span className="pl-launch-section-title pl-launch-inline">
          Swap <InfoTip text={TIPS.swap} label="About swap" />
        </span>
        <button type="button" className="pl-launch-swap-gear" aria-label="Trade settings" aria-expanded={settings} onClick={() => setSettings((s) => !s)}>
          <Settings size={15} />
          <span className="mono">{slippage / 100}%</span>
        </button>
      </div>
      {settings && <TradeSettings auto={auto} mode={mode} setMode={setMode} customText={customText} setCustomText={setCustomText} onClose={() => setSettings(false)} />}

      {snipe && (
        <Alert tone="warn" icon={<Timer size={16} />}>
          Launch protection is on for <span className="mono">{snipe.secondsLeft}s</span>: trading right now costs far more. Wait a few seconds.
        </Alert>
      )}

      <div className="pl-launch-swap-pair">
        <div className="pl-launch-swap-box">
          <span className="pl-launch-muted pl-launch-small">You pay</span>
          <div className="pl-launch-swap-input">
            <input
              value={text}
              onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0"
              inputMode="decimal"
              aria-label={`Amount of ${inAsset.symbol}`}
              className="mono"
            />
            {side === 'buy' ? picker : <StaticChip asset={inAsset} />}
          </div>
          <div className="pl-launch-swap-row">
            <span className="pl-launch-muted pl-launch-small mono">{usd(usdOf(amountIn, inAsset) ?? 0)}</span>
          </div>
          <div className="pl-launch-swap-row">
            <span className="pl-launch-muted pl-launch-small">
              Balance: <span className="mono">{shown(inBal, inAsset)}</span>
            </span>
            <span className="pl-launch-swap-presets">
              {[20, 50, 100].map((p) => (
                <button key={p} type="button" onClick={() => pick(p)} disabled={!inBal}>
                  {p === 100 ? 'MAX' : `${p}%`}
                </button>
              ))}
            </span>
          </div>
        </div>
        <button type="button" className="pl-launch-swap-flip" aria-label={side === 'buy' ? 'Switch to selling' : 'Switch to buying'} onClick={flip}>
          <ArrowUpDown size={15} />
        </button>
        <div className="pl-launch-swap-box out">
          <span className="pl-launch-muted pl-launch-small">You receive</span>
          <div className="pl-launch-swap-input">
            <span className={`pl-launch-swap-out mono ${quote.isFetching && out == null ? 'pl-launch-muted' : ''}`}>
              {out != null ? formatAmount(out, outAsset.decimals, { maxDecimals: 6 }) : amountIn && quote.isFetching ? '...' : '0'}
            </span>
            {side === 'sell' ? picker : <StaticChip asset={outAsset} />}
          </div>
          <div className="pl-launch-swap-row">
            <span className="pl-launch-muted pl-launch-small mono">{usd(usdOf(out, outAsset) ?? 0)}</span>
          </div>
          <div className="pl-launch-swap-row">
            <span className="pl-launch-muted pl-launch-small">
              Balance: <span className="mono">{shown(outBal, outAsset)}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="pl-launch-swap-details">
        <div className="pl-launch-swap-slippage">
          <span className="pl-launch-swap-label">
            Max Slippage <InfoTip text={TIPS.slippage} label="About max slippage" />
          </span>
          <button type="button" className="pl-launch-swap-slip-value" onClick={() => setSettings(true)} aria-label="Change max slippage">
            {mode === 'auto' && <span className="pl-launch-swap-auto on">Auto</span>}
            <span className="mono">{slippage / 100}%</span>
          </button>
        </div>
        <button type="button" className="pl-launch-swap-more-toggle" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
          <span>Trade details</span>
          <ChevronDown size={15} />
        </button>
        {details && (
          <dl className="pl-launch-swap-kv">
            <DetailRow label="Minimum received" tip={TIPS.minimum}>
              {minOut != null ? `${formatAmount(minOut, outAsset.decimals, { maxDecimals: 6 })} ${outAsset.symbol}` : '—'}
            </DetailRow>
            <DetailRow label="Trade fees" tip={TIPS.tradeFees}>
              {tradePct(tradeFee)}
            </DetailRow>
            <DetailRow label="External pool fees" tip={TIPS.external}>
              {routeLoading ? '…' : unavailable ? '—' : external}
            </DetailRow>
            <DetailRow label="Network fees" tip={TIPS.network}>
              {networkFee != null ? `~${smallText(Number(formatEther(networkFee)), 'ETH')}` : '—'}
            </DetailRow>
            <DetailRow label="Price impact" tip={TIPS.impact}>
              <span className={impact != null && impact <= HIGH_IMPACT ? 'pl-launch-sell' : ''}>{impact != null ? pct(impact) : '—'}</span>
            </DetailRow>
          </dl>
        )}
      </div>

      {impact != null && impact <= VERY_HIGH_IMPACT && (
        <Alert tone="danger" icon={<TriangleAlert size={16} />}>
          Very high price impact (~{Math.abs(impact).toFixed(1)}%). Try a smaller amount.
          {blocked && <span className="pl-launch-swap-alert-more">This trade loses half or more versus the current price, so the swap is turned off. Try a smaller amount.</span>}
        </Alert>
      )}
      {impact != null && impact <= HIGH_IMPACT && impact > VERY_HIGH_IMPACT && (
        <Alert tone="warn" icon={<TriangleAlert size={16} />}>
          High price impact (~{Math.abs(impact).toFixed(1)}%). A smaller amount gets a better price.
        </Alert>
      )}
      {unavailable && (
        <Alert tone="warn" icon={<TriangleAlert size={16} />}>
          Place has no route between {asset.symbol} and {token.quote.symbol} yet. Pay with {token.quote.symbol} or pick another asset.
        </Alert>
      )}
      {quote.isError && amountIn && route && <span className="pl-place-hint error">The pool can&apos;t fill this amount. Try a smaller one.</span>}

      {!address ? (
        <ConnectButton size="lg">Connect wallet</ConnectButton>
      ) : (
        <TxButton tx={tx} onClick={submit} size="lg" fullWidth disabled={!amountIn || short || minOut == null || !route || blocked} busyLabel="Swapping on Base...">
          {label}
        </TxButton>
      )}
      {tx.busy && tx.step && <span className="pl-place-hint">Step: {tx.step}</span>}
      <TxResult tx={tx} success={side === 'buy' ? 'Bought' : 'Sold'} />
    </div>
  );
}
