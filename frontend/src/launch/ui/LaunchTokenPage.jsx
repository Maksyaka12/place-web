// A launch token (/launch/token/:address): the header (logo, name, ticker, address with copy; the
// pair chip, Tax for Economy tokens, the standard, Immutable or Editable), the stat row (each value with the pair
// amount under it), the chart with its toolbar, Info (creator, created, trading fee for tokens without economy;
// lifetime volume, creator and protocol revenue), the tabs and Disclosures; Swap on the right.
// Each release shows its own economics (`generation`: 1 = 0.1.0, 2 = 0.2.0, 3 = 0.3.x).
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Globe, Send, Rocket, Maximize2, Minimize2 } from 'lucide-react';
import { Card, Badge, EmptyState, Button, InfoTip } from '../../themes/place/components/ui';
import { CopyAddress, AddressLink, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useNow } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { useLaunchToken, useCandles, useLaunchHolders, useProfile, useCollections } from '../hooks.js';
import { CandleChart } from './CandleChart.jsx';
import { SwapPanel } from './SwapPanel.jsx';
import { TokenLogo, PairChip, launchPath } from './parts.jsx';
import { tokenEconomy, tradePct } from '../economy.js';
import { money } from './TokenCard.jsx';
import { EconomyTab, BurnTab, Disclosures, units } from './TokenEconomy.jsx';
import { RewardsTab, StakingTab, NftTab, CampaignsTab, useTokenCampaigns, activeStaking } from './TokenRewards.jsx';
import { useLaunchLive, useLiveToken, useLiveTrades, useLiveCandles } from '../live.js';
import { usd, price as priceText, compact, age } from '../format.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
/** The range buttons under the chart: how far back, and the candle that fits it. */
const RANGES = [
  ['3m', 90 * 86_400, '1d'],
  ['1m', 30 * 86_400, '4h'],
  ['5d', 5 * 86_400, '1h'],
  ['1d', 86_400, '15m'],
];

/** The interval whose ~60 candles (what fits a phone) cover the token's whole life. */
function defaultInterval(createdAt) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  if (hours < 1) return '1m';
  if (hours < 5) return '5m';
  if (hours < 15) return '15m';
  if (hours < 60) return '1h';
  if (hours < 240) return '4h';
  return '1d';
}

/** True while the viewport matches `query` (the swap moves under the chart on narrow screens). */
function useMedia(query) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

function XIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function Links({ links }) {
  const items = [
    links?.website && { href: links.website, label: 'Website', Icon: Globe },
    links?.x && { href: links.x, label: 'X', Icon: XIcon },
    links?.telegram && { href: links.telegram, label: 'Telegram', Icon: Send },
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <div className="pl-launch-links">
      {items.map(({ href, label, Icon }) => (
        <a key={label} className="pl-launch-link-pill" href={href} target="_blank" rel="noopener noreferrer nofollow">
          <Icon size={14} />
          {label}
        </a>
      ))}
    </div>
  );
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The chart card with its toolbar: interval, USD / PAIR, MarketCap / Price and fullscreen on top; the ranges and a
 * UTC clock under it. Drawn by our own SVG CandleChart (no drawing tools or indicators).
 */
function Chart({ token }) {
  const [iv, setIv] = useState(() => defaultInterval(token.createdAt));
  const [range, setRange] = useState(null);
  const [inUsd, setInUsd] = useState(token.quote.usd != null);
  const [mode, setMode] = useState('price');
  const [full, setFull] = useState(false);
  const card = useRef(null);
  const now = useNow(1000);
  const { data, isLoading } = useCandles(token.address, iv);
  const candles = useLiveCandles(data?.candles || [], data?.indexedBlock, token.poolId, iv);
  const usdOk = token.quote.usd != null;
  const usdOn = inUsd && usdOk;
  // Market cap = price × the supply the API counts (market cap ÷ price), or the full supply.
  const supply = token.price > 0 && token.marketCap > 0 ? token.marketCap / token.price : token.supply || 1e9;
  const scale = (usdOn ? token.quote.usd : 1) * (mode === 'mcap' ? supply : 1);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === card.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else card.current?.requestFullscreen?.();
  };
  const since = range ? Math.floor(now / 1000) - RANGES.find(([id]) => id === range)[1] : null;
  const d = new Date(now);
  return (
    <div className="card pl-launch-chart-card" ref={card}>
      <div className="pl-launch-chart-toolbar">
        <select
          className="pl-launch-chart-select mono"
          value={iv}
          aria-label="Candle interval"
          onChange={(e) => {
            setIv(e.target.value);
            setRange(null);
          }}
        >
          {INTERVALS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <span className="pl-launch-chart-sep" />
        <span className="pl-launch-chart-toggle" role="group" aria-label="Currency">
          <button type="button" aria-pressed={usdOn} disabled={!usdOk} onClick={() => setInUsd(true)}>
            USD
          </button>
          <span>/</span>
          <button type="button" aria-pressed={!usdOn} onClick={() => setInUsd(false)}>
            {token.quote.symbol}
          </button>
        </span>
        <span className="pl-launch-chart-sep" />
        <span className="pl-launch-chart-toggle" role="group" aria-label="Value">
          <button type="button" aria-pressed={mode === 'mcap'} onClick={() => setMode('mcap')}>
            MarketCap
          </button>
          <span>/</span>
          <button type="button" aria-pressed={mode === 'price'} onClick={() => setMode('price')}>
            Price
          </button>
        </span>
        <span className="pl-launch-chart-sep" />
        <button type="button" className="pl-place-icon-btn" aria-label={full ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFull}>
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      <CandleChart
        candles={candles}
        interval={iv}
        scale={scale}
        unit={usdOn ? '$' : token.quote.symbol}
        loading={isLoading}
        since={since}
        height={full ? Math.max(320, (typeof window !== 'undefined' ? window.innerHeight : 800) - 130) : undefined}
      />
      <div className="pl-launch-chart-foot">
        <span className="pl-launch-chart-ranges" role="group" aria-label="Range">
          {RANGES.map(([id, , interval]) => (
            <button
              key={id}
              type="button"
              aria-pressed={range === id}
              onClick={() => {
                setRange(id);
                setIv(interval);
              }}
            >
              {id}
            </button>
          ))}
        </span>
        <span className="mono pl-launch-muted pl-launch-small">
          {pad2(d.getUTCHours())}:{pad2(d.getUTCMinutes())}:{pad2(d.getUTCSeconds())} UTC
        </span>
      </div>
    </div>
  );
}

/** "0.0₆1844 ETH" with "approx $0.0₄39" under it. */
function PairAndUsd({ value, q, priceLike = false }) {
  return (
    <>
      <span>{priceLike ? priceText(value, q.symbol) : `${compact(value, { decimals: 6 })} ${q.symbol}`}</span>
      {q.usd != null && <span className="pl-launch-muted pl-launch-small">approx {usd(value * q.usd)}</span>}
    </>
  );
}

function Trades({ token, trades, now, empty }) {
  if (!trades.length && empty) return <EmptyState title={`No ${empty}s in the latest trades`} description="Switch to All to see every trade." />;
  if (!trades.length) return <EmptyState title="No trades yet" description="Trades show up here seconds after they land on Base." />;
  const q = token.quote;
  return (
    <div className="pl-launch-table">
      <div className="pl-launch-table-head pl-launch-trades-grid">
        <span>Time</span>
        <span>Type</span>
        <span>Price</span>
        <span>Amount</span>
        <span>Value</span>
        <span>Wallet</span>
      </div>
      {trades.map((t) => (
        <a key={t.cursor} className={`pl-launch-table-row pl-launch-trades-grid ${t.live ? `pl-launch-row-new ${t.side}` : ''}`.trim()} href={explorerTx(t.tx)} target="_blank" rel="noopener noreferrer">
          <span className="pl-launch-muted">{age(t.at, now)} ago</span>
          <span className={t.side === 'buy' ? 'pl-launch-buy' : 'pl-launch-sell'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
          <span className="mono pl-launch-cell-stack">
            <PairAndUsd value={t.price} q={q} priceLike />
          </span>
          <span className="mono">
            {compact(t.tokens)} {token.symbol}
          </span>
          <span className="mono pl-launch-cell-stack">
            <PairAndUsd value={t.quote} q={q} />
          </span>
          <span className="mono pl-launch-muted pl-launch-ellipsis">{t.trader ? shortAddress(t.trader) : '…'}</span>
        </a>
      ))}
    </div>
  );
}

const TAG_LABEL = { pool: 'Pool', hook: 'Hook', burned: 'Burned', vault: 'Creator vault', creator: 'Creator', staking: 'Staking', community: 'Community Pool', escrow: 'Fee escrow', rewards: 'Rewards' };

function Holders({ token }) {
  const { data, isLoading } = useLaunchHolders(token.address);
  if (isLoading) return <Skeleton height={200} />;
  const list = data?.list || [];
  if (!list.length) return <EmptyState title="No holders yet" description="Holders appear after the first buy." />;
  return (
    <div className="pl-launch-table">
      <div className="pl-launch-table-head pl-launch-holders-grid">
        <span>#</span>
        <span>Account</span>
        <span className="num">Share</span>
        <span className="num">{token.symbol}</span>
      </div>
      {list.map((h, i) => (
        <div key={h.account} className="pl-launch-table-row pl-launch-holders-grid">
          <span className="mono pl-launch-muted">{i + 1}</span>
          <span className="pl-launch-holder">
            <AddressLink address={h.account} />
            {h.tag && <Badge tone={h.tag === 'creator' ? 'accent' : 'neutral'}>{TAG_LABEL[h.tag] || h.tag}</Badge>}
          </span>
          <span className="num mono">{h.share < 0.01 ? '<0.01' : h.share.toFixed(2)}%</span>
          <span className="num mono">{compact(Number(formatAmount(h.balance, 18, { maxDecimals: 2 }).replace(/,/g, '')))}</span>
        </div>
      ))}
    </div>
  );
}

const SIDES = [
  ['all', 'All'],
  ['buy', 'Buy'],
  ['sell', 'Sell'],
];

/**
 * The tabs. Economy token: Transactions · Holders · Economy · Burn · Holder rewards · Trader rewards
 * (each only with its bucket) · Staking · NFT (with a paired collection) · Campaigns (when there are any). Standard
 * token: Transactions · Holders · Economy · Staking · NFT · Campaigns. The open tab lives in ?tab=.
 */
function TokenTabs({ data, token, econ, now, collections }) {
  const [params, setParams] = useSearchParams();
  const [side, setSide] = useState('all');
  const trades = useLiveTrades(data.trades, data.indexedBlock, token.poolId, 50);
  const campaigns = useTokenCampaigns(data);
  const economy = econ?.type === 'economy';
  const legacy = token.generation < 3;
  const tabs = [
    { id: 'transactions', label: 'Transactions' },
    { id: 'holders', label: 'Holders' },
    { id: 'economy', label: 'Economy' },
    ((economy && econ.shares.burn > 0) || (legacy && (econ?.shares.burn > 0 || token.economics?.buybackBps > 0 || data.burns?.count > 0))) && { id: 'burn', label: 'Burn' },
    economy && econ.shares.holders > 0 && { id: 'holders-rewards', label: 'Holder rewards' },
    economy && econ.shares.traders > 0 && { id: 'traders-rewards', label: 'Trader rewards' },
    { id: 'staking', label: 'Staking', count: activeStaking(data) || null },
    { id: 'nft', label: 'NFT' },
    { id: 'campaigns', label: 'Campaigns' },
  ].filter(Boolean);
  const active = tabs.some((x) => x.id === params.get('tab')) ? params.get('tab') : 'transactions';
  const strip = useRef(null);
  // On a phone the tab row scrolls sideways: keep the open tab in view (only the strip moves, not the page).
  useEffect(() => {
    const el = strip.current;
    const btn = el?.querySelector('[aria-selected="true"]');
    if (!el || !btn) return;
    const box = el.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    el.scrollLeft = Math.max(0, el.scrollLeft + b.left - box.left - (box.width - b.width) / 2);
  }, [active]);
  const open = (id) => {
    const next = new URLSearchParams(params);
    if (id === 'transactions') next.delete('tab');
    else next.set('tab', id);
    setParams(next, { replace: true });
  };
  const shown = side === 'all' ? trades : trades.filter((t) => t.side === side);
  return (
    <Card className="pl-launch-activity">
      <div className="pl-launch-tabs-scroll" ref={strip}>
        <div className="pl-launch-tabs pl-launch-token-tabs" role="tablist" aria-label="Token details">
          {tabs.map((x) => (
            <span key={x.id} className="pl-launch-token-tab">
              <button type="button" role="tab" aria-selected={active === x.id} onClick={() => open(x.id)}>
                {x.label}
              </button>
              {x.id === 'transactions' && active === 'transactions' && (
                <span className="pl-launch-side-filter" role="group" aria-label="Trade side">
                  {SIDES.map(([id, label]) => (
                    <button key={id} type="button" aria-pressed={side === id} onClick={() => setSide(id)}>
                      {label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      <div role="tabpanel" className={active === 'transactions' || active === 'holders' ? 'pl-launch-tab-flush' : 'pl-launch-tab-panel'}>
        {active === 'transactions' && <Trades token={token} trades={shown} now={now} empty={side !== 'all' && trades.length > 0 ? side : null} />}
        {active === 'holders' && <Holders token={token} />}
        {active === 'economy' && <EconomyTab data={data} econ={econ} now={now} />}
        {active === 'burn' && <BurnTab data={data} econ={econ} now={now} />}
        {active === 'holders-rewards' && <RewardsTab data={data} econ={econ} kind="holders" now={now} />}
        {active === 'traders-rewards' && <RewardsTab data={data} econ={econ} kind="traders" now={now} />}
        {active === 'staking' && <StakingTab data={data} />}
        {active === 'nft' && <NftTab token={token} collections={collections} now={now} />}
        {active === 'campaigns' && <CampaignsTab data={data} campaigns={campaigns} />}
      </div>
    </Card>
  );
}

/** A USD value's pair amount for the line under it ("178.78 TTWO"); null without a USD price. */
function pairSub(valueUsd, value, q, decimals = 4) {
  return valueUsd != null && value != null ? `${compact(value, { decimals })} ${q.symbol}` : null;
}

/** Short explanations behind the (i) of the stat row and Info. */
const TIPS = {
  'Market cap': 'Current token price multiplied by the fixed launch supply. USD uses the current paired-asset price.',
  'Token price': 'Price of one token in the pool right now, in USD and in the paired asset.',
  'Volume 24h': 'Value of all buys and sells in the last 24 hours, in the paired asset and its USD value.',
  'Pool liquidity': 'Value of everything in the token pool: the paired asset plus the tokens, priced at the current pool price.',
  'Total supply': 'Every launch mints a fixed 1 billion tokens. Nobody can mint more.',
  Holders: 'Wallets that hold any amount of the token right now.',
  'Buy / sell tax': "Taken on every buy and every sell by the Place hook and split by the token's economy. Fixed at launch.",
  'Trading fee': 'Taken on every buy and sell: 70% goes to the creator and 30% to Place. Fixed at launch.',
  'Lifetime volume': 'Value of every buy and sell since launch.',
  'Creator revenue': 'Fees and taxes paid to the creator since launch.',
  'Protocol revenue': "Place's share of fees and taxes since launch, including the anti-snipe fee of the first seconds.",
};

const Label = ({ label }) => (
  <>
    {label}
    {TIPS[label] && <InfoTip text={TIPS[label]} label={`About ${label.toLowerCase()}`} />}
  </>
);

/** The stat row under the header. Buy / sell tax only for Economy tokens. */
function Stats({ token: t, econ }) {
  const q = t.quote;
  const items = [
    { label: 'Market cap', value: money(t.marketCapUsd, t.marketCap, q.symbol), sub: pairSub(t.marketCapUsd, t.marketCap, q) },
    { label: 'Token price', value: t.priceUsd != null ? usd(t.priceUsd) : priceText(t.price, q.symbol), sub: t.priceUsd != null ? priceText(t.price, q.symbol) : null },
    { label: 'Volume 24h', value: money(t.volume24hUsd, t.volume24h, q.symbol), sub: pairSub(t.volume24hUsd, t.volume24h, q) },
    { label: 'Pool liquidity', value: money(t.liquidity.valueUsd, t.liquidity.value, q.symbol), sub: pairSub(t.liquidity.valueUsd, t.liquidity.value, q) },
    { label: 'Total supply', value: compact(t.supply || 1e9) },
    { label: 'Holders', value: compact(t.holders) },
    econ?.type === 'economy' && { label: 'Buy / sell tax', value: `${econ.buyTax}% / ${econ.sellTax}%` },
  ].filter(Boolean);
  return (
    <dl className="pl-launch-stats">
      {items.map((s) => (
        <div key={s.label}>
          <dt>
            <Label label={s.label} />
          </dt>
          <dd className="mono pl-launch-stats-value">{s.value}</dd>
          {s.sub && <dd className="mono pl-launch-stats-sub">{s.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

/** Info: creator, created (and the trading fee for tokens without economy); lifetime volume and revenue. */
function Info({ data, token: t, econ, now }) {
  const { data: prof } = useProfile(t.creator);
  const name = prof?.profile?.name;
  const q = t.quote;
  const r = data.revenue;
  const rev = (raw) => {
    const v = units(raw, q.decimals);
    return { value: q.usd != null ? usd(v * q.usd) : `${compact(v, { decimals: 4 })} ${q.symbol}`, sub: q.usd != null ? `${compact(v, { decimals: 4 })} ${q.symbol}` : null };
  };
  const cells = [
    { label: 'Lifetime volume', value: money(t.volumeAllUsd, t.volumeAll, q.symbol), sub: pairSub(t.volumeAllUsd, t.volumeAll, q) },
    r && { label: 'Creator revenue', ...rev(r.creator) },
    r && { label: 'Protocol revenue', ...rev(String(BigInt(r.protocol || 0) + BigInt(r.antiSnipe || 0))) },
  ].filter(Boolean);
  const created = new Date(t.createdAt);
  return (
    <div className="pl-launch-info">
      <span className="pl-launch-section-title">Info</span>
      <dl className="pl-launch-info-grid">
        <div>
          <dt>Creator</dt>
          <dd className="pl-launch-inline">
            {name && <span className="pl-launch-strong">{name}</span>}
            <AddressLink address={t.creator} />
            <CopyAddress address={t.creator} />
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {t.createdTx ? (
              <a className="pl-place-link" href={explorerTx(t.createdTx)} target="_blank" rel="noopener noreferrer">
                {formatUtc(created).replace(/, \d\d:\d\d UTC$/, '')}
              </a>
            ) : (
              formatUtc(created).replace(/, \d\d:\d\d UTC$/, '')
            )}
            <span className="pl-launch-muted"> ({age(t.createdAt, now)} ago)</span>
          </dd>
        </div>
        {econ?.type !== 'economy' && (
          <div>
            <dt>
              <Label label="Trading fee" />
            </dt>
            <dd className="mono">{econ ? tradePct(econ.buyTax) : '1%'}</dd>
          </div>
        )}
      </dl>
      <dl className="pl-launch-info-grid">
        {cells.map((c) => (
          <div key={c.label}>
            <dt>
              <Label label={c.label} />
            </dt>
            <dd className="mono pl-launch-info-value">{c.value}</dd>
            {c.sub && <dd className="mono pl-launch-stats-sub">{c.sub}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function LaunchTokenPage() {
  const { address } = useParams();
  const now = useNow(5000);
  const { data, error, isLoading, refetch } = useLaunchToken(address);
  const narrow = useMedia('(max-width: 1100px)');
  useLaunchLive();
  const live = useLiveToken(data?.token, data?.indexedBlock);
  const nft = useCollections({ token: address?.toLowerCase() }, { enabled: Boolean(address) });

  if (isLoading) {
    return (
      <div className="pl-launch">
        <Skeleton height={80} />
        <Skeleton height={360} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="pl-launch">
        <Link to={launchPath()} className="pl-place-back">
          <ArrowLeft size={14} />
          All tokens
        </Link>
        {error.status === 404 ? (
          <Card className="pl-place-empty-card">
            <EmptyState
              icon={<Rocket size={28} />}
              title="Not a Place Launch token yet"
              description="A token launched seconds ago may take a moment to show up. If this address came from somewhere else, it was not launched on Place."
              action={<Button onClick={() => refetch()}>Check again</Button>}
            />
          </Card>
        ) : (
          <QueryError error={error} retry={refetch} />
        )}
      </div>
    );
  }

  const t = live;
  const econ = tokenEconomy(t);
  const collections = (nft.data?.deployed && nft.data.collections) || [];
  return (
    <div className="pl-launch pl-launch-token">
      <Link to={launchPath()} className="pl-place-back">
        <ArrowLeft size={14} />
        All tokens
      </Link>

      <header className="pl-launch-token-head">
        <TokenLogo token={t} size={56} />
        <div className="pl-launch-token-title">
          <div className="pl-launch-token-name">
            <h1 className="page-title">{t.name}</h1>
            <span className="pl-launch-muted">{t.symbol}</span>
            <span className="pl-launch-muted mono pl-launch-small">{shortAddress(t.address)}</span>
            <CopyAddress address={t.address} />
          </div>
          <div className="pl-launch-token-sub">
            <PairChip quote={t.quote} />
            {econ?.type === 'economy' && <Badge tone="warn">Tax</Badge>}
            <Badge tone="neutral">{t.kind === 'b20' ? 'B20' : 'ERC20'}</Badge>
            {t.metadataEditable ? <Badge tone="neutral">Editable</Badge> : <Badge tone="success">Immutable</Badge>}
          </div>
        </div>
        <Links links={t.links} />
      </header>

      <Stats token={t} econ={econ} />

      <div className="pl-launch-token-cols">
        <div className="pl-place-stack">
          <Chart token={t} />
          {narrow && <SwapPanel token={t} />}
          <Info data={data} token={t} econ={econ} now={now} />
          <TokenTabs data={data} token={t} econ={econ} now={now} collections={collections} />
          <Disclosures data={data} econ={econ} />
        </div>
        {!narrow && (
          <div className="pl-place-stack">
            <SwapPanel token={t} />
          </div>
        )}
      </div>
    </div>
  );
}
