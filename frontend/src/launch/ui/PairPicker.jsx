// The pair picker of the launch form: a modal with search and Crypto / Stocks tabs over the factory's pairs.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Check, ChevronDown } from 'lucide-react';
import { EmptyState } from '../../themes/place/components/ui';
import { isTestnet } from '../../place/chain';
import { TokenLogo } from './parts.jsx';
import { pairIcon } from '../pairs.js';
import { usd, smallNumber } from '../format.js';

export function PairButton({ pair, onClick, disabled }) {
  return (
    <button type="button" className="pl-launch-pair-btn" onClick={onClick} disabled={disabled}>
      {pair ? (
        <>
          <TokenLogo token={{ symbol: pair.symbol }} src={pairIcon(pair)} size={28} shape="round" />
          <span className="pl-launch-pair-btn-main">
            <span className="pl-launch-strong">{pair.symbol}</span>
            <span className="pl-launch-muted">{pair.name}</span>
          </span>
        </>
      ) : (
        <span className="pl-launch-muted">Choose a pair</span>
      )}
      <ChevronDown size={16} className="pl-launch-pair-btn-chevron" />
    </button>
  );
}

export function PairPicker({ pairs, value, onPick, onClose }) {
  const [tab, setTab] = useState('crypto');
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return pairs.filter(
      (p) => p.category === tab && (!s || p.symbol?.toLowerCase().includes(s) || p.name?.toLowerCase().includes(s) || String(p.address).includes(s))
    );
  }, [pairs, tab, q]);
  // In the body: a transformed page (the Based slide-in) would make a fixed overlay scroll with the page.
  return createPortal(
    <div className="pw-theme pw-modal-overlay" onClick={onClose} role="presentation">
      <div className="pw-card pw-modal pl-launch-picker" role="dialog" aria-modal="true" aria-label="Choose a pair" onClick={(e) => e.stopPropagation()}>
        <div className="pl-launch-picker-head">
          <span className="pl-launch-picker-title">Pair asset</span>
          <button type="button" className="pl-place-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="pl-launch-picker-desc">Buyers pay in this asset, and your fees and holder rewards are paid in it too.</p>
        <label className="pl-launch-search">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ticker" aria-label="Search pairs" spellCheck={false} />
        </label>
        <div className="seg soft pl-launch-picker-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'crypto'} onClick={() => setTab('crypto')}>
            Crypto
          </button>
          <button type="button" role="tab" aria-selected={tab === 'stocks'} onClick={() => setTab('stocks')}>
            Stocks
          </button>
        </div>
        <div className="pl-launch-picker-list">
          {list.length ? (
            list.map((p) => (
              <button
                key={p.address}
                type="button"
                className="pl-launch-picker-item"
                aria-pressed={value === p.address}
                onClick={() => {
                  onPick(p.address);
                  onClose();
                }}
              >
                <TokenLogo token={{ symbol: p.symbol }} src={pairIcon(p)} size={32} shape="round" />
                <span className="pl-launch-picker-item-main">
                  <span className="pl-launch-strong">{p.symbol}</span>
                  <span className="pl-launch-muted">{p.name}</span>
                </span>
                <span className="pl-launch-picker-item-nums">
                  <span className="mono">{p.startFdvUsd != null ? usd(p.startFdvUsd) : `${smallNumber(p.startFdv)} ${p.symbol}`}</span>
                  <span className="pl-launch-muted">start MC · {p.launches} launches</span>
                </span>
                {value === p.address && <Check size={16} className="pl-launch-picker-check" />}
              </button>
            ))
          ) : (
            <EmptyState
              title={tab === 'stocks' ? 'No stock pairs here yet' : 'No pairs match'}
              description={
                tab === 'stocks' && isTestnet
                  ? 'Tokenized stocks live on Base mainnet. Stock pairs open with the mainnet launch.'
                  : 'Try another name or ticker.'
              }
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
