import { useCallback, useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { ArrowLeftRight, Send, Bot, Infinity as InfinityIcon, RotateCcw } from 'lucide-react';
import { usePlaceWallets } from '../../hooks/usePlaceWallets';
import { TOKENS, tokenAmount, useWalletAssets } from '../../hooks/useWalletAssets';
import { CopyButton, shortAddr } from './WalletPage';
import './WalletPages.css';

// Settings of the agent wallet: what the agent may do and its daily caps for transfers to other addresses.
// Stored on the server (/api/agent/settings) and enforced on every agent action.

const PERMISSIONS = [
  { key: 'swaps', icon: ArrowLeftRight, title: 'Swaps', text: 'Swap any token on Base at the best route' },
  { key: 'transfers', icon: Send, title: 'Transfers to other addresses', text: 'Within the daily limits below' },
];

const fmt = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
const compact = (v) => Number(v).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const usd = (v) => `$${(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Switch({ on, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`pw-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} disabled={disabled}>
      <span />
    </button>
  );
}

export default function SettingsPage({ theme = 'dark', onOpenAgents }) {
  const { getAccessToken } = usePrivy();
  const { mainAddress, agentAddress, hasAgentWallet } = usePlaceWallets();
  const [data, setData] = useState(null);
  const [limits, setLimits] = useState({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);

  const assets = useWalletAssets();
  const [status, setStatus] = useState(null);

  const api = useCallback(async (method, body, path = '/api/agent/settings') => {
    const token = await getAccessToken();
    const res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }, [getAccessToken]);

  const apply = (d) => {
    setData(d);
    setLimits(d.limits);
  };

  useEffect(() => {
    if (!hasAgentWallet) return;
    api('GET').then(apply).catch((e) => setError(e.message));
    api('GET', null, '/api/agent/token').then(setStatus).catch(() => {});
  }, [hasAgentWallet, api]);

  const save = async (body, message) => {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      apply(await api('PUT', body));
      setSaved(message);
      setTimeout(() => setSaved(''), 2500);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!mainAddress) {
    return <div className={`pw pw-${theme}`}><div className="pw-card pw-empty">Log in to see your settings.</div></div>;
  }
  if (!hasAgentWallet) {
    return <div className={`pw pw-${theme}`}><div className="pw-card pw-empty">This account has no agent wallet, so there is nothing to set up yet.</div></div>;
  }

  // tokens with a daily cap for transfers to other addresses (the server decides which)
  const capped = data ? TOKENS.filter((t) => t.symbol in data.limits) : [];
  const dirty = data && capped.some((t) => String(limits[t.symbol] ?? '') !== String(data.limits[t.symbol]));
  const transfersOn = data?.allow.transfers;
  const enabled = Boolean(status?.signer && status?.hasKey);
  const ethLeft = tokenAmount('ETH', assets.balancesOf(agentAddress)?.ETH);

  return (
    <div className={`pw pw-${theme}`}>
      <div className="pw-agent-hero">
        <div className="pw-agent-hero-top">
          <span className={`pw-agent-avatar ${enabled ? 'on' : ''}`}><Bot size={24} /></span>
          <div className="pw-agent-id">
            <div className="pw-agent-name">
              Agent wallet
              {status && (
                <span className={`pw-agent-status ${enabled ? 'on' : ''}`}>
                  <i /> {enabled ? 'Agent active' : 'Agent off'}
                </span>
              )}
            </div>
            <div className="pw-address-line">
              <span className="pw-mono pw-muted">{shortAddr(agentAddress)}</span>
              <CopyButton value={agentAddress} />
            </div>
          </div>
        </div>
        <div className="pw-agent-stats">
          <div>
            <span>Balance</span>
            <b>{usd(assets.usdValue(agentAddress))}</b>
          </div>
          <div>
            <span>ETH for gas</span>
            <b>{ethLeft == null ? '…' : fmt(ethLeft)}</b>
          </div>
          <div>
            <span>Agent key</span>
            <b>{!status ? '…' : status.hasKey ? new Date(status.keyCreatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Not created'}</b>
          </div>
        </div>
        <div className="pw-agent-foot">
          <p>The rules below apply to everything your agent does. Your main wallet is never touched.</p>
          {onOpenAgents && (
            <button type="button" className="pw-agent-cta" onClick={onOpenAgents}>
              <Bot size={15} /> {enabled ? 'Agent Zone' : 'Enable agent'}
            </button>
          )}
        </div>
      </div>

      <div className="pw-card">
        <div className="pw-card-title">What your agent can do</div>
        <div className="pw-settings-list">
          {PERMISSIONS.map(({ key, icon: Icon, title, text }) => (
            <div key={key} className="pw-setting-row">
              <span className="pw-wallet-icon"><Icon size={17} /></span>
              <span className="pw-wallet-text">
                <span className="pw-wallet-name">{title}</span>
                <span className="pw-muted">{text}</span>
              </span>
              <Switch on={Boolean(data?.allow[key])} disabled={!data || busy} onChange={(v) => save({ allow: { [key]: v } }, 'Saved')} />
            </div>
          ))}
        </div>
      </div>

      <div className={`pw-card ${transfersOn === false ? 'pw-dim' : ''}`}>
        <div className="pw-card-head">
          <div className="pw-card-title">Daily limits for transfers</div>
          {data && (
            <button
              type="button"
              className="pw-icon-btn"
              title="Back to defaults"
              disabled={busy}
              onClick={() => save({ limits: data.defaults.limits }, 'Limits reset')}
            >
              <RotateCcw size={15} />
            </button>
          )}
        </div>
        <p className="pw-hint">
          The most your agent can send to other addresses per day (resets at 00:00 UTC). Set 0 to block a token. Other tokens can go only to your main wallet.
        </p>
        <div className="pw-main-free">
          <InfinityIcon size={15} /> <span>To your main wallet{mainAddress && <> <span className="pw-mono">{shortAddr(mainAddress)}</span></>}: no limit</span>
        </div>
        {data ? (
          <div className="pw-limits">
            {capped.map((t) => {
              const cap = Number(data.limits[t.symbol]) || 0;
              const spent = Number(data.spentToday[t.symbol]) || 0;
              const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
              return (
                <div key={t.symbol} className="pw-limit">
                  <div className="pw-limit-head">
                    <img src={t.icon} alt="" className="pw-token-icon" />
                    <span className="pw-wallet-name">{t.symbol}</span>
                  </div>
                  <div className="pw-limit-bar"><span style={{ width: `${pct}%` }} /></div>
                  <span className="pw-muted pw-limit-used">Sent today: {compact(spent)} of {compact(cap)}</span>
                  <label className="pw-field">
                    <span>Per day <span className="pw-muted">max {compact(data.max[t.symbol])}</span></span>
                    <input
                      inputMode="decimal"
                      value={limits[t.symbol] ?? ''}
                      onChange={(e) => setLimits((l) => ({ ...l, [t.symbol]: e.target.value.replace(',', '.').replace(/[^\d.]/g, '') }))}
                      disabled={busy}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        ) : (
          !error && <div className="pw-muted">Loading…</div>
        )}
        {data && (
          <button type="button" className="pw-btn pw-btn-primary pw-btn-full" disabled={!dirty || busy} onClick={() => save({ limits }, 'Limits saved')}>
            {busy ? 'Saving…' : 'Save limits'}
          </button>
        )}
      </div>

      {saved && <div className="pw-notice ok">{saved}</div>}
      {error && <div className="pw-notice err">{error}</div>}
    </div>
  );
}
