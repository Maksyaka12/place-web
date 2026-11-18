// The reward token of an Economy launch: a button with the picked token and a picker modal in the look of the pair
// picker (Crypto / Stocks / Majors tabs, search, logos). The options come from `launch/reward-tokens`: the pair asset
// (no swap), the launched token itself, and every token the reward token registry has a swap route to.
// The Create vault / campaign form reuses it with its own options, hints (`describe`) and an address check
// (`addressSlot`: what to show when the search is a 0x address that is not in the list).
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Check, ChevronDown } from 'lucide-react';
import { Badge, EmptyState } from '../../themes/place/components/ui';
import { TokenLogo } from './parts.jsx';
import { pairCategory, pairIcon } from '../pairs.js';

export const REWARD_TABS = [
  ['crypto', 'Crypto'],
  ['stocks', 'Stocks'],
  ['majors', 'Majors'],
];

/** The picker tab of an option; options from an older API have no category. */
export const rewardTab = (t) => t.category ?? (pairCategory(t.symbol) === 'crypto' ? 'majors' : 'stocks');

const logoOf = (t) => t.logo || pairIcon(t);
const selfToken = (tokenLabel) => ({ symbol: tokenLabel.startsWith('$') ? tokenLabel.slice(1) : 'T' });
const isAddressText = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || '').trim());

function label(t, tokenLabel, describe) {
  const own = describe?.(t);
  if (own) return own;
  if (t.source === 'self') return { title: tokenLabel.startsWith('$') ? tokenLabel : 'Your token', sub: 'Your token: rewards are bought with the tax every day' };
  return { title: t.symbol || 'Unknown', sub: t.source === 'pair' ? 'Pair asset: paid as collected, no swap' : t.name && t.name !== t.symbol ? t.name : 'Bought with the tax once a day' };
}

/** The logo of an option: a launched token by its contract URI, anything else by its icon or initials. */
function OptionLogo({ t, tokenLabel, size }) {
  if (t.source === 'self') return <TokenLogo token={selfToken(tokenLabel)} src={null} size={size} shape="round" />;
  return <TokenLogo token={t} src={t.contractURI ? undefined : logoOf(t)} size={size} shape="round" />;
}

export function RewardTokenButton({ token, tokenLabel = '', onClick, describe, placeholder = 'Choose a reward token', disabled = false }) {
  const l = token ? label(token, tokenLabel, describe) : null;
  return (
    <button type="button" className="pl-launch-pair-btn" onClick={onClick} aria-haspopup="dialog" disabled={disabled}>
      {token ? (
        <>
          <OptionLogo t={token} tokenLabel={tokenLabel} size={28} />
          <span className="pl-launch-pair-btn-main">
            <span className="pl-launch-strong">{l.title}</span>
            <span className="pl-launch-muted">{l.sub}</span>
          </span>
        </>
      ) : (
        <span className="pl-launch-muted">{placeholder}</span>
      )}
      <ChevronDown size={16} className="pl-launch-pair-btn-chevron" />
    </button>
  );
}

export function RewardOption({ t, tokenLabel = '', picked, onPick, describe }) {
  const l = label(t, tokenLabel, describe);
  return (
    <button type="button" className="pl-launch-picker-item" aria-pressed={picked} onClick={() => onPick(t.address)}>
      <OptionLogo t={t} tokenLabel={tokenLabel} size={32} />
      <span className="pl-launch-picker-item-main">
        <span className="pl-launch-strong">{l.title}</span>
        <span className="pl-launch-muted">{l.sub}</span>
      </span>
      <span className="pl-launch-picker-item-nums">
        {t.source === 'pair' && <Badge tone="accent">Pair asset</Badge>}
        {t.source === 'self' && <Badge tone="neutral">Your token</Badge>}
        {(t.source === 'route' || t.source === 'token') && t.placeLaunch && <Badge tone="neutral">Launched on Place</Badge>}
        {t.source === 'address' && <Badge tone="neutral">By address</Badge>}
      </span>
      {picked && <Check size={16} className="pl-launch-picker-check" />}
    </button>
  );
}

