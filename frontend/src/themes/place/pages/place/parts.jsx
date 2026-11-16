// Building blocks shared by the Place pages: status badges, amounts, addresses, the campaign card and the
// transaction button with its result. Everything is made from the design-system components (ui/index.jsx).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePrivy } from '@privy-io/react-auth';
import { Loader2, ExternalLink, CheckCircle2, AlertTriangle, Copy, Check, Image as ImageIcon, Search } from 'lucide-react';
import { isAddress } from 'viem';
import { Button, Alert, StatusPill } from '../../components/ui';
import { useCampaignMeta, useNow } from '../../../../place/hooks';
import { explorerAddress, explorerTx } from '../../../../place/chain';
import { formatAmount, formatToken, shortAddress, countdown, formatUtc, ipfsUrl, assetLabel, STATUS_LABEL, STATUS_TONE } from '../../../../place/format';

export const campaignPath = (c) => `/campaign/${c.hub}/${c.id}`;
export const tokenPath = (address) => `/token/${address}`;

export function StatusBadge({ status }) {
  return <StatusPill status={status} tone={STATUS_TONE[status] || 'neutral'} label={STATUS_LABEL[status] || status} />;
}

export function Amount({ raw, meta, compact, maxDecimals }) {
  return <span className="mono">{formatToken(raw, meta, { compact, maxDecimals })}</span>;
}

export function AddressLink({ address, full = false, label }) {
  if (!address) return <span className="pl-place-muted">—</span>;
  return (
    <a className="pl-place-link mono" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer" title={address}>
      {label || (full ? address : shortAddress(address))}
      <ExternalLink size={12} />
    </a>
  );
}

export function CopyAddress({ address }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  return (
    <button
      type="button"
      className="pl-place-icon-btn"
      aria-label="Copy address"
      onClick={() => {
        navigator.clipboard?.writeText(address);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** What a campaign is called: its metadata name, else "<SYMBOL> holder rewards". */
export function campaignTitle(c, meta) {
  if (meta?.name) return meta.name;
  const asset = assetLabel(c.targetMeta, c.target);
  return c.kind === 'nft-holders' ? `${asset} NFT holder rewards` : `${asset} holder rewards`;
}

/** The next moment that matters for a campaign, with its label. */
export function campaignMoment(c) {
  switch (c.status) {
    case 'scheduled':
      return { label: 'Snapshot in', at: c.snapshotAt };
    case 'snapshotting':
      return { label: 'Snapshot taken', at: c.snapshotAt, past: true };
    case 'refundable':
      return { label: 'Refundable since', at: c.refundableAt, past: true };
    case 'live':
      return { label: 'Claim ends in', at: c.claimEnd };
    default:
      return { label: 'Ended', at: c.claimEnd || c.snapshotAt, past: true };
  }
}

export function Moment({ c }) {
  const now = useNow(1000);
  const m = campaignMoment(c);
  return (
    <span className="pl-place-moment">
      <span className="pl-place-muted">{m.label}</span>{' '}
      <span className="mono">{m.past ? formatUtc(m.at) : countdown(m.at, now)}</span>
    </span>
  );
}

export function Banner({ meta, alt }) {
  const [broken, setBroken] = useState(false);
  const src = !broken && meta?.image ? ipfsUrl(meta.image) : '/placeholders/banner.png';
  return <img className="pl-campaign-card-img" src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} />;
}

export function CampaignCard({ c }) {
  const { data: meta } = useCampaignMeta(c);
  const title = campaignTitle(c, meta);
  return (
    <Link to={campaignPath(c)} className="card card-hover pl-place-card" data-testid="campaign-card">
      <div className="pl-campaign-card pl-place-card-banner">
        <Banner meta={meta} alt="" />
        <div className="pl-campaign-card-overlay" />
        <div className="pl-campaign-card-badge">
          <StatusBadge status={c.status} />
        </div>
        <div className="pl-campaign-card-title">{title}</div>
      </div>
      <div className="pl-place-card-body">
        <div className="pl-place-card-pool">
          <span className="pl-place-muted">Pool</span>
          <Amount raw={c.pool} meta={c.rewardMeta} compact />
        </div>
        <div className="pl-place-card-line">
          <span className="pl-place-muted">{c.kind === 'nft-holders' ? 'NFT holders of' : 'Holders of'}</span>{' '}
          <span className="pl-place-strong">{assetLabel(c.targetMeta, c.target)}</span>
        </div>
        <Moment c={c} />
      </div>
    </Link>
  );
}

export function TokenIcon({ meta, address, size = 40 }) {
  const label = assetLabel(meta, address).replace(/^\$/, '');
  return (
    <span className="pl-place-token-icon" style={{ width: size, height: size }} aria-hidden="true">
      {label.slice(0, 2).toUpperCase() || <ImageIcon size={16} />}
    </span>
  );
}

/**
 * A button for an on-chain action with the design's transaction states (DESIGN.md §8): spinner and a short
 * label while the wallet or the chain works, then the result under it.
 */
export function TxButton({ tx, onClick, children, busyLabel, variant = 'primary', size, fullWidth, disabled }) {
  const label = tx.status === 'wallet' ? 'Confirm in your wallet...' : tx.status === 'pending' ? busyLabel || 'Waiting for Base...' : children;
  return (
    <Button variant={variant} size={size} fullWidth={fullWidth} disabled={disabled || tx.busy} onClick={onClick}>
      {tx.busy && <Loader2 size={16} className="spin" />}
      {label}
    </Button>
  );
}

export function TxResult({ tx, success = 'Done' }) {
  if (tx.status === 'success') {
    return (
      <Alert tone="success" icon={<CheckCircle2 size={16} />}>
        {success}.{' '}
        {tx.hash && (
          <a className="pl-place-link" href={explorerTx(tx.hash)} target="_blank" rel="noopener noreferrer">
            View on Basescan <ExternalLink size={12} />
          </a>
        )}
      </Alert>
    );
  }
  if (tx.status === 'error') {
    return (
      <Alert tone="danger" icon={<AlertTriangle size={16} />}>
        {tx.error}
      </Alert>
    );
  }
  return null;
}

export function ConnectButton({ children = 'Connect wallet', size }) {
  const { login } = usePrivy();
  return (
    <Button variant="primary" size={size} onClick={login}>
      {children}
    </Button>
  );
}

/** "Check another wallet": an address field that reports a valid address to `onCheck`. */
export function AddressLookup({ onCheck, initial = '', placeholder = 'Wallet address, 0x...' }) {
  const [value, setValue] = useState(initial);
  const valid = isAddress(value.trim(), { strict: false });
  return (
    <form
      className="pl-place-lookup"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onCheck(value.trim().toLowerCase());
      }}
    >
      <input
        className="pl-place-input mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Wallet address"
        spellCheck={false}
      />
      <Button type="submit" disabled={!valid}>
        <Search size={15} />
        Check
      </Button>
    </form>
  );
}

export function QueryError({ error, retry }) {
  return (
    <Alert tone="danger" icon={<AlertTriangle size={16} />} action={retry && <Button size="sm" onClick={() => retry()}>Try again</Button>}>
      {error?.message || 'Something went wrong'}
    </Alert>
  );
}

export function Skeleton({ height = 120, count = 1, className = '' }) {
  return Array.from({ length: count }, (_, i) => <div key={i} className={`pl-place-skeleton ${className}`.trim()} style={{ height }} />);
}

export { formatAmount, formatUtc, shortAddress };
