// Building blocks shared by the Place Launch pages: token logo, badges, price change, ages. Made from the
// design-system components (src/themes/place/components/ui) and launch.css.
import { useState } from 'react';
import { ChevronDown, Clock, Settings2 } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import { useTokenMeta } from '../hooks.js';
import { imageUrl } from '../meta.js';
import { pct, isNew } from '../format.js';
import { BUCKETS } from '../economy.js';

export const launchPath = () => '/';
export const launchTokenPath = (address) => `/launch/token/${String(address).toLowerCase()}`;
export const launchNewPath = () => '/launch/new';
export const consolePath = (section) => (section ? `/profile/${section}` : '/profile');

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

/**
 * Shares of the buckets (creator, holders, traders, burn, community; % that add up to 100) as one bar with a legend.
 * `labels` renames buckets (0.2.0 calls the community pool the community fund).
 */
export function AllocationBar({ shares, labels = {}, legend = true }) {
  const parts = BUCKETS.filter((b) => Number(shares?.[b.id]) > 0);
  return (
    <div className="pl-econ-palette pl-launch-alloc">
      <div className="pl-launch-preview-bar" aria-hidden="true">
        {parts.map((b) => (
          <span key={b.id} className={`pl-econ-fill ${b.tone}`} style={{ width: `${shares[b.id]}%` }} />
        ))}
      </div>
      {legend && (
        <div className="pl-launch-econ-legend">
          {parts.map((b) => (
            <span key={b.id}>
              <i className={`pl-econ-dot ${b.tone}`} />
              {labels[b.id] || b.short} <span className="mono pl-launch-strong">{Number(Number(shares[b.id]).toFixed(2))}%</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** What a reward page shows instead of a manual button: the daily tables are made automatically after 00:00 UTC. */
export const READY_AFTER = 'Rewards for today will be ready after 00:00 UTC';

export function ReadyNote({ children = READY_AFTER }) {
  return (
    <span className="pl-launch-ready-note">
      <Clock size={13} /> {children}
    </span>
  );
}

/** A folded block for manual fallbacks of what Place runs on its own (closing a day, sharing royalties). */
export function Advanced({ title = 'Advanced', note, children }) {
  return (
    <details className="pl-launch-advanced">
      <summary>
        <Settings2 size={14} /> {title}
        <ChevronDown size={14} className="pl-launch-advanced-chevron" />
      </summary>
      <div className="pl-launch-advanced-body">
        {note && <p className="pl-launch-muted pl-launch-small">{note}</p>}
        {children}
      </div>
    </details>
  );
}
