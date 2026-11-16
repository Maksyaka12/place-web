import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAddress, formatUnits } from 'viem';
import { ArrowDownToLine, Send, ArrowLeftRight, Copy, Check, Bot, Wallet as WalletIcon, ChevronDown, X } from 'lucide-react';
import { useWalletAssets, TOKENS, tokenAmount } from '../../hooks/useWalletAssets';
import { isWalletRejection } from '../../config/walletTx';
import { FEATURES } from '../../config/features';
import './WalletPages.css';

// Wallet page shared by both themes (`theme` picks the palette): balances of the active wallet,
// switching between the main and the agent wallet (with FEATURES.agents), deposit, send and a shortcut to Swap.

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const usd = (n) => (n == null ? '…' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const amt = (n, symbol) => (n == null ? '…' : n.toLocaleString('en-US', { maximumFractionDigits: symbol === 'USDC' ? 2 : 5 }));

export function CopyButton({ value, size = 14 }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="pw-icon-btn"
      title="Copy address"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch (e) {}
      }}
    >
      {done ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

const PERCENTS = [25, 50, 100];
// keep a little ETH for gas when sending "Max" ETH
const ETH_GAS_RESERVE = 20_000_000_000_000n; // 0.00002 ETH

function useOutsideClose(open, onClose) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onClose]);
  return ref;
}

