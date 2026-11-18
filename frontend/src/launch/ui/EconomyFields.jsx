// The Economy step of the launch form: Standard or Economy, buy and sell taxes, the five-bucket allocation (a ring
// chart with sliders whose tracks show what other buckets hold), per-side breakdowns, and the rules of the
// reward buckets (minimum holding, minimum daily volume, reward token).
import { useState } from 'react';
import { RotateCcw, Lock, Flame, Users, Gift, BarChart3 } from 'lucide-react';
import { Badge } from '../../themes/place/components/ui';
import {
  BUCKETS,
  DEFAULT_ALLOCATION,
  TAX_MIN_PCT,
  TAX_MAX_PCT,
  MIN_HOLDING_TOKENS,
  allocationTotal,
  taxSplit,
  tradePct,
} from '../economy.js';
import { RewardTokenButton, RewardTokenPicker } from './RewardTokenPicker.jsx';

const SUPPLY = 1_000_000_000;

export function LaunchTypePicker({ value, onChange }) {
  const types = [
    {
      id: 'standard',
      title: 'Standard',
      badge: '1% fee',
      desc: 'A plain token. Every trade pays 1%: 0.7% to you, 0.3% to Place. No taxes, rewards or burn.',
    },
    {
      id: 'economy',
      title: 'Economy',
      badge: 'Up to 5% tax',
      desc: 'Set buy and sell taxes and split them between you, holders, traders, burn and a community pool.',
    },
  ];
  return (
    <div className="pl-launch-kinds" role="radiogroup" aria-label="Launch type">
      {types.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className="card pl-launch-kind" onClick={() => onChange(t.id)}>
          <span className="pl-launch-kind-title">
            {t.title}
            <Badge tone={value === t.id ? 'accent' : 'neutral'}>{t.badge}</Badge>
          </span>
          <span className="pl-launch-kind-desc">{t.desc}</span>
        </button>
      ))}
    </div>
  );
}

function TaxSlider({ label, value, onChange }) {
  return (
    <div className="pl-econ-tax">
      <div className="pl-econ-tax-head">
        <span className="pl-launch-strong">{label}</span>
        <label className="pl-econ-num">
          <input
            type="number"
            min={TAX_MIN_PCT}
            max={TAX_MAX_PCT}
            step={0.5}
            value={value}
            onChange={(e) => onChange(Math.min(TAX_MAX_PCT, Math.max(TAX_MIN_PCT, Number(e.target.value) || TAX_MIN_PCT)))}
            aria-label={`${label} in percent`}
          />
          <span>%</span>
        </label>
      </div>
      <input type="range" min={TAX_MIN_PCT} max={TAX_MAX_PCT} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="pl-econ-range" style={{ '--v': value }} />
      <div className="pl-econ-range-ends">
        <span>{TAX_MIN_PCT}%</span>
        <span>{TAX_MAX_PCT}%</span>
      </div>
    </div>
  );
}

