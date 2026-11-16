import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpDown, ChevronDown } from 'lucide-react';
import { isAddress } from 'viem';
import { Button } from './ui';
import { useSwap } from '../../../hooks/useSwap';
import { tokenKey } from '../../../config/tokens';

function TokenIcon({ token }) {
  if (token.icon) return <img src={token.icon} alt="" className="pl-swap-token-icon" />;
  return <span className="pl-swap-token-icon pl-swap-token-letter" aria-hidden="true">{token.symbol.slice(0, 1)}</span>;
}

/** Token pill that opens a list of known tokens plus a field for any token address on Base. */
function TokenPicker({ token, tokens, onSelect, addToken, label }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setAddress('');
    setError('');
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) close();
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const pick = (t) => {
    onSelect(t);
    close();
  };

  const addByAddress = async (e) => {
    e.preventDefault();
    if (!isAddress(address.trim())) {
      setError('Enter a token address (0x…)');
      return;
    }
    setBusy(true);
    setError('');
    try {
      pick(await addToken(address.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pw-select" ref={ref}>
      <button
        type="button"
        className="pl-swap-token-pill pl-swap-token-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${token.symbol}`}
      >
        <TokenIcon token={token} />
        <span>{token.symbol}</span>
        <ChevronDown size={14} className={`pw-select-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="pw-select-menu pl-swap-token-menu" role="listbox">
          <form className="pl-swap-token-add" onSubmit={addByAddress}>
            <input
              className="pl-swap-token-address mono"
              placeholder="Paste a token address"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setError('');
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !address.trim()}>
              {busy ? 'Checking…' : 'Add'}
            </Button>
          </form>
          {error && <div className="pl-swap-token-error">{error}</div>}
          {tokens.map((t) => (
            <button
              key={tokenKey(t)}
              type="button"
              role="option"
              aria-selected={tokenKey(t) === tokenKey(token)}
              className={`pw-select-item ${tokenKey(t) === tokenKey(token) ? 'on' : ''}`}
              onClick={() => pick(t)}
            >
              <TokenIcon token={t} />
              <span className="pw-select-text">
                <span className="pw-token-name">{t.symbol}</span>
                <span className="pw-muted">{t.name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SwapPanel() {
  const {
    authenticated, login, tokenIn, tokenOut, tokenList, addToken, selectToken, balanceIn, balanceOut, balancesLoading,
    fromAmount, setFromAmount, toAmount, slippage, setSlippage,
    isFetchingQuote, swapping, txStatus, fromUsd, toUsd, handlePercentage, handleToggleMode, handleSwap, blocker, engine,
  } = useSwap();

  return (
    <div className="pl-swap-card">
      <div className="pl-swap-header">
        <span className="pl-swap-title">{tokenIn.symbol} → {tokenOut.symbol}</span>

        <div className="pl-swap-slippage-wrap">
          <span className="pl-swap-slippage-label">Slippage</span>
          {[0.5, 1.0, 3.0].map((s) => (
            <button
              key={s}
              type="button"
              className={`pl-swap-slippage-btn ${slippage === s ? 'active' : ''}`}
              onClick={() => setSlippage(s)}
            >
              {s}%
            </button>
          ))}
        </div>
      </div>

      <div className="pl-swap-box">
        <div className="pl-swap-box-header">
          <span>You pay</span>
          <span className="pl-swap-box-balance">Balance: {balancesLoading && balanceIn === '0' ? '…' : `${balanceIn} ${tokenIn.symbol}`}</span>
        </div>

        <div className="pl-swap-input-row">
          <input
            type="text"
            inputMode="decimal"
            className="pl-swap-input"
            placeholder="0"
            value={fromAmount}
            onChange={(e) => setFromAmount(e.target.value)}
            aria-label={`Amount of ${tokenIn.symbol} to pay`}
          />
          <TokenPicker token={tokenIn} tokens={tokenList} onSelect={(t) => selectToken('in', t)} addToken={addToken} label="Pay with" />
        </div>

        <div className="pl-swap-box-footer">
          <span>{fromUsd}</span>
          <div className="pl-swap-presets">
            {[25, 50, 75, 100].map((p) => (
              <button key={p} type="button" className="pl-swap-preset-btn" onClick={() => handlePercentage(p)}>
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pl-swap-reverse-wrap">
        <button type="button" className="pl-swap-reverse-btn" onClick={handleToggleMode} title="Switch direction" aria-label="Switch direction">
          <ArrowUpDown size={16} />
        </button>
      </div>

      <div className="pl-swap-box">
        <div className="pl-swap-box-header">
          <span>You receive</span>
          <span className="pl-swap-box-balance">Balance: {balancesLoading && balanceOut === '0' ? '…' : `${balanceOut} ${tokenOut.symbol}`}</span>
        </div>

        <div className="pl-swap-input-row">
          <div className="pl-swap-input" style={{ color: toAmount ? 'var(--text)' : 'var(--text-3)' }}>
            {isFetchingQuote ? 'Calculating…' : (toAmount || '0')}
          </div>
          <TokenPicker token={tokenOut} tokens={tokenList} onSelect={(t) => selectToken('out', t)} addToken={addToken} label="Receive" />
        </div>

        <div className="pl-swap-box-footer">
          <span>{toUsd}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>Estimated</span>
        </div>
      </div>

      <div className="pl-swap-route-details">
        <div className="pl-swap-route-row">
          <span>Network cost</span>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>~0.0001 ETH</span>
        </div>
        <div className="pl-swap-route-row">
          <span>Routing engine</span>
          <span style={{ color: 'var(--text)' }}>{engine || 'Best of KyberSwap and LI.FI'}</span>
        </div>
      </div>

      {txStatus.msg && (
        <div className={`pl-swap-status is-${txStatus.type || 'info'}`}>
          <span>{txStatus.msg}</span>
          {txStatus.hash && (
            <a href={`https://basescan.org/tx/${txStatus.hash}`} target="_blank" rel="noreferrer">
              BaseScan ↗
            </a>
          )}
        </div>
      )}

      {!authenticated ? (
        <Button onClick={login} variant="primary" size="lg" fullWidth>
          Connect wallet
        </Button>
      ) : (
        <Button onClick={handleSwap} disabled={swapping || Boolean(blocker)} variant="primary" size="lg" fullWidth>
          {swapping ? 'Processing swap…' : blocker || `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`}
        </Button>
      )}
    </div>
  );
}