/**
 * `tokens`: the options of `launch/reward-tokens`; `pairSymbol` names the pair asset in the hints. `title`, `desc`,
 * `describe` (option → { title, sub }) and `addressSlot` ((address, pick) → node) let another form reuse the picker.
 */
export function RewardTokenPicker({ tokens, value, tokenLabel = '', pairSymbol, onPick, onClose, title = 'Reward token', desc, describe, addressSlot }) {
  const current = tokens.find((t) => t.address === value);
  const [tab, setTab] = useState(() => (current && current.source !== 'self' ? rewardTab(current) : rewardTab(tokens.find((t) => t.source === 'pair') || { symbol: 'ETH' })));
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const self = tokens.find((t) => t.source === 'self');
  const counts = useMemo(() => Object.fromEntries(REWARD_TABS.map(([id]) => [id, tokens.filter((t) => t.source !== 'self' && rewardTab(t) === id).length])), [tokens]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return tokens.filter(
      (t) =>
        t.source !== 'self' &&
        rewardTab(t) === tab &&
        (!s || t.symbol?.toLowerCase().includes(s) || t.name?.toLowerCase().includes(s) || String(t.address).toLowerCase().includes(s))
    );
  }, [tokens, tab, q]);
  const pick = (address) => {
    onPick(address);
    onClose();
  };
  const selfShown = self && (!q.trim() || tokenLabel.toLowerCase().includes(q.trim().toLowerCase()));
  const typed = q.trim().toLowerCase();
  const pasted = addressSlot && isAddressText(typed) && !tokens.some((t) => String(t.address).toLowerCase() === typed) ? typed : null;

  // In the body: a transformed page (the Based slide-in) would make a fixed overlay scroll with the page.
  return createPortal(
    <div className="pw-theme pw-modal-overlay" onClick={onClose} role="presentation">
      <div className="pw-card pw-modal pl-launch-picker" role="dialog" aria-modal="true" aria-label={`Choose: ${title}`} onClick={(e) => e.stopPropagation()}>
        <div className="pl-launch-picker-head">
          <span className="pl-launch-picker-title">{title}</span>
          <button type="button" className="pl-place-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="pl-launch-picker-desc">
          {desc ?? `Holders and traders claim rewards in this token. Taxes arrive in ${pairSymbol || 'the pair asset'}; any other token is bought with them once a day.`}
        </p>
        <label className="pl-launch-search">
          <Search size={16} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={addressSlot ? 'Search, or paste a token address' : 'Search by name, ticker or address'}
            aria-label="Search reward tokens"
            spellCheck={false}
          />
        </label>
        <div className="seg soft pl-launch-picker-tabs" role="tablist">
          {REWARD_TABS.map(([id, text]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {text} <span className="mono">{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="pl-launch-picker-list">
          {pasted && addressSlot(pasted, pick)}
          {selfShown && <RewardOption t={self} tokenLabel={tokenLabel} picked={value === 'self'} onPick={pick} describe={describe} />}
          {list.map((t) => (
            <RewardOption key={t.address} t={t} tokenLabel={tokenLabel} picked={value === t.address} onPick={pick} describe={describe} />
          ))}
          {!list.length && !pasted && (
            <EmptyState
              title={q.trim() ? 'No reward tokens match' : `No ${REWARD_TABS.find(([id]) => id === tab)[1].toLowerCase()} reward tokens yet`}
              description={
                q.trim()
                  ? addressSlot
                    ? 'Try another name or ticker, or paste a token address.'
                    : 'Try another name or ticker.'
                  : addressSlot
                    ? 'Paste the address of any ERC-20 on Base to pay in it.'
                    : `A token can be a reward once Place lists a swap route to it from ${pairSymbol || 'the pair asset'}. More routes are added over time.`
              }
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