function TokenSelect({ value, onChange, balances }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutsideClose(open, close);
  const current = TOKENS.find((t) => t.symbol === value);
  return (
    <div className="pw-select" ref={ref}>
      <button type="button" className="pw-select-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <img src={current.icon} alt="" className="pw-select-icon" />
        <span>{current.symbol}</span>
        <ChevronDown size={14} className={`pw-select-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div className="pw-select-menu" role="listbox">
          {TOKENS.map((t) => (
            <button
              key={t.symbol}
              type="button"
              role="option"
              aria-selected={t.symbol === value}
              className={`pw-select-item ${t.symbol === value ? 'on' : ''}`}
              onClick={() => {
                onChange(t.symbol);
                setOpen(false);
              }}
            >
              <img src={t.icon} alt="" className="pw-select-icon" />
              <span className="pw-select-text">
                <span className="pw-token-name">{t.symbol}</span>
                <span className="pw-muted">{t.name}</span>
              </span>
              <span className="pw-select-bal">{amt(tokenAmount(t.symbol, balances?.[t.symbol]), t.symbol)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TransferForm({ assets, from, defaultTo = '', lockTo = false, quickTo = null, submitLabel, onDone }) {
  const [to, setTo] = useState(defaultTo);
  const [token, setToken] = useState('ETH');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const t = TOKENS.find((x) => x.symbol === token);
  const balances = assets.balancesOf(from);
  const raw = balances?.[token];
  const available = tokenAmount(token, raw);
  const num = Number(amount);
  const validTo = isAddress(to || '');
  const tooMuch = available != null && num > available;
  const canSend = validTo && num > 0 && !tooMuch && !busy && to.toLowerCase() !== from?.toLowerCase();

  const setPercent = (pct) => {
    if (raw == null) return;
    let value = (raw * BigInt(pct)) / 100n;
    if (token === 'ETH' && pct === 100) value = value > ETH_GAS_RESERVE ? value - ETH_GAS_RESERVE : 0n;
    if (value <= 0n) return setAmount('');
    const text = formatUnits(value, t.decimals);
    // exact for Max (no dust left), 6 decimals for the partial amounts
    setAmount(pct === 100 ? text : text.replace(/(\.\d{6})\d+$/, '$1'));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setNotice(null);
    try {
      await assets.send({ from, to, token, amount });
      setAmount('');
      setNotice({ ok: true, text: `Sent ${amount} ${token} to ${shortAddr(to)}` });
      onDone?.();
    } catch (err) {
      setNotice({ ok: false, text: isWalletRejection(err) ? 'Transaction cancelled' : (err?.shortMessage || err?.message || 'Transaction failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pw-form" onSubmit={submit}>
      {!lockTo && (
        <div className="pw-field">
          <span>
            Recipient
            {quickTo && (
              <button type="button" className="pw-link" onClick={() => setTo(quickTo.address)}>
                {quickTo.label}
              </button>
            )}
          </span>
          <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" spellCheck={false} aria-label="Recipient address" />
        </div>
      )}
      <div className="pw-field">
        <span>
          Amount
          {available != null && <span className="pw-muted">Balance {amt(available, token)} {token}</span>}
        </span>
        <div className="pw-amount">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            aria-label="Amount"
            onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))}
          />
          <TokenSelect value={token} onChange={(v) => { setToken(v); setAmount(''); }} balances={balances} />
        </div>
        <div className="pw-percents">
          {PERCENTS.map((p) => (
            <button key={p} type="button" className="pw-chip" onClick={() => setPercent(p)} disabled={!raw}>
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
        </div>
      </div>
      {to && !validTo && !lockTo && <div className="pw-notice err">Enter a valid Base address</div>}
      {tooMuch && <div className="pw-notice err">Not enough {token}</div>}
      <button type="submit" className="pw-btn pw-btn-primary pw-btn-full" disabled={!canSend}>
        {busy ? 'Confirming…' : submitLabel}
      </button>
      {notice && <div className={`pw-notice ${notice.ok ? 'ok' : 'err'}`}>{notice.text}</div>}
    </form>
  );
}

function Modal({ theme, title, onClose, children }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return createPortal(
    <div className={`pw-${theme} pw-modal-overlay`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pw pw-card pw-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pw-modal-head">
          <div className="pw-card-title">{title}</div>
          <button type="button" className="pw-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

// Deposit to `address`: its address to copy, and a transfer from the user's other wallet (`from`) when there is one.
export function DepositModal({ theme, assets, title, address, from, fromLabel, onClose }) {
  return (
    <Modal theme={theme} title={title} onClose={onClose}>
      <p className="pw-hint">Send ETH (needed for gas) or any token on the Base network to this address.</p>
      <div className="pw-address-box">
        <span className="pw-mono">{address}</span>
        <CopyButton value={address} />
      </div>
      {from && (
        <>
          <div className="pw-divider"><span>or move funds from your {fromLabel}</span></div>
          <TransferForm key={`deposit-${address}`} assets={assets} from={from} defaultTo={address} lockTo submitLabel={`Transfer from ${fromLabel}`} />
        </>
      )}
    </Modal>
  );
}

export default function WalletPage({ theme = 'dark', onSwap }) {
  const assets = useWalletAssets();
  const { mainAddress, agentAddress, hasAgentWallet, active, activeAddress, setActive, balancesOf, usdValue } = assets;
  const [panel, setPanel] = useState(null);
  const closePanel = useCallback(() => setPanel(null), []);

  if (!mainAddress) {
    return <div className={`pw pw-${theme}`}><div className="pw-card pw-empty">Log in to see your wallet.</div></div>;
  }

  const wallets = hasAgentWallet
    ? [
        { key: 'agent', name: 'Agent wallet', sub: 'Created at login · used by your agent', address: agentAddress, icon: <Bot size={18} /> },
        { key: 'main', name: 'Main wallet', sub: 'The wallet you connected', address: mainAddress, icon: <WalletIcon size={18} /> },
      ]
    : FEATURES.agents
      ? [{ key: 'main', name: 'Place wallet', sub: 'Created at login · used by you and your agent', address: mainAddress, icon: <Bot size={18} /> }]
      : [{ key: 'main', name: 'Main wallet', sub: 'The wallet you log in with', address: mainAddress, icon: <WalletIcon size={18} /> }];

  const activeWallet = wallets.find((w) => w.key === active) || wallets[0];
  const other = hasAgentWallet ? wallets.find((w) => w.key !== activeWallet.key) : null;
  const bal = balancesOf(activeAddress);

  return (
    <div className={`pw pw-${theme}`}>
      <div className="pw-card">
        <div className="pw-muted">Your balance</div>
        <div className="pw-total">{usd(usdValue(activeAddress))}</div>

        <div className="pw-section-label">{hasAgentWallet ? 'Active wallet' : 'Wallet'}</div>
        <div className="pw-wallets">
          {wallets.map((w) => {
            const on = w.key === activeWallet.key;
            return (
              <button
                key={w.key}
                type="button"
                className={`pw-wallet-row ${on ? 'on' : ''}`}
                onClick={() => hasAgentWallet && setActive(w.key)}
                disabled={!hasAgentWallet}
              >
                <span className="pw-wallet-icon">{w.icon}</span>
                <span className="pw-wallet-text">
                  <span className="pw-wallet-name">{w.name}{on && hasAgentWallet && <span className="pw-badge">Active</span>}</span>
                  <span className="pw-mono pw-muted">{shortAddr(w.address)}</span>
                </span>
                <span className="pw-wallet-value">{usd(usdValue(w.address))}</span>
              </button>
            );
          })}
        </div>
        {hasAgentWallet && (
          <p className="pw-hint">
            The site shows and acts with the active wallet. Each wallet is a separate participant with its own rewards.
          </p>
        )}
      </div>

      <div className="pw-card">
        <div className="pw-card-head">
          <div>
            <div className="pw-card-title">{activeWallet.name}</div>
            <div className="pw-address-line">
              <a className="pw-mono pw-muted" href={`https://basescan.org/address/${activeAddress}`} target="_blank" rel="noopener noreferrer">{shortAddr(activeAddress)}</a>
              <CopyButton value={activeAddress} />
            </div>
          </div>
        </div>
        <div className="pw-tokens">
          {TOKENS.map((t) => {
            const n = tokenAmount(t.symbol, bal?.[t.symbol]);
            return (
              <div key={t.symbol} className="pw-token-row">
                <img src={t.icon} alt="" className="pw-token-icon" />
                <div className="pw-token-text">
                  <span className="pw-token-name">{t.name}</span>
                  <span className="pw-muted">{t.symbol}</span>
                </div>
                <div className="pw-token-amount">
                  <span>{amt(n, t.symbol)}</span>
                  <span className="pw-muted">{n == null ? '' : `~ ${usd(n * (assets.prices[t.symbol] || 0))}`}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="pw-actions">
        <button type="button" className="pw-btn pw-btn-primary" onClick={() => setPanel('deposit')}>
          <ArrowDownToLine size={16} /> Deposit
        </button>
        <button type="button" className="pw-btn" onClick={() => setPanel('send')}>
          <Send size={16} /> Send
        </button>
        <button type="button" className="pw-btn" onClick={onSwap}>
          <ArrowLeftRight size={16} /> Swap
        </button>
      </div>

      {panel === 'deposit' && (
        <DepositModal
          theme={theme}
          assets={assets}
          title={`Deposit to ${activeWallet.name}`}
          address={activeAddress}
          from={other?.address}
          fromLabel={other?.key === 'main' ? 'main wallet' : 'agent wallet'}
          onClose={closePanel}
        />
      )}

      {panel === 'send' && (
        <Modal theme={theme} title={`Send from ${activeWallet.name}`} onClose={closePanel}>
          <TransferForm
            key={`send-${activeAddress}`}
            assets={assets}
            from={activeAddress}
            quickTo={other ? { label: `My ${other.key === 'main' ? 'main' : 'agent'} wallet`, address: other.address } : null}
            submitLabel="Send"
          />
        </Modal>
      )}
    </div>
  );
}
