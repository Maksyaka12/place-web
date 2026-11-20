// The layout of an open reward in the Rewards hub (a staking vault on /staking?program=, a stream on /hub?stream=),
// after the vault page of a trading terminal: the head (two logos, "Stake X · Earn Y", status, ID, source), a row of
// metrics, two asset cards (what you stake / hold / trade and what you earn), the schedule in UTC, the details with
// a one-line rule, and on the right a sticky "My position" panel. Styles: `.pl-vd-*` in styles/rewards.css.
import { Link } from 'react-router-dom';
import { Clock, Flag, Play, ShieldAlert } from 'lucide-react';
import { Badge, InfoTip } from '../../themes/place/components/ui';
import { AddressLink } from '../../themes/place/pages/place/parts';
import { formatUtc } from '../../place/format';
import { usd } from '../format.js';
import { launchTokenPath, CopyInline } from './parts.jsx';
import { PairLogos, PhaseBadge, CopyId, AssetLogo, amountText, sym, SOURCE_BADGE } from './vaults.jsx';

export function VaultLayout({ top, main, side }) {
  return (
    <>
      <div className="pl-vd-top">{top}</div>
      <div className="pl-vd">
        <div className="pl-vd-main">{main}</div>
        <aside className="pl-vd-side">{side}</aside>
      </div>
    </>
  );
}

export function VaultHead({ a, b, title, status, id, idTitle, source }) {
  const [label, tone] = SOURCE_BADGE[source] || [source, 'neutral'];
  return (
    <div className="pl-vd-head">
      <PairLogos a={a} b={b} size={48} />
      <div className="pl-vd-title">
        <div className="pl-vd-title-row">
          <h1 className="pl-vault-detail-title">{title}</h1>
          <PhaseBadge status={status} />
          {source && <Badge tone={tone}>{label}</Badge>}
        </div>
        <CopyId id={id} title={idTitle} />
      </div>
    </div>
  );
}

/** The row of numbers under the head: [{ label, value, sub, tip }]; `value` may be a node. */
export function Metrics({ items }) {
  return (
    <dl className="pl-vd-metrics">
      {items.filter(Boolean).map((m) => (
        <div key={m.label}>
          <dt>
            {m.label}
            {m.tip && <InfoTip text={m.tip} size={12} />}
          </dt>
          <dd className={[typeof m.value === 'string' ? 'mono' : '', m.small ? 'pl-vd-small' : ''].join(' ').trim() || undefined}>{m.value}</dd>
          {m.sub && <dd className="pl-vd-sub mono">{m.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** A token (or collection) with its address, and one total under a line. */
export function AssetCard({ label, token, placeToken, href, totalLabel, total, totalUsd }) {
  const address = token.address === 'eth' ? null : token.address;
  return (
    <div className="pl-vd-card">
      <div className="pl-vd-asset">
        <AssetLogo token={token} size={40} />
        <div className="pl-launch-launch-title">
          <span className="pl-launch-muted pl-launch-small">{label}</span>
          {placeToken || href ? (
            <Link className="pl-launch-strong pl-vd-asset-name" to={href || launchTokenPath(token.address)}>
              {sym(token)}
            </Link>
          ) : (
            <span className="pl-launch-strong pl-vd-asset-name">{sym(token)}</span>
          )}
          {address ? (
            <span className="pl-launch-inline start pl-launch-small">
              <AddressLink address={address} />
              <CopyInline value={address} />
            </span>
          ) : (
            <span className="pl-launch-muted pl-launch-small">Native ETH</span>
          )}
        </div>
      </div>
      {total != null && (
        <div className="pl-vd-card-total">
          <span className="pl-launch-muted pl-launch-small">{totalLabel}</span>
          <span className="mono pl-launch-strong">{total}</span>
          {totalUsd != null && <span className="mono pl-launch-muted pl-launch-small">{usd(totalUsd)}</span>}
        </div>
      )}
    </div>
  );
}

const ICON = [Play, Clock, Flag];

/** Moments on one line, placed by time, the part already passed filled: [{ label, at }] (at: ISO or null = no end). */
export function Schedule({ points, now }) {
  const times = points.map((p) => (p.at ? new Date(p.at).getTime() : null));
  const first = times[0];
  // No end: put "now" at about 70% of the line, so the open end still reads as ahead.
  const last = times[times.length - 1] ?? Math.max(first + 1, now + (now - first) * 0.4);
  const span = Math.max(1, last - first);
  const pos = (t) => (t == null ? 100 : Math.min(100, Math.max(0, ((t - first) / span) * 100)));
  const fill = pos(now);
  return (
    <div className="pl-vd-schedule">
      <div className="pl-vd-track" aria-hidden="true">
        <span className="pl-vd-fill" style={{ width: `${fill}%` }} />
        {points.map((p, i) => {
          const Icon = ICON[points.length === 2 && i === 1 ? 2 : i] || Flag;
          const at = pos(times[i]);
          return (
            <span key={p.label} className={`pl-vd-dot ${now >= (times[i] ?? Infinity) ? 'done' : ''}`.trim()} style={{ left: `${at}%` }}>
              <Icon size={12} />
            </span>
          );
        })}
        {fill > 0 && fill < 100 && <span className="pl-vd-now" style={{ left: `${fill}%` }} />}
      </div>
      <div className="pl-vd-moments">
        {points.map((p) => (
          <div key={p.label}>
            <span className="pl-launch-muted pl-launch-small">{p.label}</span>
            <span className="mono pl-launch-strong">{p.at ? formatUtc(p.at) : 'No end'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Two-column facts: [{ label, value }]. */
export function Details({ items }) {
  return (
    <dl className="pl-vd-details">
      {items.filter(Boolean).map((d) => (
        <div key={d.label}>
          <dt>{d.label}</dt>
          <dd>{d.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The one rule to know, on one line. */
export function RuleNote({ children }) {
  return (
    <div className="pl-vd-rule">
      <ShieldAlert size={15} />
      <span>{children}</span>
    </div>
  );
}

/** A number of the position panel. */
export function PositionStat({ label, raw, token }) {
  return (
    <div>
      <span className="pl-launch-muted pl-launch-small">{label}</span>
      <span className="mono pl-launch-strong">
        {raw == null ? '—' : amountText(raw, token.decimals)} {raw == null ? '' : sym(token)}
      </span>
    </div>
  );
}
