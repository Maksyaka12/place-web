// Token page tabs about the money flow: Economy (taxes, the bucket ring and what each bucket gets of a trade),
// Burn (what waits to be burned and the button anyone can press) and Disclosures (the facts a buyer should know).
// 0.3.0 and 0.2.0 share the Economy view (tokenEconomy); 0.1.0 keeps its buyback / rewards block.
import { ExternalLink, Flame, Gift, Lock, ShieldCheck, Users, Coins, Clock, Repeat, Sparkles, FileText, BarChart3 } from 'lucide-react';
import { Badge, EmptyState, Tile } from '../../themes/place/components/ui';
import { AddressLink, TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { BUCKETS, tradePct } from '../economy.js';
import { usePoolConfig, useCommunityBalance } from '../hooks.js';
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

/** "+20 s", "Off" for the anti-snipe window from the hook's pool config. */
function antiSnipeText(econ, pool) {
  if (econ?.antiSnipe === false || pool?.data?.antiSnipe === null) return { value: 'Off', sub: 'The first trades pay the normal fee' };
  const a = pool?.data?.antiSnipe;
  const start = a ? `${Number((a.startRate / 1e6).toFixed(2))}%` : '99%';
  return { value: a ? `${a.windowSeconds} seconds` : 'On', sub: `Fee falls from ${start} after launch` };
}

/**
 * The split of an Economy tax after Place: one row per bucket with its share of what is left after Place and what
 * it takes of a buy and of a sell, in % of the trade. Place is not a row: it is in the tax tiles above.
 */
function ShareTable({ econ }) {
  const { buy, sell } = econ.perTrade;
  const label = (b) => (econ.generation === 2 && b.id === 'community' ? 'Community fund' : b.id === 'creator' ? 'Creator' : b.id === 'burn' ? 'Burn' : b.id === 'community' ? 'Community Pool' : b.label);
  const fee = econ.type === 'economy' ? 'tax' : 'fee';
  const rows = econ.generation === 2 ? BUCKETS.filter((b) => b.id === 'creator' || econ.shares[b.id] > 0) : BUCKETS;
  return (
    <div className="pl-launch-table pl-launch-share-table">
      <div className="pl-launch-table-head pl-launch-share-grid">
        <span>Bucket</span>
        <span className="num">Share</span>
        <span className="num">Buy {fee}</span>
        <span className="num">Sell {fee}</span>
      </div>
      {rows.map((b) => {
        const off = !(econ.shares[b.id] > 0);
        return (
          <div key={b.id} className={`pl-launch-table-row pl-launch-share-grid ${off ? 'off' : ''}`.trim()}>
            <span className="pl-econ-bucket-label">
              <span className={`pl-econ-dot ${b.tone}`} />
              {label(b)}
              {b.id === 'creator' && econ.xPct > 0 && <span className="pl-launch-muted pl-launch-small">, {econ.xPct}% of it to X accounts</span>}
            </span>
            <span className="num mono">{Number(Number(econ.shares[b.id] || 0).toFixed(2))}%</span>
            <span className="num mono">{tradePct(buy[b.id] || 0)}</span>
            <span className="num mono">{tradePct(sell[b.id] || 0)}</span>
          </div>
        );
      })}
      <div className="pl-launch-table-row pl-launch-share-grid pl-launch-share-total">
        <span className="pl-launch-strong">After Place</span>
        <span className="num mono">100%</span>
        <span className="num mono pl-launch-strong">{tradePct(buy.rest)}</span>
        <span className="num mono pl-launch-strong">{tradePct(sell.rest)}</span>
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

/** 0.2.0: the community fund and the dates of the daily burn and the default campaign. */
function FundFacts({ data, econ, now }) {
  const t = data.token;
  const q = t.quote;
  const fund = data.fund;
  const totals = data.vault?.totals;
  const nextProcess = fund?.process?.nextAt ? new Date(fund.process.nextAt).getTime() : null;
  if (!fund && !totals) return null;
  return (
    <dl className="pl-place-kv">
      {fund && (
        <div>
          <dt>
            <Users size={13} /> Community fund
          </dt>
          <dd className="mono">
            {amount(units(fund.balance, q.decimals), q.symbol)}
            {fund.pending !== '0' && <span className="pl-launch-muted"> +{amount(units(fund.pending, q.decimals), q.symbol)} pending</span>}
          </dd>
        </div>
      )}
      {totals && (
        <>
          <div>
            <dt>Fees collected by the vault</dt>
            <dd className="mono">{amount(units(totals.collected, q.decimals), q.symbol)}</dd>
          </div>
          <div>
            <dt>Sent to the fund</dt>
            <dd className="mono">{amount(units(totals.toFund, q.decimals), q.symbol)}</dd>
          </div>
        </>
      )}
      {fund && econ.shares.burn > 0 && (
        <div>
          <dt>
            <Clock size={13} /> Next burn
          </dt>
          <dd>{nextProcess && nextProcess > now ? formatUtc(fund.process.nextAt) : 'Due now, Place runs it daily'}</dd>
        </div>
      )}
      {fund && econ.shares.community > 0 && (
        <div>
          <dt>Default campaign</dt>
          <dd>{new Date(fund.defaultCampaign.nextAt).getTime() > now ? `If unused until ${formatUtc(fund.defaultCampaign.nextAt)}` : 'Anyone can start it now'}</dd>
        </div>
      )}
    </dl>
  );
}

/** Standard 0.3.x tokens: one trading fee and its split between the creator and the platform (like a plain fee tab). */
function StandardFees({ data, econ }) {
  const t = data.token;
  const pool = usePoolConfig(t.poolId, t.hook);
  const fee = econ.buyTax;
  const platform = fee ? (econ.perTrade.buy.protocol / fee) * 100 : 30;
  const creator = 100 - platform;
  const snipe = antiSnipeText(econ, pool);
  return (
    <div className="pl-launch-tab-body pl-econ-palette">
      <div className="pl-launch-section-head">
        <p className="pl-launch-section-desc">A Standard token: one fee on every buy and sell, fixed at launch. No taxes, rewards or burn.</p>
        <span className="pl-launch-inline">
          <Badge tone="neutral">Standard</Badge>
          <Badge tone="success">
            <Lock size={11} /> Immutable
          </Badge>
        </span>
      </div>
      <div className="pl-launch-tab-tiles three">
        <Tile label="Trading fee" value={tradePct(fee)} sub="on every buy and sell" />
        <Tile label="Anti-snipe window" value={snipe.value} sub={snipe.sub} />
        <Tile label="Paid in" value={t.quote.symbol} sub="the pool's pair asset" />
      </div>
      <div className="pl-launch-tab-section">
        <span className="pl-launch-field-label">Fee split</span>
        <div className="pl-launch-tab-tiles three">
          <Tile label="Creator share" value={`${Number(creator.toFixed(2))}%`} sub={`${tradePct(econ.perTrade.buy.rest)} of each trade`} />
          <Tile label="Platform share" value={`${Number(platform.toFixed(2))}%`} sub={`${tradePct(econ.perTrade.buy.protocol)} of each trade`} />
        </div>
      </div>
      {data.revenue && <RevenueList data={data} econ={econ} />}
    </div>
  );
}

export function EconomyTab({ data, econ, now, rewardInfo }) {
  const t = data.token;
  const q = t.quote;
  const pool = usePoolConfig(econ ? t.poolId : null, t.hook);
  const community = useCommunityBalance(econ?.generation >= 3 && econ.shares.community > 0 ? econ.communityVault || data.communityVault : null);
  if (!econ) return <LegacyEconomy data={data} />;
  if (econ.type === 'standard' && econ.generation >= 3) return <StandardFees data={data} econ={econ} />;
  const economy = econ.type === 'economy';
  const rewards = econ.shares.holders > 0 || econ.shares.traders > 0;
  const { buy, sell } = econ.perTrade;
  const same = Math.abs(buy.rest - sell.rest) < 1e-9;
  const snipe = antiSnipeText(econ, pool);
  const vault = econ.communityVault || data.communityVault;
  const desc =
    econ.generation === 2
      ? 'Each trade pays 1%. Place takes its part first; the creator vault splits the rest like this. The burn and fund shares can only go up.'
      : 'Every buy and sell pays a tax. Place takes its part first, the rest is split between the buckets below. Everything here was fixed at launch.';
  return (
    <div className="pl-launch-tab-body pl-econ-palette">
      <div className="pl-launch-section-head">
        <p className="pl-launch-section-desc">{desc}</p>
        <span className="pl-launch-inline">
          {econ.generation >= 3 && <Badge tone="accent">Economy</Badge>}
          {econ.generation >= 3 ? (
            <Badge tone="success">
              <Lock size={11} /> Immutable
            </Badge>
          ) : (
            <Badge tone="neutral">{t.version}</Badge>
          )}
        </span>
      </div>
      <div className="pl-launch-tab-tiles three">
        <Tile label={economy ? 'Buy tax' : 'Buy fee'} value={tradePct(econ.buyTax)} sub={`includes ${tradePct(buy.protocol)} Place`} />
        <Tile label={economy ? 'Sell tax' : 'Sell fee'} value={tradePct(econ.sellTax)} sub={`includes ${tradePct(sell.protocol)} Place`} />
        {econ.generation >= 3 && <Tile label="Anti-snipe window" value={snipe.value} sub={snipe.sub} />}
      </div>
      <div className="pl-econ-alloc pl-launch-econ-alloc">
        <AllocationRing
          allocation={econ.shares}
          center={same ? tradePct(buy.rest) : `${tradePct(buy.rest)} / ${tradePct(sell.rest)}`}
          label={same ? 'of each trade after Place' : 'buy / sell after Place'}
        />
        <ShareTable econ={econ} />
      </div>
      {economy && (rewards || vault) && (
        <div className="pl-launch-tab-tiles pl-launch-econ-rules">
          {econ.shares.holders > 0 && (
            <Tile
              icon={<Gift size={14} className="pl-econ-icon holders" />}
              label="Minimum holding"
              value={econ.minHolding ? `${compact(units(econ.minHolding, 18, 0))} ${t.symbol}` : '—'}
              sub="for holder rewards, at 00:00 UTC"
            />
          )}
          {econ.shares.traders > 0 && (
            <Tile
              icon={<BarChart3 size={14} className="pl-econ-icon traders" />}
              label="Minimum daily volume"
              value={econ.minTraderDailyVolume && BigInt(econ.minTraderDailyVolume) > 0n ? amount(units(econ.minTraderDailyVolume, q.decimals), q.symbol) : 'Any trade'}
              sub="buys and sells in a UTC day"
            />
          )}
          {rewards && <Tile icon={<Coins size={14} />} label="Reward token" value={rewardTokenLabel(econ, t, rewardInfo)} sub="what holders and traders get" />}
          {vault && econ.shares.community > 0 && (
            <Tile
              icon={<Users size={14} className="pl-econ-icon community" />}
              label="Community Pool"
              value={community.data ? amount(units(community.data.total, q.decimals), q.symbol) : community.isLoading ? '…' : '—'}
              sub={<AddressLink address={vault} />}
            />
          )}
        </div>
      )}
      {econ.generation === 2 && <FundFacts data={data} econ={econ} now={now} />}
      {econ.generation >= 3 && data.revenue && <RevenueList data={data} econ={econ} />}
    </div>
  );
}

/** Lifetime credits per bucket (0.3.x), without Place (its revenue is in the token's Info block). */
function RevenueList({ data, econ }) {
  const t = data.token;
  const q = t.quote;
  const r = data.revenue;
  const rows = [
    ['Creator', r.creator, econ.shares.creator > 0],
    ['Holder rewards', r.holders, econ.shares.holders > 0],
    ['Trader rewards', r.traders, econ.shares.traders > 0],
    ['Community Pool', r.community, econ.shares.community > 0],
  ].filter((x) => x[2]);
  return (
    <div className="pl-launch-tab-section">
      <span className="pl-launch-field-label">Collected since launch</span>
      <dl className="pl-place-kv">
        {rows.map(([label, raw]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{quoteText(String(raw), q)}</dd>
          </div>
        ))}
        {econ.shares.burn > 0 && (
          <div>
            <dt>Burn</dt>
            <dd className="mono">{amount(units(r.burnTokens, 18, 2), t.symbol)}</dd>
          </div>
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

export function Disclosures({ data, econ }) {
  const t = data.token;
  const economy = econ?.type === 'economy';
  const items = [
    { Icon: Lock, title: 'Liquidity locked', text: 'All liquidity sits in the token’s Place pool on Uniswap v4 and can never be withdrawn, by the creator or by Place.' },
    {
      Icon: Coins,
      title: 'No reserved supply',
      text: `All 1,000,000,000 tokens went into the pool at launch. The creator got no allocation${t.devBuy ? `; they bought ${compact(units(t.devBuy.amountOut, 18, 0))} ${t.symbol} through the pool at launch, like any buyer` : ''}.`,
    },
    {
      Icon: ShieldCheck,
      title: econ?.antiSnipe === false ? 'No anti-snipe fee' : 'Anti-snipe fee',
      text:
        econ?.antiSnipe === false
          ? 'The creator turned the anti-snipe fee off: the first trades pay the normal fee.'
          : 'Trades in the first seconds after launch pay a much higher fee that falls to the normal fee, so bots gain little from buying first. The extra goes to Place.',
    },
    {
      Icon: Repeat,
      title: 'Fee split',
      text: !econ
        ? 'Each trade pays 1%: 0.25% to Place and 0.75% to the creator vault (0.1.0).'
        : economy
          ? `Buy tax ${tradePct(econ.buyTax)}, sell tax ${tradePct(econ.sellTax)}. Place takes 30% of the tax; the rest goes to the buckets on the Economy tab.`
          : econ.generation === 2
            ? 'Each trade pays 1%: 0.3% to Place, 0.7% to the creator vault (creator, burn and community fund).'
            : 'Each trade pays 1%: 0.3% to Place and 0.7% to the creator.',
    },
    {
      Icon: Sparkles,
      title: 'Where the fee applies',
      text: 'Only on buys and sells in the token’s Place pool. Sending the token between wallets is free, and pools made elsewhere pay nothing to this token.',
    },
    {
      Icon: Flame,
      title: 'Burn',
      text:
        econ?.generation >= 3
          ? econ.shares.burn > 0
            ? `${econ.shares.burn}% of the tax after Place is taken in the token itself and sent to 0x…dEaD when anyone presses Burn tokens. There is no buyback.`
            : 'No part of the tax is burned.'
          : econ?.shares.burn > 0
            ? `${econ.shares.burn}% of the creator vault’s fees buy the token back in its pool once a day and burn it.`
            : 'No burn share.',
    },
    {
      Icon: Lock,
      title: 'What can change',
      text:
        econ?.generation >= 3
          ? `Nothing in the fees: taxes, shares and reward rules were fixed at launch. ${t.metadataEditable ? 'The name and logo can be edited; the ticker cannot.' : 'Name, logo and ticker are fixed too.'}`
          : `${econ ? 'The burn and fund shares can only go up.' : 'The fee split is fixed.'} ${t.metadataEditable ? 'The name and logo can be edited; the ticker cannot.' : 'Name, logo and ticker are fixed.'}`,
    },
  ];
  if (econ && (econ.shares.holders > 0 || econ.shares.traders > 0)) {
    items.push({
      Icon: FileText,
      title: 'How daily rewards are counted',
      text: 'Place computes each UTC day’s holder and trader table from the chain and publishes it on IPFS with a Merkle root. The rewards contract never pays out more than the tax funded, and rewards never expire.',
    });
  }
  return (
    <ul className="pl-launch-disclosures">
      {items.map(({ Icon, title, text }) => (
        <li key={title}>
          <Icon size={16} />
          <span>
            <span className="pl-launch-strong">{title}</span>
            <span className="pl-launch-muted">{text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
