// Building blocks shared by the Place Launch pages: token logo, badges, price change, ages. Made from the
// design-system components (src/themes/place/components/ui) and launch.css.
import { useState } from 'react';
import { Badge } from '../../themes/place/components/ui';
import { useTokenMeta } from '../hooks.js';
import { imageUrl } from '../meta.js';
import { pct, isNew } from '../format.js';
import { CREATOR_FEE_PCT } from '../economy.js';

export const launchPath = () => '/launch';
export const launchTokenPath = (address) => `/launch/token/${String(address).toLowerCase()}`;
export const launchNewPath = () => '/launch/new';
export const consolePath = (section) => (section ? `/launch/profile/${section}` : '/launch/profile');

/** Two letters for tokens without a logo. */
const initials = (symbol, name) => String(symbol || name || '?').replace(/^\$/, '').slice(0, 2).toUpperCase();

/**
 * A token's logo from its contract URI, or its initials on a tinted plate. `src` overrides (form preview).
 * `shape`: 'round' (lists) or 'square' (cards and headers).
 */
export function TokenLogo({ token, src, size = 40, shape = 'square', className = '' }) {
  const { data: meta } = useTokenMeta(src ? null : token?.contractURI);
  const [broken, setBroken] = useState(null);
  const url = src || imageUrl(meta);
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) };
  const cls = `pl-launch-logo ${shape === 'round' ? 'round' : ''} ${className}`.trim();
  if (url && broken !== url) {
    return <img className={cls} style={style} src={url} alt="" loading="lazy" onError={() => setBroken(url)} />;
  }
  return (
    <span className={`${cls} empty`} style={style} aria-hidden="true">
      {initials(token?.symbol, token?.name)}
    </span>
  );
}

/** Big artwork for a token card: the logo filling the frame, or its initials. */
export function TokenArt({ token }) {
  const { data: meta } = useTokenMeta(token?.contractURI);
  const [broken, setBroken] = useState(false);
  const url = imageUrl(meta);
  if (url && !broken) return <img className="pl-launch-art-img" src={url} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return (
    <span className="pl-launch-art-empty" aria-hidden="true">
      {initials(token?.symbol, token?.name)}
    </span>
  );
}

export function KindBadge({ kind }) {
  return <Badge tone="neutral">{kind === 'b20' ? 'B20' : 'ERC-20'}</Badge>;
}

export function NewBadge({ createdAt, now }) {
  if (!isNew(createdAt, now)) return null;
  return <Badge tone="accent">New</Badge>;
}

/** "+12.4%" in green, "-3%" in red, "—" when unknown. */
export function Change({ value, className = '' }) {
  if (value == null) return <span className={`pl-launch-change ${className}`.trim()}>—</span>;
  const tone = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return <span className={`pl-launch-change mono ${tone} ${className}`.trim()}>{pct(value)}</span>;
}

/** A label above a mono value, for the compact numbers on cards and headers. */
export function Stat({ label, value, sub, className = '' }) {
  return (
    <div className={`pl-launch-stat ${className}`.trim()}>
      <span className="pl-launch-stat-label">{label}</span>
      <span className="pl-launch-stat-value mono">{value}</span>
      {sub != null && <span className="pl-launch-stat-sub">{sub}</span>}
    </div>
  );
}

/** The creator part of every trade as a stacked bar: burn, community fund, X accounts, the creator. */
export function EconomicsBar({ burn, fund, x = 0, you, youLabel = 'You' }) {
  const parts = [
    { key: 'burn', label: 'Burn', pct: burn },
    { key: 'fund', label: 'Community fund', pct: fund },
    { key: 'x', label: 'X accounts', pct: Math.round(x * 100) / 100 },
    { key: 'you', label: youLabel, pct: Math.round(you * 100) / 100 },
  ].filter((p) => p.pct > 0);
  return (
    <div className="pl-launch-econ-bar-wrap">
      <div className="pl-launch-econ-bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className={`pl-launch-econ-seg ${p.key}`} style={{ width: `${p.pct}%` }} />
        ))}
      </div>
      <div className="pl-launch-econ-legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i className={`pl-launch-econ-dot ${p.key}`} />
            {p.label} <span className="mono pl-launch-strong">{p.pct}%</span>
            <span className="pl-launch-muted mono"> · {Number(((p.pct / 100) * CREATOR_FEE_PCT).toFixed(4))}% of each trade</span>
          </span>
        ))}
      </div>
    </div>
  );
}