/** The allocation as a ring: one arc per bucket, the total in the middle (with Reset in the form). */
export function AllocationRing({ allocation, onReset, label = 'allocated', buckets = BUCKETS, total: shownTotal }) {
  const r = 70;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const total = shownTotal ?? buckets.reduce((s, b) => s + (Number(allocation[b.id]) || 0), 0);
  return (
    <div className="pl-econ-ring">
      <svg viewBox="0 0 180 180" aria-hidden="true">
        <circle cx="90" cy="90" r={r} className="pl-econ-ring-track" />
        {buckets.map((b) => {
          const v = Number(allocation[b.id]) || 0;
          if (!v) return null;
          const len = (v / 100) * c;
          const el = <circle key={b.id} cx="90" cy="90" r={r} className={`pl-econ-ring-arc ${b.tone}`} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
      </svg>
      <div className="pl-econ-ring-center">
        <span className="pl-econ-ring-total mono">{total}%</span>
        <span className="pl-launch-muted pl-launch-small">{label}</span>
        {onReset && (
          <button type="button" className="pl-econ-reset" onClick={onReset}>
            <RotateCcw size={12} /> Reset
          </button>
        )}
      </div>
    </div>
  );
}

/** A bucket slider. The part of the track other buckets already hold is hatched and can't be taken. */
export function BucketSlider({ bucket, value, others, onChange }) {
  const free = 100 - others;
  return (
    <div className="pl-econ-bucket">
      <div className="pl-econ-tax-head">
        <span className="pl-econ-bucket-label">
          <span className={`pl-econ-dot ${bucket.tone}`} />
          {bucket.label}
        </span>
        <label className="pl-econ-num">
          <input
            type="number"
            min={0}
            max={free}
            step={1}
            value={value}
            onChange={(e) => onChange(Math.min(free, Math.max(0, Math.round(Number(e.target.value) || 0))))}
            aria-label={`${bucket.label} in percent`}
          />
          <span>%</span>
        </label>
      </div>
      <div className="pl-econ-bucket-track" style={{ '--free': `${free}%` }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Math.min(free, Number(e.target.value)))}
          aria-label={bucket.label}
          className={`pl-econ-range ${bucket.tone}`}
          style={{ '--fill': `${value}%` }}
        />
      </div>
    </div>
  );
}

function TaxCard({ side, taxPct, allocation }) {
  const s = taxSplit(taxPct, allocation);
  return (
    <div className="pl-econ-taxcard">
      <span className="pl-launch-strong">
        {side} tax: {tradePct(taxPct)}
      </span>
      <span className="pl-launch-muted pl-launch-small">
        Place: {tradePct(s.protocol)}. Your allocation: {tradePct(s.rest)} of the trade.
      </span>
      <dl>
        {BUCKETS.filter((b) => allocation[b.id] > 0).map((b) => (
          <div key={b.id}>
            <dt>{b.label}</dt>
            <dd className="mono">{tradePct(s[b.id])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The Economy fields. `value`: { buyTax, sellTax, allocation, minHolding, minTraderVolume, rewardToken }.
 * `rewardTokens`: the options of `launch/reward-tokens` ({ address, symbol, source, category, logo, ... }).
 */
export function EconomyFields({ value, onChange, pair, symbol, rewardTokens, errors = {} }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const [picking, setPicking] = useState(false);
  const a = value.allocation;
  const total = allocationTotal(a);
  const rewards = a.holders > 0 || a.traders > 0;
  const tokenLabel = symbol ? `$${symbol}` : 'your token';
  const volumeUsd = pair?.usd != null && Number(value.minTraderVolume) > 0 ? Number(value.minTraderVolume) * pair.usd : null;

  return (
    <div className="pl-econ">
      <div className="pl-launch-two even">
        <TaxSlider label="Buy tax" value={value.buyTax} onChange={(v) => set({ buyTax: v })} />
        <TaxSlider label="Sell tax" value={value.sellTax} onChange={(v) => set({ sellTax: v })} />
      </div>
      <p className="pl-place-hint">Place takes 30% of each tax. The rest is yours to allocate below.</p>

      <div className="pl-econ-alloc-head">
        <div>
          <h3 className="pl-launch-section-title">Tax allocation</h3>
          <p className="pl-launch-section-desc">Split the tax left after Place. Hatched parts of a track are held by other buckets.</p>
        </div>
        <Badge tone={total === 100 ? 'success' : 'warn'} pill>
          {total === 100 ? 'Fully allocated' : `${100 - total}% left`}
        </Badge>
      </div>
      <div className="pl-econ-alloc">
        <AllocationRing allocation={a} onReset={() => set({ allocation: { ...DEFAULT_ALLOCATION } })} />
        <div className="pl-econ-buckets">
          {BUCKETS.map((b) => (
            <BucketSlider
              key={b.id}
              bucket={b}
              value={a[b.id]}
              others={total - a[b.id]}
              onChange={(v) => set({ allocation: { ...a, [b.id]: v } })}
            />
          ))}
        </div>
      </div>

      <div className="pl-launch-two even">
        <TaxCard side="Buy" taxPct={value.buyTax} allocation={a} />
        <TaxCard side="Sell" taxPct={value.sellTax} allocation={a} />
      </div>

      {a.holders > 0 && (
        <label className="pl-place-field">
          <span className="pl-launch-field-label">
            <Gift size={13} className="pl-econ-icon holders" /> Minimum holding for holder rewards (tokens)
          </span>
          <input
            value={value.minHolding}
            onChange={(e) => set({ minHolding: e.target.value.replace(/\D/g, '') })}
            className="mono"
            inputMode="numeric"
            placeholder={String(MIN_HOLDING_TOKENS)}
          />
          {errors.minHolding ? (
            <span className="pl-place-hint error">{errors.minHolding}</span>
          ) : (
            <span className="pl-place-hint">
              From {MIN_HOLDING_TOKENS.toLocaleString('en-US')} to {SUPPLY.toLocaleString('en-US')} tokens. Wallets holding at least this many at the end of a UTC day share that day&apos;s holder rewards, in proportion to their balance.
            </span>
          )}
        </label>
      )}

      {a.traders > 0 && (
        <label className="pl-place-field">
          <span className="pl-launch-field-label">
            <BarChart3 size={13} className="pl-econ-icon traders" /> Minimum daily volume for trader rewards
          </span>
          <div className="pl-launch-prefixed suffix">
            <input value={value.minTraderVolume} onChange={(e) => set({ minTraderVolume: e.target.value.replace(/[^\d.]/g, '') })} className="mono" inputMode="decimal" placeholder="0.01" />
            <span>{pair?.symbol || ''}</span>
          </div>
          {errors.minTraderVolume ? (
            <span className="pl-place-hint error">{errors.minTraderVolume}</span>
          ) : (
            <span className="pl-place-hint">
              {volumeUsd != null ? `About $${volumeUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}. ` : ''}Wallets that buy and sell at least this much of {tokenLabel} in a UTC day share that day&apos;s trader rewards, in proportion to their volume.
            </span>
          )}
        </label>
      )}

      {rewards && (
        <div className="pl-place-field">
          <span className="pl-launch-field-label">Reward token</span>
          <RewardTokenButton token={rewardTokens.find((t) => t.address === value.rewardToken)} tokenLabel={tokenLabel} onClick={() => setPicking(true)} />
          <span className="pl-place-hint">
            Taxes arrive in {pair?.symbol || 'the pair asset'}. If you pick another token, the rewards contract swaps each day&apos;s rewards into it before
            they are shared, so holders and traders claim it directly.
          </span>
          {picking && (
            <RewardTokenPicker
              tokens={rewardTokens}
              value={value.rewardToken}
              tokenLabel={tokenLabel}
              pairSymbol={pair?.symbol}
              onPick={(rewardToken) => set({ rewardToken })}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
      )}

      <ul className="pl-launch-econ-notes">
        {a.burn > 0 && (
          <li>
            <Flame size={14} className="pl-econ-icon burn" />
            <span>Burn: this part of the tax is taken in {tokenLabel} itself. It collects on the token page, and anyone can press Burn to send it to 0x…dEaD.</span>
          </li>
        )}
        {a.community > 0 && (
          <li>
            <Users size={14} className="pl-econ-icon community" />
            <span>
              Community pool: a vault you cannot withdraw from. You turn it into reward campaigns for holders and traders or staking programs. Left unused for 30 days, anyone can start a holder campaign from it.
            </span>
          </li>
        )}
        <li>
          <Lock size={14} className="pl-launch-muted" />
          <span>Taxes, the allocation and the reward rules are fixed at launch and can never change.</span>
        </li>
      </ul>
    </div>
  );
}
