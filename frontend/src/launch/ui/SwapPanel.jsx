// Buy and sell on the token page: an exact-in swap through the Universal Router on the launch pool, quoted
// live by Uniswap's V4Quoter (hook fee and anti-snipe included), with slippage and the anti-snipe warning.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Timer, Settings2 } from 'lucide-react';
import { formatUnits } from 'viem';
import { Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { parseAmount, formatAmount } from '../../place/format';
import { launchD, useSwapWallet, usePoolConfig, launchKeys } from '../hooks.js';
import { poolKey, swapDirection, quoteExactIn, withSlippage, swapCalls, antiSnipe, ETH, quoteAddress } from '../swap.js';
import { compact } from '../format.js';

const SLIPPAGES = [50, 100, 300, 1000];

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SwapPanel({ token }) {
  const d = launchD();
  const { address } = usePlaceAccount();
  const [side, setSide] = useState('buy');
  const [text, setText] = useState('');
  const [slippage, setSlippage] = useState(300);
  const [showSettings, setShowSettings] = useState(false);
  const now = useNow(1000);
  const tx = usePlaceTx();
  const wallet = useSwapWallet(address, token.address, token.quote.address);
  const hook = token.hook || d.hook;
  const pool = usePoolConfig(token.poolId, hook);

  const quoteSym = token.quote.symbol || 'quote';
  const q = quoteAddress(token.quote.address);
  const key = useMemo(() => poolKey(token.address, q, hook), [token.address, q, hook]);
  const dir = swapDirection({ key, side, token: token.address });
  const inDecimals = side === 'buy' ? token.quote.decimals : 18;
  const inSymbol = side === 'buy' ? quoteSym : token.symbol;
  const outSymbol = side === 'buy' ? token.symbol : quoteSym;
  const outDecimals = side === 'buy' ? 18 : token.quote.decimals;
  const amountIn = parseAmount(text, inDecimals);
  const balance = side === 'buy' ? wallet.data?.quote.balance : wallet.data?.token.balance;
  const short = amountIn != null && balance != null && amountIn > balance;

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

  const presets =
    side === 'buy'
      ? q === ETH
        ? ['0.001', '0.005', '0.01', '0.05']
        : ['1', '5', '10', '50']
      : [25, 50, 75, 100];

  const pick = (p) => {
    if (side === 'buy') setText(p);
    else if (balance) setText(formatUnits((balance * BigInt(p)) / 100n, 18));
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

  const label = !amountIn ? 'Enter an amount' : short ? `Not enough ${inSymbol}` : quote.isError ? 'No quote for this amount' : out == null ? 'Getting a quote...' : side === 'buy' ? `Buy ${token.symbol}` : `Sell ${token.symbol}`;

  return (
    <div className="card pl-launch-swap">
      <div className="pl-launch-swap-head">
        <div className="seg pl-launch-swap-sides" role="tablist" aria-label="Buy or sell">
          <button type="button" role="tab" aria-selected={side === 'buy'} className="buy" onClick={() => { setSide('buy'); setText(''); tx.reset(); }}>
            Buy
          </button>
          <button type="button" role="tab" aria-selected={side === 'sell'} className="sell" onClick={() => { setSide('sell'); setText(''); tx.reset(); }}>
            Sell
          </button>
        </div>
        <button type="button" className="pl-place-icon-btn" aria-label="Slippage settings" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
          <Settings2 size={15} />
        </button>
      </div>

      {showSettings && (
        <div className="pl-launch-swap-settings">
          <span className="pl-launch-field-label">Max slippage</span>
          <div className="seg soft">
            {SLIPPAGES.map((s) => (
              <button key={s} type="button" aria-selected={slippage === s} onClick={() => setSlippage(s)}>
                {s / 100}%
              </button>
            ))}
          </div>
        </div>
      )}

      {snipe && (
        <Alert tone="warn" icon={<Timer size={16} />}>
          Anti-snipe fee is <span className="mono">{snipe.feePct.toFixed(0)}%</span> right now. It falls to 1% in{' '}
          <span className="mono">{snipe.secondsLeft}s</span>, so waiting a few seconds gets you far more.
        </Alert>
      )}

      <div className="pl-launch-swap-box">
        <div className="pl-launch-swap-row">
          <span className="pl-launch-muted">You pay</span>
          <span className="pl-launch-muted">
            Balance <span className="mono">{balance != null ? compact(Number(formatUnits(balance, inDecimals))) : '—'}</span>
          </span>
        </div>
        <div className="pl-launch-swap-input">
          <input
            value={text}
            onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0.0"
            inputMode="decimal"
            aria-label={`Amount of ${inSymbol}`}
            className="mono"
          />
          <span className="pl-launch-swap-asset">{inSymbol}</span>
        </div>
        <div className="pl-launch-swap-presets">
          {presets.map((p) => (
            <button key={p} type="button" onClick={() => pick(p)} disabled={side === 'sell' && !balance}>
              {side === 'buy' ? `${p} ${quoteSym}` : p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="pl-launch-swap-box out">
        <div className="pl-launch-swap-row">
          <span className="pl-launch-muted">You get</span>
        </div>
        <div className="pl-launch-swap-input">
          <span className={`pl-launch-swap-out mono ${quote.isFetching && out == null ? 'pl-launch-muted' : ''}`}>
            {out != null ? formatAmount(out, outDecimals, { maxDecimals: 6 }) : amountIn && quote.isFetching ? '...' : '0.0'}
          </span>
          <span className="pl-launch-swap-asset">{outSymbol}</span>
        </div>
      </div>

      <dl className="pl-place-kv pl-launch-swap-kv">
        <div>
          <dt>Minimum received</dt>
          <dd className="mono">{minOut != null ? `${formatAmount(minOut, outDecimals, { maxDecimals: 6 })} ${outSymbol}` : '—'}</dd>
        </div>
        <div>
          <dt>Trading fee</dt>
          <dd>{snipe ? <span className="mono">{snipe.feePct.toFixed(0)}% (anti-snipe)</span> : '1%, in ' + quoteSym}</dd>
        </div>
        <div>
          <dt>Slippage</dt>
          <dd className="mono">{slippage / 100}%</dd>
        </div>
      </dl>

      {quote.isError && amountIn && <span className="pl-place-hint error">The pool can't fill this amount. Try a smaller one.</span>}

      {!address ? (
        <ConnectButton size="lg">Connect wallet to trade</ConnectButton>
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
