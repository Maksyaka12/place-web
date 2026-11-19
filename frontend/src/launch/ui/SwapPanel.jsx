// Swap on the token page: You pay and You receive with token logos, balances and 20% / 50% / MAX,
// a flip button between them (buy or sell), Max slippage (Auto or a value) and the folded Trade details. An exact-in
// swap through the Universal Router on the launch pool, quoted live by Uniswap's V4Quoter. No tax or fee text here:
// the token's economics live on the Economy tab.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, ChevronDown, Timer } from 'lucide-react';
import { formatUnits } from 'viem';
import { Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { parseAmount, formatAmount } from '../../place/format';
import { launchD, useSwapWallet, usePoolConfig, launchKeys } from '../hooks.js';
import { poolKey, swapDirection, quoteExactIn, withSlippage, swapCalls, antiSnipe, ETH, quoteAddress } from '../swap.js';
import { pairIcon } from '../pairs.js';
import { compact, usd, price as priceText } from '../format.js';
import { TokenLogo } from './parts.jsx';

const AUTO_SLIPPAGE = 300; // 3%
const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH kept for gas on MAX

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AssetChip({ asset }) {
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

export function SwapPanel({ token }) {
  const d = launchD();
  const { address } = usePlaceAccount();
  const [side, setSide] = useState('buy');
  const [text, setText] = useState('');
  const [slippageText, setSlippageText] = useState('');
  const now = useNow(1000);
  const tx = usePlaceTx();
  const wallet = useSwapWallet(address, token.address, token.quote.address);
  const hook = token.hook || d.hook;
  const pool = usePoolConfig(token.poolId, hook);

  const quoteSym = token.quote.symbol || 'quote';
  const q = quoteAddress(token.quote.address);
  const key = useMemo(() => poolKey(token.address, q, hook), [token.address, q, hook]);
  const dir = swapDirection({ key, side, token: token.address });
  const pair = { symbol: quoteSym, decimals: token.quote.decimals, logo: <TokenLogo token={{ symbol: quoteSym }} src={pairIcon({ symbol: quoteSym }) || undefined} size={28} shape="round" /> };
  const self = { symbol: token.symbol, decimals: 18, logo: <TokenLogo token={token} size={28} shape="round" /> };
  const [inAsset, outAsset] = side === 'buy' ? [pair, self] : [self, pair];
  const amountIn = parseAmount(text, inAsset.decimals);
  const bal = { quote: wallet.data?.quote.balance, token: wallet.data?.token.balance };
  const [inBal, outBal] = side === 'buy' ? [bal.quote, bal.token] : [bal.token, bal.quote];
  const short = amountIn != null && inBal != null && amountIn > inBal;
  const custom = Number(slippageText);
  const slippage = slippageText && custom > 0 && custom <= 50 ? Math.round(custom * 100) : AUTO_SLIPPAGE;

  const debounced = useDebounced(amountIn ? amountIn.toString() : null, 350);
  const quote = useQuery({
    queryKey: [...launchKeys.all, 'quote', token.address, side, debounced],
    enabled: Boolean(debounced),
    refetchInterval: 8_000,
    retry: 0,
    queryFn: () => quoteExactIn(placeClient(), { quoter: d.v4Quoter, key, zeroForOne: dir.zeroForOne, amountIn: BigInt(debounced) }),
  });
  const out = debounced && amountIn && debounced === amountIn.toString() ? quote.data : null;
  const minOut = out != null ? withSlippage(out, slippage) : null;

  const snipe = pool.data?.antiSnipe ? antiSnipe({ launchTime: pool.data.launchTime, ...pool.data.antiSnipe, rateScale: pool.data.rateScale }, Math.floor(now / 1000)) : null;

  // USD value of an amount on either side (the pair's USD price, or the token's).
  const usdOf = (raw, asset) => {
    if (raw == null) return null;
    const n = Number(formatUnits(raw, asset.decimals));
    const unit = asset === pair ? token.quote.usd : token.priceUsd;
    return unit == null ? null : n * unit;
  };
  const shown = (raw, asset) => (raw == null ? '—' : compact(Number(formatUnits(raw, asset.decimals)), { decimals: 6 }));

  const pick = (pct) => {
    if (!inBal) return;
    let v = (inBal * BigInt(pct)) / 100n;
    if (pct === 100 && side === 'buy' && q === ETH) v = v > GAS_RESERVE ? v - GAS_RESERVE : 0n;
    setText(formatUnits(v, inAsset.decimals));
  };
  const flip = () => {
    setSide((s) => (s === 'buy' ? 'sell' : 'buy'));
    setText('');
    tx.reset();
  };

  const submit = async () => {
    if (!amountIn || minOut == null) return;
    const w = wallet.data;
    const calls = swapCalls({
      d,
      key,
      zeroForOne: dir.zeroForOne,
      amountIn,
      minOut,
      input: dir.input,
      output: dir.output,
      deadline: Math.floor(Date.now() / 1000) + 600,
      allowances: side === 'buy' ? w?.quote : w?.token,
      now: Math.floor(Date.now() / 1000),
      label: side === 'buy' ? `Buy ${token.symbol}` : `Sell ${token.symbol}`,
    });
    calls[calls.length - 1].preview = { action: `${side === 'buy' ? 'Buy' : 'Sell'} ${token.symbol}`, contract: d.universalRouter, method: 'execute' };
    const r = await tx.send(calls);
    if (r) setText('');
  };

  const label = !amountIn ? 'Enter amount' : short ? `Not enough ${inAsset.symbol}` : quote.isError ? 'No quote for this amount' : out == null ? 'Getting a quote...' : side === 'buy' ? `Buy ${token.symbol}` : `Sell ${token.symbol}`;
  const rate = token.priceUsd != null ? `1 ${token.symbol} = ${usd(token.priceUsd)} (${priceText(token.price, quoteSym)})` : `1 ${token.symbol} = ${priceText(token.price, quoteSym)}`;

  return (
    <div className="card pl-launch-swap">
      <span className="pl-launch-section-title">Swap</span>

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
            <AssetChip asset={inAsset} />
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
            <AssetChip asset={outAsset} />
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
          <span className="pl-launch-muted pl-launch-small">Max Slippage</span>
          <span className="pl-launch-inline">
            <button type="button" className={`pl-launch-swap-auto ${slippageText ? '' : 'on'}`.trim()} aria-pressed={!slippageText} onClick={() => setSlippageText('')}>
              Auto
            </button>
            <label className="pl-launch-swap-slip-input">
              <input
                value={slippageText}
                onChange={(e) => setSlippageText(e.target.value.replace(/[^\d.]/g, '').slice(0, 5))}
                placeholder={String(AUTO_SLIPPAGE / 100)}
                inputMode="decimal"
                aria-label="Max slippage in percent"
                className="mono"
              />
              %
            </label>
          </span>
        </div>
        <details className="pl-launch-swap-more">
          <summary>
            <span className="mono pl-launch-small">{rate}</span>
            <ChevronDown size={14} />
          </summary>
          <span className="pl-launch-field-label">Trade details</span>
          <dl className="pl-place-kv pl-launch-swap-kv">
            <div>
              <dt>Minimum received</dt>
              <dd className="mono">{minOut != null ? `${formatAmount(minOut, outAsset.decimals, { maxDecimals: 6 })} ${outAsset.symbol}` : 'N/A'}</dd>
            </div>
            <div>
              <dt>Max slippage</dt>
              <dd className="mono">{slippage / 100}%</dd>
            </div>
            <div>
              <dt>Route</dt>
              <dd>Place pool, Uniswap v4</dd>
            </div>
          </dl>
        </details>
      </div>

      {quote.isError && amountIn && <span className="pl-place-hint error">The pool can&apos;t fill this amount. Try a smaller one.</span>}

      {!address ? (
        <ConnectButton size="lg">Connect wallet</ConnectButton>
      ) : (
        <TxButton tx={tx} onClick={submit} size="lg" fullWidth disabled={!amountIn || short || minOut == null} busyLabel="Swapping on Base...">
          {label}
        </TxButton>
      )}
      {tx.busy && tx.step && <span className="pl-place-hint">Step: {tx.step}</span>}
      <TxResult tx={tx} success={side === 'buy' ? 'Bought' : 'Sold'} />
    </div>
  );
}
