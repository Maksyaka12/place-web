// The creator console for one 0.2.0 token: the creator's fees, the daily burn (process),
// the community fund (holder campaigns and staking programs in any listed reward token, with the vault's own
// swap quote and minOut) and raising the burn / fund shares. Legacy 0.1.0 vaults keep FeeRow in CreatorConsole.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Flame, Users, Coins, Gift, TrendingUp, AlertTriangle } from 'lucide-react';
import { Card, Badge, Button, Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { formatAmount, formatUtc, parseAmount } from '../../place/format';
import { CREATOR_VAULT_ABI } from '../abi.js';
import { useFundQuote } from '../hooks.js';
import { ETH } from '../swap.js';
import { TokenLogo, EconomicsBar, launchTokenPath } from './parts.jsx';

const HOUR = 3600;
const DAY = 86400;
const SNAPSHOT_DELAYS = [
  [HOUR, '1 hour'],
  [6 * HOUR, '6 hours'],
  [DAY, '24 hours'],
  [3 * DAY, '3 days'],
  [7 * DAY, '7 days'],
];
const CLAIM_WINDOWS = [
  [7 * DAY, '7 days'],
  [14 * DAY, '14 days'],
  [30 * DAY, '30 days'],
  [60 * DAY, '60 days'],
];
const STAKING_STARTS = [
  [HOUR, 'in 1 hour'],
  [6 * HOUR, 'in 6 hours'],
  [DAY, 'in 24 hours'],
];
const EPOCHS = [
  [DAY, '1 day'],
  [7 * DAY, '7 days'],
  [30 * DAY, '30 days'],
];

/** Contract errors → plain words. */
export function vaultReason(reason, q) {
  if (!reason) return null;
  let m = reason.match(/ProcessTooSoon\((\d+)\)/);
  if (m) return `Next burn from ${formatUtc(Number(m[1]) * 1000)}`;
  m = reason.match(/DefaultCampaignTooSoon\((\d+)\)/);
  if (m) return `Unused funds turn into a default campaign from ${formatUtc(Number(m[1]) * 1000)}`;
  m = reason.match(/FundTooSmall\((\d+), (\d+)\)/);
  if (m && q) return `The fund has ${formatAmount(m[1], q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
  m = reason.match(/PriceImpactTooHigh\((\d+), (\d+)\)/);
  if (m) return `This amount would move the price ${Number(m[1]) / 100}%, the limit is ${Number(m[2]) / 100}%. Try a smaller amount`;
  if (/RouteNotListed/.test(reason)) return 'This reward token has no listed swap route';
  if (/SlippageExceeded/.test(reason)) return 'The price moved: refresh the quote';
  if (/CommunityDisabled/.test(reason)) return 'This token has no community fund';
  if (/NotCreator/.test(reason)) return 'Only the current creator can do this';
  return reason.length > 90 ? 'Not possible right now' : reason;
}

function Select({ value, onChange, options, label }) {
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

/** A holder campaign or staking program from the community fund. */
function FundForm({ t, v, onDone }) {
  const q = t.quote;
  const [kind, setKind] = useState('campaign');
  const [reward, setReward] = useState(v.rewardTokens[0]?.address || 'eth');
  const [text, setText] = useState('');
  const [slippage, setSlippage] = useState(100);
  const [snapshotDelay, setSnapshotDelay] = useState(DAY);
  const [claimWindow, setClaimWindow] = useState(30 * DAY);
  const [burnLeftover, setBurnLeftover] = useState(true);
  const [startIn, setStartIn] = useState(6 * HOUR);
  const [epoch, setEpoch] = useState(DAY);
  const [epochs, setEpochs] = useState(7);
  const tx = usePlaceTx({ onSuccess: onDone });
  const available = BigInt(v.balances.fundAfterCollect || 0);
  const amountIn = parseAmount(text, q.decimals);
  const tooMuch = amountIn && amountIn > available;
  const rt = v.rewardTokens.find((r) => r.address === reward) || v.rewardTokens[0];
  const quote = useFundQuote(amountIn && !tooMuch ? { token: t.address, rewardToken: reward, amountIn: amountIn.toString(), slippageBps: slippage } : null);
  const qd = quote.data;
  const out = qd?.amountOut != null ? BigInt(qd.amountOut) : null;
  const minOut = qd?.minOut != null ? BigInt(qd.minOut) : null;
  const net = kind === 'campaign' ? qd?.campaignPool : qd?.stakingBudget;
  const feeBps = kind === 'campaign' ? qd?.hubFeeBps : qd?.stakingFeeBps;
  const fmtR = (raw) => `${formatAmount(raw, rt?.decimals ?? 18, { maxDecimals: 6 })} ${rt?.symbol || ''}`;
  const error = qd?.error ? vaultReason(qd.error, q) : quote.error?.message;
  const fundAsset = q.address === 'eth' ? ETH : q.address;
  const rewardAddr = reward === 'eth' ? ETH : reward;
  const ready = amountIn && !tooMuch && minOut != null && !qd?.error && epochs >= 1;

  const send = () => {
    if (kind === 'campaign') {
      const req = { fundAsset, amountIn, rewardToken: rewardAddr, minOut, snapshotDelay: BigInt(snapshotDelay), claimDuration: claimWindow, burnLeftover, metadataURI: '' };
      return tx.send({ label: 'Holder campaign from the fund', to: v.address, abi: CREATOR_VAULT_ABI, functionName: 'fundCampaign', args: [req] });
    }
    const startTime = BigInt(Math.floor(Date.now() / 1000) + startIn);
    const req = { fundAsset, amountIn, rewardToken: rewardAddr, minOut, startTime, epochDuration: BigInt(epoch), epochCount: BigInt(epochs), earlyExitMode: 0, penaltyBps: 0 };
    return tx.send({ label: 'Staking program from the fund', to: v.address, abi: CREATOR_VAULT_ABI, functionName: 'fundStaking', args: [req] });
  };

  return (
    <div className="pl-launch-fund-form pl-place-form">
      <div className="seg soft" role="tablist" aria-label="What to fund">
        <button type="button" role="tab" aria-selected={kind === 'campaign'} onClick={() => setKind('campaign')}>
          <Gift size={14} /> Holder campaign
        </button>
        <button type="button" role="tab" aria-selected={kind === 'staking'} onClick={() => setKind('staking')} disabled={!v.settings.staking || v.settings.staking === ETH}>
          <Coins size={14} /> Staking program
        </button>
      </div>
      <div className="pl-launch-fund-grid">
        <label className="pl-place-field">
          <span className="pl-launch-field-label">From the fund</span>
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
        <label className="pl-place-field">
          <span className="pl-launch-field-label">Reward token</span>
          <select value={reward} onChange={(e) => setReward(e.target.value)}>
            {v.rewardTokens.map((r) => (
              <option key={r.address} value={r.address}>
                {r.symbol || r.address} {r.route === 'none' ? '(no swap)' : r.route === 'own-pool' ? '(bought in its pool)' : '(listed route)'}
              </option>
            ))}
          </select>
        </label>
        {kind === 'campaign' ? (
          <>
            <Select label="Snapshot in" value={snapshotDelay} onChange={setSnapshotDelay} options={SNAPSHOT_DELAYS} />
            <Select label="Claim window" value={claimWindow} onChange={setClaimWindow} options={CLAIM_WINDOWS} />
          </>
        ) : (
          <>
            <Select label="Starts" value={startIn} onChange={setStartIn} options={STAKING_STARTS} />
            <Select label="Epoch" value={epoch} onChange={setEpoch} options={EPOCHS} />
            <label className="pl-place-field">
              <span className="pl-launch-field-label">Epochs</span>
              <input type="number" min={1} max={365} value={epochs} onChange={(e) => setEpochs(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="mono" />
            </label>
          </>
        )}
      </div>
      {kind === 'campaign' && (
        <label className="pl-launch-option-head pl-launch-inline">
          <input type="checkbox" className="pl-launch-switch" checked={burnLeftover} onChange={(e) => setBurnLeftover(e.target.checked)} />
          <span className="pl-launch-muted">Burn what nobody claims (otherwise it returns to the fund)</span>
        </label>
      )}
      {rt && rt.route !== 'none' && (
        <div className="pl-launch-slippage">
          <span className="pl-launch-field-label">Swap slippage</span>
          <div className="seg soft">
            {[50, 100, 300].map((s) => (
              <button key={s} type="button" aria-selected={slippage === s} onClick={() => setSlippage(s)}>
                {s / 100}%
              </button>
            ))}
          </div>
        </div>
      )}
      {amountIn && !tooMuch && (
        <dl className="pl-place-kv pl-launch-small">
          {qd?.swap && (
            <div>
              <dt>The vault swaps to</dt>
              <dd className="mono">{quote.isFetching ? '…' : out != null ? `~${fmtR(out)}, at least ${fmtR(minOut)}` : '—'}</dd>
            </div>
          )}
          <div>
            <dt>{kind === 'campaign' ? 'Campaign pool' : 'Rewards for stakers'}</dt>
            <dd className="mono">
              {net != null ? `${fmtR(net)}${kind === 'staking' ? `, ${fmtR(BigInt(net) / BigInt(Math.max(1, epochs)))} per epoch` : ''}` : '—'}
            </dd>
          </div>
          {feeBps != null && (
            <div>
              <dt>Place fee</dt>
              <dd className="mono">{feeBps / 100}%</dd>
            </div>
          )}
        </dl>
      )}
      {error && (
        <Alert tone="warn" icon={<AlertTriangle size={15} />}>
          {error}
        </Alert>
      )}
      {kind === 'staking' && <span className="pl-place-hint">Rewards of an epoch without stakers stay in the staking contract, so give holders a few hours to stake before the start.</span>}
      <TxButton tx={tx} onClick={send} disabled={!ready} busyLabel="Funding on Base..." variant="primary">
        {kind === 'campaign' ? 'Start holder campaign' : 'Start staking program'}
      </TxButton>
      <TxResult tx={tx} success={kind === 'campaign' ? 'Campaign created in the Place hub' : 'Staking program created'} />
    </div>
  );
}

/** Raise the burn and fund shares (never lower them). */
function EconomicsForm({ v, onDone }) {
  const cur = v.economics;
  const [burn, setBurn] = useState(cur.burnBps / 100);
  const [fund, setFund] = useState(cur.communityBps / 100);
  const tx = usePlaceTx({ onSuccess: onDone });
  const changed = burn * 100 !== cur.burnBps || fund * 100 !== cur.communityBps;
  const over = burn + fund > 100;
  const pct = (label, value, set, min, Icon) => (
    <div className="pl-launch-percent">
      <div className="pl-launch-percent-head">
        <span className="pl-launch-percent-label">
          <Icon size={15} /> {label}
        </span>
        <span className="mono pl-launch-strong">{value}%</span>
      </div>
      <input type="range" min={0} max={100} step={5} value={value} onChange={(e) => set(Math.max(min, Number(e.target.value)))} aria-label={label} />
    </div>
  );
  return (
    <div className="pl-launch-fund-form pl-place-form">
      {pct('Burn', burn, setBurn, cur.burnBps / 100, Flame)}
      {pct('Community fund', fund, setFund, cur.communityBps / 100, Users)}
      <EconomicsBar burn={burn} fund={fund} you={Math.max(0, 100 - burn - fund)} />
      {over && <span className="pl-place-hint error">Burn and fund add up to more than 100%</span>}
      <span className="pl-place-hint">Applies to fees collected from now on. This cannot be undone.</span>
      <TxButton
        tx={tx}
        disabled={!changed || over}
        busyLabel="Saving on Base..."
        onClick={() => tx.send({ label: 'Raise economics', to: v.address, abi: CREATOR_VAULT_ABI, functionName: 'increaseEconomics', args: [Math.round(burn * 100), Math.round(fund * 100)] })}
      >
        Raise shares
      </TxButton>
      <TxResult tx={tx} success="Shares raised" />
    </div>
  );
}

export function VaultPanel({ item, PayoutForm }) {
  const t = item.token;
  const v = item.vault;
  const q = t.quote;
  const [open, setOpen] = useState(null);
  const claimTx = usePlaceTx();
  const processTx = usePlaceTx();
  const defaultTx = usePlaceTx();
  const fmtQ = (raw) => `${formatAmount(raw || 0, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
  const fmtT = (raw) => `${formatAmount(raw || 0, 18, { maxDecimals: 2 })} ${t.symbol}`;
  if (v.error) return <Card className="pl-launch-fee"><Alert tone="warn">{v.error}</Alert></Card>;
  const c = v.claim;
  const paid = c.error ? 0n : BigInt(c.paid || 0);
  const e = v.economics;
  const totals = item.totals;
  return (
    <Card className="pl-launch-fee">
      <div className="pl-launch-fee-head">
        <TokenLogo token={t} size={40} />
        <div className="pl-launch-launch-title">
          <Link to={launchTokenPath(t.address)} className="pl-launch-strong pl-launch-fee-name">
            {t.name}
          </Link>
          <span className="pl-launch-muted">
            {t.symbol}/{q.symbol}
          </span>
        </div>
        <PayoutForm vault={v.address} current={v.payout} />
      </div>

      <EconomicsBar burn={e.burnBps / 100} fund={e.communityBps / 100} you={e.creatorBps / 100} />

      <div className="pl-launch-fee-grid three">
        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Wallet size={14} /> Your fees
          </span>
          {c.error ? <span className="pl-place-hint error">{vaultReason(c.error, q)}</span> : <span className="pl-launch-fee-value mono">{fmtQ(c.paid)}</span>}
          <span className="pl-launch-fee-sub">Claiming also runs the burn when it is due.</span>
          <TxButton tx={claimTx} size="sm" disabled={paid === 0n} busyLabel="Claiming on Base..." onClick={() => claimTx.send({ label: 'Claim fees', to: c.tx.to, data: c.tx.data, value: 0n })}>
            {paid === 0n ? 'Nothing to claim yet' : 'Claim'}
          </TxButton>
          <TxResult tx={claimTx} success="Claimed" />
        </div>

        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Flame size={14} /> Burn
          </span>
          <span className="pl-launch-fee-value mono">{fmtQ(BigInt(v.burn.reserve) + BigInt(v.burn.pending))}</span>
          <span className="pl-launch-fee-sub">
            {v.process.canRun && v.process.tokensBurned ? `Process now: ~${fmtT(v.process.tokensBurned)} burned` : vaultReason(v.process.reason, q) || 'Waiting for trading fees'}
            {` · up to ${fmtQ(v.burn.maxPerProcess)} per run`}
          </span>
          <TxButton tx={processTx} size="sm" variant="secondary" disabled={!v.process.canRun} busyLabel="Processing on Base..." onClick={() => processTx.send({ label: 'Run process', to: v.process.tx.to, data: v.process.tx.data, value: 0n })}>
            Run process()
          </TxButton>
          <TxResult tx={processTx} success="Processed" />
        </div>

        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Users size={14} /> Community fund
          </span>
          <span className="pl-launch-fee-value mono">{fmtQ(v.balances.fundAfterCollect)}</span>
          <span className="pl-launch-fee-sub">
            {e.communityBps ? `Unused until ${formatUtc(v.defaultCampaign.nextAt)} → default holder campaign` : 'No fund share. Raise it below to start one.'}
          </span>
          <div className="pl-launch-inline">
            <Button size="sm" variant={open === 'fund' ? 'primary' : 'secondary'} disabled={!e.communityBps && BigInt(v.balances.fundAfterCollect) === 0n} onClick={() => setOpen(open === 'fund' ? null : 'fund')}>
              Use the fund
            </Button>
            {v.defaultCampaign.canStart && (
              <TxButton tx={defaultTx} size="sm" variant="ghost" busyLabel="Starting on Base..." onClick={() => defaultTx.send({ label: 'Default campaign', to: v.defaultCampaign.tx.to, data: v.defaultCampaign.tx.data, value: 0n })}>
                Default campaign
              </TxButton>
            )}
          </div>
          <TxResult tx={defaultTx} success="Campaign created" />
        </div>
      </div>

      {open === 'fund' && <FundForm t={t} v={v} onDone={() => setOpen(null)} />}
      {open === 'econ' && <EconomicsForm v={v} onDone={() => setOpen(null)} />}

      <div className="pl-launch-fee-totals">
        {totals && (
          <>
            <span>
              Collected <span className="mono">{fmtQ(totals.collected)}</span>
            </span>
            <span>
              Paid to you <span className="mono">{fmtQ(totals.creatorPaid)}</span>
            </span>
            <span>
              Burned <span className="mono">{fmtT(totals.burnedTokens)}</span>
            </span>
            <span>
              To the fund <span className="mono">{fmtQ(totals.toFund)}</span> · {totals.campaigns} campaigns, {totals.stakingPrograms} staking
            </span>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen(open === 'econ' ? null : 'econ')}>
          <TrendingUp size={14} /> Raise burn or fund
        </Button>
        <Badge tone="neutral">{t.version}</Badge>
      </div>
    </Card>
  );
}
