// Token page tabs about the money flow: Economy (the taxes, the donut after protocol and the
// split table; Standard tokens: the trading fee and its base split), Burn (what waits to be burned and the button
// anyone can press) and Disclosures (the facts a buyer should know, two plain columns). 0.1.0 keeps its buyback block.
import { ExternalLink, Flame, Gift } from 'lucide-react';
import { EmptyState, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { BUCKETS, tradePct } from '../economy.js';
import { usePoolConfig } from '../hooks.js';
import { AllocationRing } from './EconomyFields.jsx';
import { compact, age, bpsText, amount } from '../format.js';

/** Raw units → a number in whole units (for compact display). */
export const units = (raw, decimals = 18, maxDecimals = 8) => Number(formatAmount(raw ?? 0, decimals, { maxDecimals }).replace(/,/g, ''));

/** A raw amount of the pair asset: "0.0123 ETH (~$41.20)". */
export function quoteText(raw, q) {
  const v = units(raw, q.decimals);
  return `${amount(v, q.symbol)}${q.usd != null && v > 0 ? ` (~$${(v * q.usd).toLocaleString('en-US', { maximumFractionDigits: 2 })})` : ''}`;
}

/** The reward token of an Economy token as a label. */
export function rewardTokenLabel(econ, t, rewardInfo) {
  const r = econ?.rewardToken;
  if (!r) return null;
  if (r === 'eth') return 'ETH';
  if (r === t.address) return `$${t.symbol} (the token itself)`;
  if (r === t.quote.address) return `${t.quote.symbol} (the pair, no swap)`;
  return rewardInfo?.symbol || shortAddress(r);
}

// ─────────────────────────────── Economy ───────────────────────────────

/** "20 seconds" or "Disabled" for the anti-snipe window, from the hook's pool config. */
function antiSnipeText(econ, pool) {
  if (econ?.antiSnipe === false || pool?.data?.antiSnipe === null) return 'Disabled';
  const a = pool?.data?.antiSnipe;
  return a ? `${a.windowSeconds} seconds` : 'Enabled';
}

const ROW_LABEL = { creator: 'Creator allocation', holders: 'Holder rewards', traders: 'Trader rewards', burn: 'Burn allocation', community: 'Community Pool' };

/** The split after protocol: one row per bucket with its share and what it takes of a buy and of a sell. */
function ShareTable({ econ }) {
  const { buy, sell } = econ.perTrade;
  const rows = econ.generation === 2 ? BUCKETS.filter((b) => b.id === 'creator' || econ.shares[b.id] > 0) : BUCKETS;
  return (
    <div className="pl-launch-split-table">
      <div className="pl-launch-split-row head">
        <span />
        <span className="num">Share</span>
        <span className="num">Buy tax</span>
        <span className="num">Sell tax</span>
      </div>
      {rows.map((b) => (
        <div key={b.id} className="pl-launch-split-row">
          <span className="pl-econ-bucket-label">
            <span className={`pl-econ-dot ${b.tone}`} />
            {econ.generation === 2 && b.id === 'community' ? 'Community fund' : ROW_LABEL[b.id]}
          </span>
          <span className="num mono pl-launch-strong">{Number(Number(econ.shares[b.id] || 0).toFixed(2))}%</span>
          <span className="num mono">{tradePct(buy[b.id] || 0)}</span>
          <span className="num mono">{tradePct(sell[b.id] || 0)}</span>
        </div>
      ))}
    </div>
  );
}

/** A small label over a value. */
function Figure({ label, value, sub }) {
  return (
    <div className="pl-launch-figure">
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
      {sub && <dd className="pl-launch-figure-sub">{sub}</dd>}
    </div>
  );
}

/** Standard 0.3.x tokens: the trading fee, anti-snipe, then the base fee split. */
function StandardFees({ data, econ }) {
  const t = data.token;
  const pool = usePoolConfig(t.poolId, t.hook);
  const fee = econ.buyTax;
  const platform = fee ? (econ.perTrade.buy.protocol / fee) * 100 : 30;
  return (
    <div className="pl-launch-tab-body">
      <dl className="pl-launch-figures">
        <Figure label="Trading fee" value={tradePct(fee)} />
        <Figure label="Anti-snipe window" value={antiSnipeText(econ, pool)} />
      </dl>
      <div className="pl-launch-tab-section">
        <span className="pl-launch-strong">Base fee split</span>
        <dl className="pl-launch-figures">
          <Figure label="Creator share" value={`${(100 - platform).toFixed(2)}%`} />
          <Figure label="Platform share" value={`${platform.toFixed(2)}%`} />
        </dl>
      </div>
    </div>
  );
}

/** Economy tokens (and 0.2.0): the taxes small, the donut after protocol beside the split. */
export function EconomyTab({ data, econ }) {
  const t = data.token;
  const pool = usePoolConfig(econ ? t.poolId : null, t.hook);
  if (!econ) return <LegacyEconomy data={data} />;
  if (econ.type === 'standard' && econ.generation >= 3) return <StandardFees data={data} econ={econ} />;
  const economy = econ.type === 'economy';
  const { buy, sell } = econ.perTrade;
  const same = Math.abs(buy.rest - sell.rest) < 1e-9;
  return (
    <div className="pl-launch-tab-body">
      <dl className="pl-launch-figures">
        <Figure label={economy ? 'Buy tax' : 'Buy fee'} value={tradePct(econ.buyTax)} sub={`Includes ${tradePct(buy.protocol)} protocol`} />
        <Figure label={economy ? 'Sell tax' : 'Sell fee'} value={tradePct(econ.sellTax)} sub={`Includes ${tradePct(sell.protocol)} protocol`} />
        {econ.generation >= 3 && <Figure label="Anti-snipe window" value={antiSnipeText(econ, pool)} />}
      </dl>
      <div className="pl-launch-tab-section">
        <span className="pl-launch-strong">Split after protocol</span>
        <p className="pl-launch-section-desc">These shares split the tax left after protocol. Buy and sell columns show each share as a percent of the trade. Fixed at launch.</p>
      </div>
      <div className="pl-econ-palette pl-launch-split">
        <AllocationRing allocation={econ.shares} center={same ? tradePct(buy.rest) : `${tradePct(buy.rest)} / ${tradePct(sell.rest)}`} label="After protocol" />
        <ShareTable econ={econ} />
      </div>
    </div>
  );
}

/** 0.1.0 tokens: buyback and holder rewards shares of the creator vault. */
function LegacyEconomy({ data }) {
  const t = data.token;
  const e = t.economics;
  const totals = data.vault?.totals;
  const q = t.quote;
  const xPct = (e.xShares || []).reduce((s, x) => s + Number(x.bps), 0);
  const youBps = 10_000 - e.buybackBps - e.rewardsBps - xPct;
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">
        Launched with Place Launch 0.1.0: each trade pays 1%, 0.75% to the creator vault and 0.25% to Place. The vault splits the creator part like this.
      </p>
      <dl className="pl-place-kv">
        <div>
          <dt>
            <Flame size={13} /> Buyback
          </dt>
          <dd>
            <span className="mono">{bpsText(e.buybackBps)}</span> {e.buybackBps ? (e.buybackBurn ? 'and burn' : 'kept by the creator') : ''}
          </dd>
        </div>
        <div>
          <dt>
            <Gift size={13} /> Holder rewards
          </dt>
          <dd className="mono">{bpsText(e.rewardsBps)}</dd>
        </div>
        {xPct > 0 && (
          <div>
            <dt>X accounts</dt>
            <dd className="mono">{bpsText(xPct)}</dd>
          </div>
        )}
        <div>
          <dt>Creator</dt>
          <dd className="mono">{bpsText(youBps)}</dd>
        </div>
        {totals && (
          <>
            <div>
              <dt>Fees collected</dt>
              <dd className="mono">{amount(units(totals.collected, q.decimals), q.symbol)}</dd>
            </div>
            <div>
              <dt>{e.buybackBurn ? 'Bought back and burned' : 'Bought back'}</dt>
              <dd className="mono">{amount(units(totals.boughtBackTokens, 18, 2), t.symbol)}</dd>
            </div>
            <div>
              <dt>Sent to holder rewards</dt>
              <dd className="mono">{amount(units(totals.toCampaigns, q.decimals), q.symbol)}</dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}

// ─────────────────────────────── Burn ───────────────────────────────

function BurnRows({ list, t, now, quoteIn }) {
  return (
    <div className="pl-launch-hub-list">
      {list.slice(0, 12).map((b) => (
        <a key={b.tx} className="pl-launch-hub-row" href={explorerTx(b.tx)} target="_blank" rel="noopener noreferrer">
          <span className="pl-launch-inline">
            <Flame size={13} className="pl-launch-burn-icon" />
            <span className="mono">
              {compact(units(b.amount ?? b.tokens, 18, 2))} {t.symbol}
            </span>
          </span>
          <span className="pl-launch-hub-row-right">
            {quoteIn && b.quoteIn != null && <span className="mono pl-launch-muted">{compact(units(b.quoteIn, t.quote.decimals), { decimals: 6 })} {t.quote.symbol}</span>}
            {b.caller && <span className="mono pl-launch-muted">by {shortAddress(b.caller)}</span>}
            <span className="mono pl-launch-muted">{age(b.at, now)}</span>
            <ExternalLink size={12} />
          </span>
        </a>
      ))}
    </div>
  );
}

function BurnV3({ data, econ, now }) {
  const t = data.token;
  const burn = data.burn;
  const { address } = usePlaceAccount();
  const tx = usePlaceTx();
  const pending = BigInt(burn?.pendingBurn || 0);
  if (!econ.shares.burn && !burn?.count) {
    return <EmptyState icon={<Flame size={26} />} title="No burn share" description="This token sends no part of its tax to the burn address. Burns from other wallets don't show here." />;
  }
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">
        {econ.shares.burn > 0
          ? `${tradePct(econ.perTrade.buy.burn)} of each buy and ${tradePct(econ.perTrade.sell.burn)} of each sell is taken in $${t.symbol} and waits in the fee escrow. Anyone can press Burn tokens to send it to 0x…dEaD for good.`
          : 'This token has no burn share. Anything waiting in the fee escrow for it can still be burned by anyone.'}
      </p>
      <div className="pl-launch-tab-tiles three">
        <Tile label="Ready to burn" value={`${compact(units(burn?.pendingBurn, 18, 2))}`} sub={`${t.symbol}${burn?.pendingLive ? '' : ', from the index'}`} />
        <Tile label="At the burn address" value={compact(t.burned)} sub={`${t.symbol}, ${t.supply ? ((t.burned / t.supply) * 100).toFixed(2) : '0'}% of supply`} />
        <Tile label="Burned with the button" value={compact(units(burn?.burned, 18, 2))} sub={`${burn?.count || 0} burns`} />
      </div>
      <div className="pl-launch-tab-actions">
        {address ? (
          <TxButton tx={tx} disabled={!burn?.tx || pending === 0n} busyLabel="Burning on Base..." onClick={() => tx.send({ label: 'Burn tokens', to: burn.tx.to, data: burn.tx.data, value: 0n })}>
            <Flame size={15} /> {pending === 0n ? 'Nothing to burn yet' : `Burn ${compact(units(burn.pendingBurn, 18, 2))} ${t.symbol}`}
          </TxButton>
        ) : (
          <ConnectButton>Connect wallet to burn</ConnectButton>
        )}
        {!burn?.tx && <span className="pl-place-hint">The fee escrow of this release is not deployed yet.</span>}
      </div>
      <TxResult tx={tx} success="Tokens burned" />
      {burn?.list?.length ? <BurnRows list={burn.list} t={t} now={now} /> : <p className="pl-launch-muted pl-launch-small">No burns yet.</p>}
    </div>
  );
}

/** 0.2.0 and 0.1.0: buybacks and burns of the creator vault. */
function BurnLegacy({ data, econ, now }) {
  const t = data.token;
  const burns = data.burns;
  const fund = data.fund;
  if (!burns?.count && !econ?.shares.burn && !t.economics?.buybackBps) {
    return <EmptyState icon={<Flame size={26} />} title="No burn share" description="This token's creator vault has no burn share." />;
  }
  const nextProcess = fund?.process?.nextAt ? new Date(fund.process.nextAt).getTime() : null;
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">
        {econ ? 'Once a day the creator vault buys the token in its own pool with the burn share and sends it to 0x…dEaD.' : 'The 0.1.0 vault buys back the token when the creator claims.'}
      </p>
      <div className="pl-launch-tab-tiles three">
        <Tile label="At the burn address" value={compact(t.burned)} sub={t.symbol} />
        <Tile label="Burns" value={String(burns?.count || 0)} sub={burns?.totalTokens ? `${compact(units(burns.totalTokens, 18, 2))} ${t.symbol}` : ''} />
        {econ && fund && <Tile label="Next burn" value={nextProcess && nextProcess > now ? formatUtc(fund.process.nextAt).replace(' UTC', '') : 'Due now'} sub="UTC, run daily by Place" />}
      </div>
      {burns?.list?.length ? <BurnRows list={burns.list} t={t} now={now} quoteIn /> : <p className="pl-launch-muted pl-launch-small">No burns yet. The first comes with the first daily process after trading starts.</p>}
    </div>
  );
}

export function BurnTab({ data, econ, now }) {
  return data.token.generation >= 3 ? <BurnV3 data={data} econ={econ} now={now} /> : <BurnLegacy data={data} econ={econ} now={now} />;
}

// ─────────────────────────────── Disclosures ───────────────────────────────

/** Disclosures under the tabs: bold titles with a short text, two columns, no cards. */
export function Disclosures({ data, econ }) {
  const t = data.token;
  const economy = econ?.type === 'economy';
  const v3 = econ?.generation >= 3;
  const items = [
    {
      title: 'Locked liquidity and limited control',
      text: 'The liquidity position is locked for good. The creator cannot mint more tokens, pause or freeze trading, or remove liquidity.',
    },
    {
      title: 'No reserved supply',
      text: `No tokens were sent to wallets or vested at launch: all ${compact(t.supply || 1e9)} went into the pool${t.devBuy ? `. The creator bought ${compact(units(t.devBuy.amountOut, 18, 0))} ${t.symbol} through the pool, like any buyer` : ''}.`,
    },
    {
      title: 'Anti-sniping protection',
      text: econ?.antiSnipe === false ? 'Disabled for this launch. The normal fee applies from the first trade.' : 'For the first seconds after launch the fee starts very high and falls to the normal fee, so buying first gains little.',
    },
    {
      title: 'Fee split',
      text: !econ
        ? 'Each trade pays 1%: 0.25% to the protocol and 0.75% to the creator vault.'
        : economy
          ? `Buy tax ${tradePct(econ.buyTax)} and sell tax ${tradePct(econ.sellTax)}, protocol included. The rest is split as shown on the Economy tab.`
          : `Each trade pays ${tradePct(econ.buyTax)}, protocol included. The rest goes to the creator${econ.generation === 2 ? ' vault (creator, burn and community fund)' : ''}.`,
    },
    {
      title: 'Where tax applies',
      text: 'Only to buys and sells in this launch pool. Wallet transfers and pools made elsewhere pay nothing.',
    },
    (v3 ? econ.shares.burn > 0 : econ?.shares.burn > 0) && {
      title: 'Burn',
      text: v3 ? `The burn allocation collects ${t.symbol} from the tax. Anyone can send it to 0x…dEaD from the Burn tab.` : 'Part of the creator vault’s fees buys the token back once a day and burns it.',
    },
    economy &&
      (econ.shares.holders > 0 || econ.shares.traders > 0) && {
        title: 'Holder and trader rewards',
        text: 'Each UTC day’s table is computed from the chain and published on IPFS with a Merkle root. Rewards are shared after 00:00 UTC and never expire.',
      },
    {
      title: 'What can change',
      text: `${v3 ? 'Nothing in the fees.' : econ ? 'The burn and fund shares can only go up.' : 'The fee split is fixed.'} ${t.metadataEditable ? 'The name and logo can be edited; the ticker cannot.' : 'Name, logo and ticker are fixed.'}`,
    },
  ].filter(Boolean);
  return (
    <div className="pl-launch-disclosures-block">
      <span className="pl-launch-section-title">Disclosures</span>
      <ul className="pl-launch-disclosures">
        {items.map(({ title, text }) => (
          <li key={title}>
            <span className="pl-launch-strong">{title}</span>
            <span className="pl-launch-muted">{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
