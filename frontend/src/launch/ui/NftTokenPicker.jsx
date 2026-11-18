// Token pickers of Launch NFT: the pair token and the holders' reward token. The look of the pair picker (Crypto /
// Stocks / Majors tabs, search, logos), over the options of `launch/nft/pairs`. Pasting an address checks that token
// (`launch/nft/pair`): a Place token or a token with a swap route can be picked; any other token gets the reason and
// a link to Register token.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isAddress } from 'viem';
import { Search, X, Check, ChevronDown, AlertTriangle, BadgeCheck, Loader2 } from 'lucide-react';
import { Alert, Badge, Button, EmptyState } from '../../themes/place/components/ui';
import { TokenLogo } from './parts.jsx';
import { launchApi } from '../client.js';
import { launchKeys } from '../hooks.js';
import { REWARD_TABS, rewardTab } from './RewardTokenPicker.jsx';

const logoOf = (t) => t?.logo || null;

export function NftTokenButton({ token, placeholder, sub, onClick, disabled }) {
  return (
    <button type="button" className="pl-launch-pair-btn" onClick={onClick} disabled={disabled} aria-haspopup="dialog">
      {token ? (
        <>
          <TokenLogo token={token} src={logoOf(token)} size={28} shape="round" />
          <span className="pl-launch-pair-btn-main">
            <span className="pl-launch-strong">{token.symbol || 'Unknown'}</span>
            <span className="pl-launch-muted">{sub ?? (token.placeLaunch ? 'Launched on Place' : token.name)}</span>
          </span>
        </>
      ) : (
        <span className="pl-launch-muted">{placeholder}</span>
      )}
      <ChevronDown size={16} className="pl-launch-pair-btn-chevron" />
    </button>
  );
}

function Option({ t, picked, onPick, note }) {
  return (
    <button type="button" className="pl-launch-picker-item" aria-pressed={picked} onClick={() => onPick(t)}>
      <TokenLogo token={t} src={logoOf(t)} size={32} shape="round" />
      <span className="pl-launch-picker-item-main">
        <span className="pl-launch-strong">{t.symbol || 'Unknown'}</span>
        <span className="pl-launch-muted">{note || t.name || t.address}</span>
      </span>
      <span className="pl-launch-picker-item-nums">
        {t.source === 'pair' && <Badge tone="accent">Pair token</Badge>}
        {t.placeLaunch && <Badge tone="neutral">Launched on Place</Badge>}
      </span>
      {picked && <Check size={16} className="pl-launch-picker-check" />}
    </button>
  );
}

/** The result of pasting an address: a pickable token, or why it cannot be used yet. */
function AddressResult({ address, value, onPick }) {
  const q = useQuery({
    queryKey: [...launchKeys.all, 'nft-pair', address.toLowerCase()],
    queryFn: ({ signal }) => launchApi.nftPair(address, signal),
    staleTime: 30_000,
    retry: 0,
  });
  if (q.isLoading) {
    return (
      <p className="pl-place-hint pl-collection-picker-note">
        <Loader2 size={13} className="spin" /> Checking this token...
      </p>
    );
  }
  if (q.error) return <Alert tone="danger" icon={<AlertTriangle size={16} />}>{q.error.message}</Alert>;
  const p = q.data?.pair;
  if (!p) return null;
  if (p.eligible) return <Option t={p} picked={value === p.address} onPick={onPick} note={p.placeLaunch ? 'Launched on Place: mints swap through its launch pool' : 'Has a swap route from ETH'} />;
  return (
    <Alert
      tone="warn"
      icon={<AlertTriangle size={16} />}
      action={
        p.symbol ? (
          <Button as={Link} size="sm" to={`/projects/register?token=${p.address}`}>
            <BadgeCheck size={14} /> Register token
          </Button>
        ) : null
      }
    >
      <span className="pl-launch-strong">{p.symbol ? `${p.symbol} can't be used yet. ` : ''}</span>
      {p.reason}
    </Alert>
  );
}

/**
 * `tokens`: options ({ address, symbol, name, category, logo, placeLaunch, source }); `top`: options pinned above the
 * tabs (ETH and the pair token for rewards). `allowAddress` checks a pasted address.
 */
export function NftTokenPicker({ title, desc, tokens, top = [], value, onPick, onClose, allowAddress = false, emptyText }) {
  const current = [...top, ...tokens].find((t) => t.address === value);
  const [tab, setTab] = useState(() =>
    current && !top.includes(current) ? rewardTab(current) : (REWARD_TABS.find(([id]) => tokens.some((t) => rewardTab(t) === id)) || ['crypto'])[0]
  );
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const s = q.trim().toLowerCase();
  const match = (t) => !s || t.symbol?.toLowerCase().includes(s) || t.name?.toLowerCase().includes(s) || String(t.address).toLowerCase() === s;
  const counts = useMemo(() => Object.fromEntries(REWARD_TABS.map(([id]) => [id, tokens.filter((t) => rewardTab(t) === id).length])), [tokens]);
  const list = tokens.filter((t) => rewardTab(t) === tab && match(t));
  const pinned = top.filter(match);
  const pasted = allowAddress && isAddress(q.trim()) && ![...top, ...tokens].some((t) => String(t.address).toLowerCase() === s) ? q.trim() : null;
  const pick = (t) => {
    onPick(t);
    onClose();
  };
  // In the body: a transformed page (the Based slide-in) would make a fixed overlay scroll with the page.
  return createPortal(
    <div className="pw-theme pw-modal-overlay" onClick={onClose} role="presentation">
      <div className="pw-card pw-modal pl-launch-picker" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="pl-launch-picker-head">
          <span className="pl-launch-picker-title">{title}</span>
          <button type="button" className="pl-place-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {desc && <p className="pl-launch-picker-desc">{desc}</p>}
        <label className="pl-launch-search">
          <Search size={16} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={allowAddress ? 'Search by name or ticker, or paste an address' : 'Search by name or ticker'}
            aria-label={`Search ${title}`}
            spellCheck={false}
          />
        </label>
        {!pasted && (
          <div className="seg soft pl-launch-picker-tabs" role="tablist">
            {REWARD_TABS.map(([id, text]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {text} <span className="mono">{counts[id]}</span>
              </button>
            ))}
          </div>
        )}
        <div className="pl-launch-picker-list">
          {pasted ? (
            <AddressResult address={pasted} value={value} onPick={pick} />
          ) : (
            <>
              {pinned.map((t) => (
                <Option key={`top-${t.address}`} t={t} picked={value === t.address} onPick={pick} note={t.note} />
              ))}
              {list.map((t) => (
                <Option key={t.address} t={t} picked={value === t.address} onPick={pick} />
              ))}
              {!list.length && (
                <EmptyState
                  title={s ? 'No tokens match' : `No ${REWARD_TABS.find(([id]) => id === tab)[1].toLowerCase()} tokens yet`}
                  description={s ? (allowAddress ? 'Try another name, or paste the token address.' : 'Try another name or ticker.') : emptyText}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
