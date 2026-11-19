// Building blocks shared by the Place Launch pages: token logo, badges, price change, ages. Made from the
// design-system components (src/themes/place/components/ui) and launch.css.
import { useEffect, useState } from 'react';
import { ChevronDown, Clock, Settings2, Star, Copy, Check } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import { useTokenMeta } from '../hooks.js';
import { imageUrl } from '../meta.js';
import { pct, isNew, age } from '../format.js';
import { pairIcon } from '../pairs.js';
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

// ─────────────── launchpad list pieces: pair chip, Tax badge, watchlist star, market-cap scale ───────────────

/** True for an Economy token (it has a buy and a sell tax). */
export const isEconomy = (t) => (t?.economics?.launchType ?? t?.launchType) === 'economy';

/** The pair asset as a chip with its logo: "ETH", or "Base / ETH" with `chain`. */
export function PairChip({ quote, chain = false, size = 16 }) {
  const symbol = quote?.symbol || 'Pair';
  return (
    <span className="pl-launch-pair-chip">
      {chain && <span className="pl-launch-chain-dot" aria-hidden="true" />}
      {chain && <span>Base</span>}
      {chain && <span className="pl-launch-muted">/</span>}
      {!chain && <TokenLogo token={{ symbol }} src={pairIcon({ symbol }) || undefined} size={size} shape="round" />}
      <span>{symbol}</span>
    </span>
  );
}

/** The Tax badge of an Economy token (amber, like a rule to know). */
export function TaxBadge({ token }) {
  if (!isEconomy(token)) return null;
  return <Badge tone="warn">Tax</Badge>;
}

const WATCH_KEY = 'place_launch_watchlist';
const readWatch = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'));
  } catch {
    return new Set();
  }
};
const listeners = new Set();

/** Starred tokens of this browser (localStorage, shared by every list on the page). */
export function useWatchlist() {
  const [set, setSet] = useState(readWatch);
  useEffect(() => {
    const on = () => setSet(readWatch());
    listeners.add(on);
    return () => listeners.delete(on);
  }, []);
  const toggle = (address) => {
    const next = readWatch();
    const a = String(address).toLowerCase();
    if (next.has(a)) next.delete(a);
    else next.add(a);
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify([...next]));
    } catch {
      // not remembered in this browser
    }
    listeners.forEach((l) => l());
  };
  return { has: (a) => set.has(String(a).toLowerCase()), toggle, size: set.size };
}

/** The star that adds a token to the watchlist; it never opens the card it sits on. */
export function StarButton({ address, watch }) {
  const on = watch.has(address);
  return (
    <button
      type="button"
      className={`pl-launch-star ${on ? 'on' : ''}`.trim()}
      aria-label={on ? 'Remove from watchlist' : 'Add to watchlist'}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        watch.toggle(address);
      }}
    >
      <Star size={15} />
    </button>
  );
}

/** Copy a value from inside a clickable card without opening it. */
export function CopyInline({ value, label = 'Copy address' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="pl-launch-copy-inline"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** Market cap on a log scale from $10K to $10M, 0..1 (null without a USD value). */
export function mcScale(usdValue) {
  if (usdValue == null || !(usdValue > 0)) return null;
  return Math.min(1, Math.max(0, (Math.log10(usdValue) - 4) / 3));
}

/** The small horizontal market-cap bar of grid cards and table rows. */
export function McBar({ usdValue }) {
  const v = mcScale(usdValue);
  if (v == null) return null;
  return (
    <span className="pl-launch-mcbar" title="Market cap on a $10K to $10M scale" aria-hidden="true">
      <span style={{ width: `${Math.max(4, v * 100)}%` }} />
    </span>
  );
}

/** "23h ago", "yesterday", "3mo ago". */
export function agoText(date, now) {
  const a = age(date, now);
  if (a === '—') return a;
  if (/^1d$/.test(a)) return 'yesterday';
  return `${a} ago`;
}
