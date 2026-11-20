// Profile → Fees for one 0.3.0 token: creator revenue (claim from the creator vault), the Community Pool (turn it
// into a holder or trader reward stream or a staking program, and with 0.3.1 an NFT holders campaign for an official
// collection or a buyback & burn; launch/fund-quote returns the quote and the ready transaction), the pool log and
// the automatic campaign that anyone can start once the pool sits unused. Only the current creator sees this panel.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Users, Gift, BarChart3, Coins, Timer, AlertTriangle, Image, Flame, History } from 'lucide-react';
import { Card, Badge, Button, Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { formatAmount, formatUtc, parseAmount, shortAddress } from '../../place/format';
import { explorerTx } from '../../place/chain';
import { BPS, NFT_SHARES, BUYBACK_SHARES, parseShareBps, shareText, shareAmount, sortPoolCollections, defaultCollection, nftBlocker, nftQuoteQuery, buybackQuoteQuery, poolLogLabel } from '../poolActions.js';
import { useFundQuote, useRewardTokens } from '../hooks.js';
import { tokenEconomy } from '../economy.js';
import { TokenLogo, AllocationBar, launchTokenPath } from './parts.jsx';
import { vaultReason } from './VaultPanel.jsx';

const DAY = 86400;
const EPOCH_NOW = () => Math.floor(Date.now() / 1000 / DAY);
const STARTS = [
  [1, 'Tomorrow, 00:00 UTC'],
  [2, 'In 2 days'],
  [7, 'In 7 days'],
];
const STAKING_STARTS = [
  [3600, 'In 1 hour'],
  [6 * 3600, 'In 6 hours'],
  [DAY, 'In 24 hours'],
];
const STAKING_EPOCHS = [
  [DAY, '1 day'],
  [7 * DAY, '7 days'],
];
const KINDS = [
  { id: 'holders', label: 'Holder rewards', Icon: Gift },
  { id: 'traders', label: 'Trader rewards', Icon: BarChart3 },
  { id: 'staking', label: 'Staking', Icon: Coins },
  { id: 'nft', label: 'NFT holders', Icon: Image, needs: 'nft' },
  { id: 'buyback', label: 'Buyback & burn', Icon: Flame, needs: 'buyback' },
];

function NumSelect({ label, value, onChange, options }) {
  return (
    <label className="pl-place-field">
      <span className="pl-launch-field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Reward tokens the pool can pay in: the pair (no swap), the token itself (its own pool) and listed routes. */
function usePoolRewardTokens(t) {
  const q = t.quote;
  const options = useRewardTokens(q.address);
  return (options.data?.tokens || [{ address: q.address, symbol: q.symbol, decimals: q.decimals, source: 'pair' }]).map((r) =>
    r.source === 'self' ? { ...r, address: t.address, symbol: t.symbol, decimals: 18 } : r
  );
}

function RewardSelect({ tokens, value, onChange }) {
  return (
    <label className="pl-place-field">
      <span className="pl-launch-field-label">Reward token</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {tokens.map((r) => (
          <option key={r.address} value={r.address}>
            {r.symbol || r.address} {r.source === 'pair' ? '(no swap)' : r.source === 'self' ? '(bought in its pool)' : '(listed route)'}
          </option>
        ))}
      </select>
    </label>
  );
}

function Slippage({ value, onChange }) {
  return (
    <div className="pl-launch-slippage">
      <span className="pl-launch-field-label">Swap slippage</span>
      <div className="seg soft">
        {[50, 100, 300].map((s) => (
          <button key={s} type="button" aria-selected={value === s} onClick={() => onChange(s)}>
            {s / 100}%
          </button>
        ))}
      </div>
    </div>
  );
}

/** A share of the pool in %, with presets; shows what it comes to in the pair asset. */
function ShareField({ label, text, onText, maxBps, presets, total, q }) {
  const bps = parseShareBps(text, maxBps);
  const amount = shareAmount(total, bps);
  const fmt = (raw) => `${formatAmount(raw, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
  return (
    <div className="pl-place-field">
      <span className="pl-launch-field-label">{label}</span>
      <div className="pl-launch-prefixed suffix">
        <input value={text} onChange={(e) => onText(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" inputMode="decimal" className="mono" aria-label={label} />
        <span>%</span>
      </div>
      <div className="seg soft pl-launch-share-presets" aria-label="Quick shares">
        {presets.map((p) => (
          <button key={p} type="button" aria-selected={bps === p} onClick={() => onText(shareText(p))}>
            {shareText(p)}%
          </button>
        ))}
      </div>
      <span className={`pl-place-hint ${text && bps == null ? 'error' : ''}`.trim()}>
        {bps == null ? `From 0.01% to ${shareText(maxBps)}% of ${fmt(total)}` : `${fmt(amount)} of ${fmt(total)}`}
      </span>
    </div>
  );
}

const collectionLabel = (c) => `${c.name || c.address}${c.symbol ? ` (${c.symbol})` : ''}${c.official ? ' · Official' : ''} · ${c.totalMinted} minted${c.eligible ? '' : ` · ${c.reason}`}`;

/** fundNftCampaign: a daily stream for holders of an official, paid collection of this token (0.3.1). */
function NftCampaignForm({ t, pool, onDone }) {
  const q = t.quote;
  const nft = pool.actions.nft;
  const collections = sortPoolCollections(nft.collections);
  const [collection, setCollection] = useState(() => defaultCollection(nft.collections) || collections[0]?.address || '');
  const [share, setShare] = useState(shareText(Math.min(1000, nft.maxBps)));
  const [reward, setReward] = useState(q.address);
  const [startIn, setStartIn] = useState(1);
  const [days, setDays] = useState(30);
  const [minNfts, setMinNfts] = useState('1');
  const [slippage, setSlippage] = useState(100);
  const tx = usePlaceTx({ onSuccess: onDone });
  const tokens = usePoolRewardTokens(t);
  const rt = tokens.find((r) => r.address === reward) || tokens[0];
  const total = pool.afterCollect || '0';
  const blocker = nftBlocker(nft, collection);
  const query = blocker
    ? null
    : nftQuoteQuery({ token: t.address, collection, total, shareBps: parseShareBps(share, nft.maxBps), maxBps: nft.maxBps, rewardToken: reward, slippageBps: slippage, epochCount: days, startEpoch: EPOCH_NOW() + startIn, minNfts: Number(minNfts) });
  const quote = useFundQuote(query);
  const qd = quote.data;
  const fmtR = (raw) => `${formatAmount(raw, rt?.decimals ?? 18, { maxDecimals: 6 })} ${rt?.symbol || ''}`;
  const error = blocker || (qd?.error ? vaultReason(qd.error, q) : quote.error?.message);
  const ready = Boolean(query && qd?.tx && !qd.error && !quote.isFetching);
  const c = collections.find((x) => x.address === collection);
  if (!collections.length) {
    return (
      <Alert tone="info" icon={<Image size={15} />} action={<Button as={Link} to="/launch/nft" size="sm">Launch NFT</Button>}>
        No Place collection is paired with {t.symbol} yet. Launch one with {t.symbol} as its pair token, then fund its holders from the pool.
      </Alert>
    );
  }
  return (
    <>
      <div className="pl-launch-fund-grid">
        <label className="pl-place-field">
          <span className="pl-launch-field-label">Collection</span>
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            {collections.map((x) => (
              <option key={x.address} value={x.address} disabled={!x.eligible}>
                {collectionLabel(x)}
              </option>
            ))}
          </select>
          {c && (
            <Link to={`/collection/${c.address}`} className="pl-place-hint pl-place-link">
              Open collection
            </Link>
          )}
        </label>
        <ShareField label="Share of the pool" text={share} onText={setShare} maxBps={nft.maxBps} presets={NFT_SHARES.filter((p) => p <= nft.maxBps)} total={total} q={q} />
        <RewardSelect tokens={tokens} value={reward} onChange={setReward} />
        <NumSelect label="Starts" value={startIn} onChange={setStartIn} options={STARTS} />
        <label className="pl-place-field">
          <span className="pl-launch-field-label">Days</span>
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="mono" />
        </label>
        <label className="pl-place-field">
          <span className="pl-launch-field-label">Minimum NFTs per wallet</span>
          <input value={minNfts} onChange={(e) => setMinNfts(e.target.value.replace(/\D/g, '').slice(0, 5))} onBlur={() => !Number(minNfts) && setMinNfts('1')} inputMode="numeric" className="mono" />
        </label>
      </div>
      {rt && rt.source !== 'pair' && <Slippage value={slippage} onChange={setSlippage} />}
      {query && (
        <dl className="pl-place-kv pl-launch-small">
          {qd?.swap && (
            <div>
              <dt>The pool swaps to</dt>
              <dd className="mono">{quote.isFetching ? '…' : qd.amountOut != null ? `~${fmtR(qd.amountOut)}, at least ${fmtR(qd.minOut)}` : '—'}</dd>
            </div>
          )}
          <div>
            <dt>Rewards to share</dt>
            <dd className="mono">{qd?.budget != null ? `${fmtR(qd.budget)}, ${fmtR(qd.perEpoch)} per day` : quote.isFetching ? '…' : '—'}</dd>
          </div>
          {qd?.feeBps != null && (
            <div>
              <dt>Place fee</dt>
              <dd className="mono">{qd.feeBps / 100}%</dd>
            </div>
          )}
        </dl>
      )}
      {error && (
        <Alert tone="warn" icon={<AlertTriangle size={15} />}>
          {error === 'One NFT campaign per 30 days' && nft.nextAt ? `${error}: the next from ${formatUtc(nft.nextAt)}` : error}
        </Alert>
      )}
      <span className="pl-place-hint">
        Shared every UTC day between wallets holding at least {Number(minNfts) || 1} NFT{Number(minNfts) > 1 ? 's' : ''} of the collection. One NFT campaign per 30 days,
        up to {shareText(nft.maxBps)}% of the pool; what nobody earns returns to the pool 30 days after the last day.
      </span>
      <TxButton tx={tx} onClick={() => tx.send({ label: 'Start NFT holder rewards', to: qd.tx.to, data: qd.tx.data, value: 0n })} disabled={!ready} busyLabel="Funding on Base..." variant="primary">
        Start NFT holder rewards
      </TxButton>
      <TxResult tx={tx} success="NFT holder rewards created" />
    </>
  );
}

/** buybackAndBurn: buy this token with the pool's pair asset in its own pool and send it to 0x…dEaD (0.3.1). */
function BuybackForm({ t, pool, onDone }) {
  const q = t.quote;
  const [share, setShare] = useState('25');
  const [slippage, setSlippage] = useState(100);
  const tx = usePlaceTx({ onSuccess: onDone });
  const total = pool.afterCollect || '0';
  const query = buybackQuoteQuery({ token: t.address, total, shareBps: parseShareBps(share), slippageBps: slippage });
  const quote = useFundQuote(query);
  const qd = quote.data;
  const fmtT = (raw) => `${formatAmount(raw, 18, { maxDecimals: 2 })} ${t.symbol}`;
  const error = qd?.error ? vaultReason(qd.error, q) : quote.error?.message;
  const ready = Boolean(query && qd?.tx && !qd.error && !quote.isFetching);
  const burned = BigInt(pool.actions.buyback.totalBurned || 0);
  return (
    <>
      <div className="pl-launch-fund-grid">
        <ShareField label="Share of the pool" text={share} onText={setShare} maxBps={BPS} presets={BUYBACK_SHARES} total={total} q={q} />
        <Slippage value={slippage} onChange={setSlippage} />
      </div>
      {query && (
        <dl className="pl-place-kv pl-launch-small">
          <div>
            <dt>Burns</dt>
            <dd className="mono">{quote.isFetching ? '…' : qd?.amountOut != null ? `~${fmtT(qd.amountOut)}, at least ${fmtT(qd.minOut)}` : '—'}</dd>
          </div>
          {burned > 0n && (
            <div>
              <dt>Burned by the pool so far</dt>
              <dd className="mono">{fmtT(burned)}</dd>
            </div>
          )}
        </dl>
      )}
      {error && (
        <Alert tone="warn" icon={<AlertTriangle size={15} />}>
          {error}
        </Alert>
      )}
      <span className="pl-place-hint">
        Buys {t.symbol} in its own pool with the pool’s {q.symbol} and sends it to 0x…dEaD. The call stops if the price is far from its recent reference price.
      </span>
      <TxButton tx={tx} onClick={() => tx.send({ label: `Buy back and burn ${t.symbol}`, to: qd.tx.to, data: qd.tx.data, value: 0n })} disabled={!ready} busyLabel="Burning on Base..." variant="primary">
        <Flame size={15} /> Buy back and burn
      </TxButton>
      <TxResult tx={tx} success={`${t.symbol} bought back and burned`} />
    </>
  );
}

/** Everything the creator can pay from the Community Pool; 0.3.1 pools add NFT holders and buyback & burn. */
function PoolForm({ t, pool, econ, onDone }) {
  const kinds = KINDS.filter((k) => !k.needs || pool.actions?.[k.needs]?.available);
  const [kind, setKind] = useState('holders');
  return (
    <div className="pl-launch-fund-form pl-place-form">
      <div className="pl-launch-tabs-scroll">
        <div className="seg soft" role="tablist" aria-label="What to fund">
          {kinds.map(({ id, label: l, Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={kind === id} onClick={() => setKind(id)}>
              <Icon size={14} /> {l}
            </button>
          ))}
        </div>
      </div>
      {kind === 'nft' ? <NftCampaignForm t={t} pool={pool} onDone={onDone} /> : kind === 'buyback' ? <BuybackForm t={t} pool={pool} onDone={onDone} /> : <StreamForm key={kind} t={t} pool={pool} econ={econ} onDone={onDone} kind={kind} />}
    </div>
  );
}

/** The last entries of the pool's on-chain log (launch_vault_events of the community vault). */
function PoolLog({ t, pool }) {
  const q = t.quote;
  const rows = (pool.history || []).filter((h) => h.kind !== 'fund_swapped').slice(0, 8);
  if (!rows.length) return null;
  const names = new Map((pool.actions?.nft?.collections || []).map((c) => [c.address, c.name || c.symbol]));
  const isQuote = (a) => a && (a === q.address || (q.address === 'eth' && /^0x0{40}$/.test(a)));
  const amount = (h) => {
    if (h.kind === 'fund_collected' && h.amount) return `${formatAmount(h.amount, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
    if (h.kind === 'fund_burned') return `${formatAmount(h.amount2 || 0, 18, { maxDecimals: 2 })} ${t.symbol}`;
    if ((h.kind === 'fund_stream' || h.kind === 'fund_staking') && isQuote(h.account)) return `${formatAmount(h.kind === 'fund_stream' ? h.amount2 : h.amount, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
    return '';
  };
  const sub = (h) =>
    h.kind === 'fund_nft_stream'
      ? names.get(h.account) || shortAddress(h.account)
      : h.kind === 'fund_burned'
        ? `for ${formatAmount(h.amount || 0, q.decimals, { maxDecimals: 6 })} ${q.symbol}`
        : h.kind === 'fund_stream' && h.data?.isDefault
          ? 'Automatic campaign'
          : null;
  return (
    <div className="pl-launch-pool-log">
      <span className="pl-launch-fee-label">
        <History size={14} /> Pool log
      </span>
      <div className="pl-place-rows">
        {rows.map((h) => (
          <a key={`${h.tx}-${h.kind}-${h.ref || ''}`} className="pl-place-row" href={explorerTx(h.tx)} target="_blank" rel="noopener noreferrer">
            <div className="pl-place-row-main">
              <span className="pl-place-row-title">{poolLogLabel(h.kind)}</span>
              <span className="pl-place-row-sub">
                {sub(h) ? `${sub(h)} · ` : ''}
                {formatUtc(h.at)}
              </span>
            </div>
            <span className="pl-place-row-amount">{amount(h)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** A holder or trader stream or a staking program paid from the Community Pool. */
function StreamForm({ t, pool, econ, onDone, kind }) {
  const q = t.quote;
  const [text, setText] = useState('');
  const [reward, setReward] = useState(q.address);
  const [days, setDays] = useState(30);
  const [startIn, setStartIn] = useState(1);
  const [stakeStart, setStakeStart] = useState(6 * 3600);
  const [epochLen, setEpochLen] = useState(DAY);
  const defaultHolding = econ?.minHolding && econ.minHolding !== '0' ? formatAmount(econ.minHolding, 18, { maxDecimals: 0 }).replace(/,/g, '') : '10000';
  const [minHolding, setMinHolding] = useState(defaultHolding);
  const [minVolume, setMinVolume] = useState('');
  const [slippage, setSlippage] = useState(100);
  const tx = usePlaceTx({ onSuccess: onDone });
  const tokens = usePoolRewardTokens(t);
  const rt = tokens.find((r) => r.address === reward) || tokens[0];
  const available = BigInt(pool.afterCollect || 0);
  const amountIn = parseAmount(text, q.decimals);
  const tooMuch = amountIn != null && amountIn > available;
  const criterion =
    kind === 'holders' ? parseAmount(minHolding || '0', 18) : kind === 'traders' ? (minVolume ? parseAmount(minVolume, q.decimals) : 0n) : null;
  const badCriterion = kind !== 'staking' && criterion == null;
  const query =
    amountIn && !tooMuch && !badCriterion
      ? {
          token: t.address,
          rewardToken: reward,
          amountIn: amountIn.toString(),
          slippageBps: slippage,
          kind,
          epochCount: days,
          ...(kind === 'staking'
            ? { startTime: Math.floor(Date.now() / 1000 / 600) * 600 + stakeStart, epochDuration: epochLen }
            : { startEpoch: EPOCH_NOW() + startIn, criterion: criterion.toString() }),
        }
      : null;
  const quote = useFundQuote(query);
  const qd = quote.data;
  const fmtR = (raw) => `${formatAmount(raw, rt?.decimals ?? 18, { maxDecimals: 6 })} ${rt?.symbol || ''}`;
  const error = qd?.error ? vaultReason(qd.error, q) : quote.error?.message;
  const ready = Boolean(query && qd?.tx && !qd.error && !quote.isFetching);
  const label = kind === 'staking' ? 'Start staking program' : `Start ${kind === 'holders' ? 'holder' : 'trader'} rewards`;
  return (
    <>
      <div className="pl-launch-fund-grid">
        <label className="pl-place-field">
          <span className="pl-launch-field-label">From the pool</span>
          <div className="pl-launch-prefixed suffix">
            <input value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" inputMode="decimal" className="mono" />
            <span>{q.symbol}</span>
          </div>
          <span className={`pl-place-hint ${tooMuch ? 'error' : ''}`.trim()}>
            Available {formatAmount(available, q.decimals, { maxDecimals: 6 })} {q.symbol}{' '}
            <button type="button" className="pl-place-link-btn" onClick={() => setText(formatAmount(available, q.decimals, { maxDecimals: q.decimals }).replace(/,/g, ''))}>
              Max
            </button>
          </span>
        </label>
        <RewardSelect tokens={tokens} value={reward} onChange={setReward} />
        {kind === 'staking' ? (
          <>
            <NumSelect label="Starts" value={stakeStart} onChange={setStakeStart} options={STAKING_STARTS} />
            <NumSelect label="Epoch" value={epochLen} onChange={setEpochLen} options={STAKING_EPOCHS} />
          </>
        ) : (
          <>
            <NumSelect label="Starts" value={startIn} onChange={setStartIn} options={STARTS} />
            {kind === 'holders' ? (
              <label className="pl-place-field">
                <span className="pl-launch-field-label">Minimum holding ({t.symbol})</span>
                <input value={minHolding} onChange={(e) => setMinHolding(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="mono" />
              </label>
            ) : (
              <label className="pl-place-field">
                <span className="pl-launch-field-label">Minimum daily volume ({q.symbol})</span>
                <input value={minVolume} onChange={(e) => setMinVolume(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" inputMode="decimal" className="mono" />
              </label>
            )}
          </>
        )}
        <label className="pl-place-field">
          <span className="pl-launch-field-label">{kind === 'staking' ? 'Epochs' : 'Days'}</span>
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="mono" />
        </label>
      </div>
      {rt && rt.source !== 'pair' && <Slippage value={slippage} onChange={setSlippage} />}
      {query && (
        <dl className="pl-place-kv pl-launch-small">
          {qd?.swap && (
            <div>
              <dt>The pool swaps to</dt>
              <dd className="mono">{quote.isFetching ? '…' : qd.amountOut != null ? `~${fmtR(qd.amountOut)}, at least ${fmtR(qd.minOut)}` : '—'}</dd>
            </div>
          )}
          <div>
            <dt>{kind === 'staking' ? 'Rewards for stakers' : 'Rewards to share'}</dt>
            <dd className="mono">{qd?.budget != null ? `${fmtR(qd.budget)}, ${fmtR(qd.perEpoch)} per ${kind === 'staking' ? 'epoch' : 'day'}` : quote.isFetching ? '…' : '—'}</dd>
          </div>
          {qd?.feeBps != null && (
            <div>
              <dt>Place fee</dt>
              <dd className="mono">{qd.feeBps / 100}%</dd>
            </div>
          )}
        </dl>
      )}
      {error && (
        <Alert tone="warn" icon={<AlertTriangle size={15} />}>
          {error}
        </Alert>
      )}
      <span className="pl-place-hint">
        {kind === 'staking'
          ? 'Rewards of an epoch without stakers stay in the staking contract, so give holders a few hours to stake before the start.'
          : 'Shared every UTC day between eligible wallets, like the token’s own rewards. What nobody earns returns to the pool 30 days after the last day.'}
      </span>
      <TxButton tx={tx} onClick={() => tx.send({ label, to: qd.tx.to, data: qd.tx.data, value: 0n })} disabled={!ready} busyLabel="Funding on Base..." variant="primary">
        {label}
      </TxButton>
      <TxResult tx={tx} success={kind === 'staking' ? 'Staking program created' : 'Reward stream created'} />
    </>
  );
}

export function VaultPanelV3({ item, PayoutForm, hideClaim = false }) {
  const t = item.token;
  const v = item.vault;
  const q = t.quote;
  const econ = tokenEconomy(t);
  const [open, setOpen] = useState(false);
  const claimTx = usePlaceTx();
  const defaultTx = usePlaceTx();
  const fmtQ = (raw) => `${formatAmount(raw || 0, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
  const pool = v.community;
  const paid = v.claim?.error || !v.claim ? 0n : BigInt(v.claim.paid || 0);
  const now = Date.now();
  const poolBlock = (
    <div className="pl-launch-fee-block">
      <span className="pl-launch-fee-label">
        <Users size={14} /> Community Pool
      </span>
      {!pool ? (
        <span className="pl-launch-fee-sub">This token has no community pool share.</span>
      ) : pool.error ? (
        <span className="pl-place-hint error">{pool.error}</span>
      ) : (
        <>
          <span className="pl-launch-fee-value mono">{fmtQ(pool.afterCollect)}</span>
          <span className="pl-launch-fee-sub">
            {BigInt(pool.pendingFees || 0) > 0n ? `Includes ${fmtQ(pool.pendingFees)} collected with the next spend. ` : ''}{pool.actions?.supported ? `Nobody can withdraw it: it funds rewards and staking for ${t.symbol} and its NFT holders, or buys back and burns ${t.symbol}.` : `It can only fund rewards and staking for ${t.symbol}.`}
          </span>
          <Button size="sm" variant={open ? 'primary' : 'secondary'} disabled={BigInt(pool.afterCollect || 0) === 0n} onClick={() => setOpen(!open)}>
            Create campaign
          </Button>
        </>
      )}
    </div>
  );
  const autoBlock = (
    <div className="pl-launch-fee-block">
      <span className="pl-launch-fee-label">
        <Timer size={14} /> Automatic campaign
      </span>
      {pool && !pool.error ? (
        <>
          <span className="pl-launch-fee-value">{new Date(pool.defaultCampaign.nextAt).getTime() > now ? formatUtc(pool.defaultCampaign.nextAt) : 'Due now'}</span>
          <span className="pl-launch-fee-sub">
            If the pool is not used before then, anyone can turn all of it into a {pool.settings.defaultCampaignEpochs}-day holder rewards stream.
          </span>
          {pool.defaultCampaign.canStart && (
            <TxButton tx={defaultTx} size="sm" variant="ghost" busyLabel="Starting on Base..." onClick={() => defaultTx.send({ label: 'Start automatic campaign', to: pool.defaultCampaign.tx.to, data: pool.defaultCampaign.tx.data, value: 0n })}>
              Start it now
            </TxButton>
          )}
          <TxResult tx={defaultTx} success="Holder rewards stream started" />
        </>
      ) : (
        <span className="pl-launch-fee-sub">Only for tokens with a community pool.</span>
      )}
    </div>
  );
  if (hideClaim) {
    // Profile → Fees → Manage tokens: the claim lives in the fee list above, so only the pool and the payout.
    return (
      <div className="pl-place-stack">
        {!v.error && v.payout && <PayoutForm vault={v.address} current={v.payout} />}
        {econ && <AllocationBar shares={econ.shares} />}
        <div className="pl-launch-fee-grid">
          {poolBlock}
          {autoBlock}
        </div>
        {open && pool && !pool.error && <PoolForm t={t} pool={pool} econ={econ} onDone={() => setOpen(false)} />}
        {pool && !pool.error && <PoolLog t={t} pool={pool} />}
      </div>
    );
  }
  return (
    <Card className="pl-launch-fee">
      <div className="pl-launch-fee-head">
        <TokenLogo token={t} size={40} />
        <div className="pl-launch-launch-title">
          <Link to={launchTokenPath(t.address)} className="pl-launch-strong pl-launch-fee-name">
            {t.name}
          </Link>
          <span className="pl-launch-muted">
            {t.symbol}/{q.symbol} · {econ?.type === 'economy' ? `Economy, tax ${econ.buyTax}% / ${econ.sellTax}%` : 'Standard, 1%'}
          </span>
        </div>
        {!v.error && v.payout && <PayoutForm vault={v.address} current={v.payout} />}
      </div>

      {econ && <AllocationBar shares={econ.shares} />}

      <div className="pl-launch-fee-grid three">
        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Wallet size={14} /> Creator revenue
          </span>
          {v.error ? (
            <span className="pl-place-hint error">{v.error}</span>
          ) : v.claim?.error ? (
            <span className="pl-place-hint error">{vaultReason(v.claim.error, q)}</span>
          ) : (
            <span className="pl-launch-fee-value mono">{fmtQ(v.claim?.paid)}</span>
          )}
          {!v.error && (
            <span className="pl-launch-fee-sub">
              {BigInt(v.balances?.xOwed || 0) > 0n ? `X accounts are owed ${fmtQ(v.balances.xOwed)}. ` : ''}Your share of every trade, in {q.symbol}.
            </span>
          )}
          <TxButton tx={claimTx} size="sm" disabled={paid === 0n} busyLabel="Claiming on Base..." onClick={() => claimTx.send({ label: 'Claim creator revenue', to: v.claim.tx.to, data: v.claim.tx.data, value: 0n })}>
            {paid === 0n ? 'Nothing to claim yet' : 'Claim'}
          </TxButton>
          <TxResult tx={claimTx} success="Claimed" />
        </div>

        {poolBlock}
        {autoBlock}
      </div>

      {open && pool && !pool.error && <PoolForm t={t} pool={pool} econ={econ} onDone={() => setOpen(false)} />}

      {pool && !pool.error && <PoolLog t={t} pool={pool} />}

      <div className="pl-launch-fee-totals">
        <Badge tone="neutral">{t.version}</Badge>
      </div>
    </Card>
  );
}
