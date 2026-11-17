// Shared pieces of the Rewards hub cards (vault look): filter pills with menus, the copyable ID, two
// overlapped logos, status and early-withdrawal badges, and the numbers of a staking vault.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import { formatAmount, shortAddress } from '../../place/format';
import { compact, smallNumber } from '../format.js';
import { TokenLogo } from './parts.jsx';
import { pairIcon } from '../pairs.js';

export const PHASE_LABEL = { live: 'Live', open: 'Open', upcoming: 'Upcoming', ended: 'Ended' };
export const PHASE_ORDER = { live: 0, open: 1, upcoming: 2, ended: 3 };
const YEAR = 365 * 86_400;

/** A raw amount as a plain number (for sorting and compact display). */
export const num = (raw, decimals, max = 4) => Number(formatAmount(raw ?? 0, decimals, { maxDecimals: max }).replace(/,/g, ''));
export const duration = (s) => (s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`);
export const aprText = (apr) => (apr == null ? 'N/A' : `${apr.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
export const shortId = (id) => `${id.slice(0, 8)}…${id.slice(-6)}`;

/** USD numbers of a staking vault: TVL, live APR (null = N/A), epochs done. */
export function vaultStats(p) {
  const staked = num(p.totalStaked, p.stakingToken.decimals, 8);
  const perEpoch = num(p.rewardPerEpoch, p.rewardToken.decimals, 8);
  const tvlUsd = p.stakingToken.usd != null ? staked * p.stakingToken.usd : null;
  let apr = null;
  if (p.status === 'ended') apr = 0;
  else if (tvlUsd > 0 && p.rewardToken.usd != null) apr = ((perEpoch * (YEAR / p.epochDuration) * p.rewardToken.usd) / tvlUsd) * 100;
  const done = p.status === 'ended' ? p.epochCount : p.status === 'live' ? Math.min(p.epochCount, (p.currentEpoch ?? 0) + 1) : 0;
  return { staked, tvlUsd, apr, done };
}

/** A logo for any token: a Place launch by its contract URI, a pair asset by its icon, else initials. */
export function AssetLogo({ token, size = 32 }) {
  return <TokenLogo token={token} src={token.contractURI ? undefined : pairIcon(token) || undefined} size={size} shape="round" />;
}

/** The target and the reward logos, overlapped. */
export function PairLogos({ a, b, size = 32 }) {
  return (
    <span className="pl-vault-logos" style={{ '--logo': `${size}px` }}>
      <AssetLogo token={a} size={size} />
      <AssetLogo token={b} size={size} />
    </span>
  );
}

export function PhaseBadge({ status }) {
  return (
    <Badge tone={status === 'live' ? 'success' : status === 'open' ? 'accent' : 'neutral'} pill>
      {PHASE_LABEL[status] || status}
    </Badge>
  );
}

export function Withdrawal({ p }) {
  return p.earlyExit ? <Badge tone="warn">{p.penaltyBps / 100}% penalty</Badge> : <Badge tone="danger">Forbidden</Badge>;
}

export function CopyId({ id, title = 'Copy ID' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="pl-vault-id"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="mono">{shortId(id)}</span>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** A pill that opens a list of options; `value` null = any (unless `anyLabel` is null). */
export function FilterMenu({ label, value, options, onChange, anyLabel = 'Any' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const current = options.find(([v]) => v === value);
  const pick = (v) => {
    onChange(v);
    setOpen(false);
  };
  return (
    <div ref={ref} className="pl-filter">
      <button type="button" className={`pl-filter-btn ${value != null && anyLabel ? 'on' : ''}`.trim()} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {current && anyLabel ? `${label}: ${current[1]}` : current ? current[1] : label}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="pl-topnav-menu pl-filter-menu" role="menu">
          {anyLabel && (
            <button type="button" role="menuitemradio" aria-checked={value == null} className="pl-topnav-menu-item" onClick={() => pick(null)}>
              {anyLabel}
              {value == null && <Check size={14} />}
            </button>
          )}
          {options.map(([v, text]) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={value === v} className="pl-topnav-menu-item" onClick={() => pick(v)}>
              {text}
              {value === v && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Cards or table, remembered per browser. */
export function useViewMode(key = 'place_vault_view') {
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(key) === 'table' ? 'table' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const pick = (v) => {
    setView(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // the choice just isn't remembered
    }
  };
  return [view, pick];
}

export const SOURCE_BADGE = {
  economy: ['Token economy', 'accent'],
  pool: ['Community Pool', 'accent'],
  creator: ['Creator', 'accent'],
  community: ['Community', 'neutral'],
};

/** A plain amount for cards: compact when large, leading zeros counted when tiny. */
export function amountText(raw, decimals) {
  const n = num(raw, decimals, 12);
  if (!n) return '0';
  if (n >= 10_000) return compact(n);
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return smallNumber(n);
}
export const sym = (t) => t?.symbol || shortAddress(t?.address);

/** What a stream asks of a wallet, short (cards) or long (detail). */
export function conditionText(s, long = false) {
  if (s.type === 'traders') {
    if (!s.quote || BigInt(s.criterion || 0) === 0n) return long ? 'Any buy or sell in the UTC day' : 'Any trade a day';
    return long ? `Buy and sell at least ${amountText(s.criterion, s.quote.decimals)} ${sym(s.quote)} in a UTC day` : `≥ ${amountText(s.criterion, s.quote.decimals)} ${sym(s.quote)} a day`;
  }
  if (s.type === 'nft') {
    const n = BigInt(s.criterion || 0) > 0n ? String(s.criterion) : '1';
    return long ? `Hold at least ${n} NFT${n === '1' ? '' : 's'} of ${sym(s.token)} at the end of the UTC day` : `≥ ${n} NFT`;
  }
  const min = amountText(s.criterion, s.token.decimals);
  return long ? `Hold at least ${min} ${sym(s.token)} at the end of the UTC day` : `≥ ${min} ${sym(s.token)}`;
}

