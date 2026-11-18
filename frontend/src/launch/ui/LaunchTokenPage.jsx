// A launch token (/launch/token/:address), laid out like a trading terminal: the header with the token's facts
// (creator, created, lifetime volume, creator and protocol revenue), the chart, then tabs: Transactions, Holders,
// Economy, Updates, Burn, Rewards (0.3.0), Staking / Campaigns and Disclosures; the swap card on the right.
// Each release shows its own economics (`generation`: 1 = 0.1.0, 2 = 0.2.0, 3 = 0.3.0).
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Globe, ExternalLink, Send, Users, Rocket } from 'lucide-react';
import { Card, Tile, Badge, EmptyState, Button } from '../../themes/place/components/ui';
import { CopyAddress, AddressLink, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useNow } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { useLaunchToken, useCandles, useLaunchHolders, useProfile } from '../hooks.js';
import { CandleChart } from './CandleChart.jsx';
import { SwapPanel } from './SwapPanel.jsx';
import { TokenLogo, KindBadge, NewBadge, Change, launchPath, consolePath } from './parts.jsx';
import { tokenEconomy } from '../economy.js';
import { money } from './TokenCard.jsx';
import { EconomyTab, BurnTab, DisclosuresTab, units } from './TokenEconomy.jsx';
import { RewardsTab, StakingTab, CampaignsTab, UpdatesTab, activeStaking } from './TokenRewards.jsx';
import { useLaunchLive, useLiveToken, useLiveTrades, useLiveCandles, freshTrades, liveTradesOf } from '../live.js';
import { usd, price as priceText, compact, age } from '../format.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

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

function Chart({ token }) {
  const [iv, setIv] = useState(() => defaultInterval(token.createdAt));
  const { data, isLoading } = useCandles(token.address, iv);
  const candles = useLiveCandles(data?.candles || [], data?.indexedBlock, token.poolId, iv);
  const inUsd = token.quote.usd != null;
  return (
    <Card className="pl-launch-chart-card">
      <div className="pl-launch-chart-head">
        <span className="pl-launch-section-title">Price</span>
        <div className="seg soft pl-launch-intervals" role="tablist" aria-label="Candle interval">
          {INTERVALS.map((i) => (
            <button key={i} type="button" role="tab" aria-selected={iv === i} onClick={() => setIv(i)}>
              {i}
            </button>
          ))}
        </div>
      </div>
      <CandleChart candles={candles} interval={iv} scale={inUsd ? token.quote.usd : 1} unit={inUsd ? '$' : token.quote.symbol} loading={isLoading} />
    </Card>
  );
}

function Trades({ token, trades, now }) {
  if (!trades.length) return <EmptyState title="No trades yet" description="Trades show up here seconds after they land on Base." />;
  const q = token.quote;
  return (
    <div className="pl-launch-table">
      <div className="pl-launch-table-head pl-launch-trades-grid">
        <span>Age</span>
        <span>Type</span>
        <span className="num">Price</span>
        <span className="num">{token.symbol}</span>
        <span className="num">{q.symbol}</span>
        <span>Trader</span>
      </div>
      {trades.map((t) => (
        <a key={t.cursor} className={`pl-launch-table-row pl-launch-trades-grid ${t.live ? `pl-launch-row-new ${t.side}` : ''}`.trim()} href={explorerTx(t.tx)} target="_blank" rel="noopener noreferrer">
          <span className="mono pl-launch-muted">{age(t.at, now)}</span>
          <span className={t.side === 'buy' ? 'pl-launch-buy' : 'pl-launch-sell'}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
          <span className="num mono">{q.usd != null ? usd(t.price * q.usd) : priceText(t.price)}</span>
          <span className="num mono">{compact(t.tokens)}</span>
          <span className="num mono">{compact(t.quote, { decimals: 4 })}</span>
          <span className="mono pl-launch-muted pl-launch-ellipsis">{t.trader ? shortAddress(t.trader) : '…'}</span>
        </a>
      ))}
    </div>
  );
}

const TAG_LABEL = { pool: 'Pool', hook: 'Hook', burned: 'Burned', vault: 'Creator vault', creator: 'Creator', staking: 'Staking' };

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

/** The tabs under the chart. The open tab lives in ?tab= so it survives a reload and can be linked. */
function TokenTabs({ data, token, econ, now }) {
  const [params, setParams] = useSearchParams();
  const trades = useLiveTrades(data.trades, data.indexedBlock, token.poolId, 50);
  const fresh = freshTrades(liveTradesOf(token.poolId), data.indexedBlock);
  const buys = data.activity24h.buys + fresh.filter((t) => t.side === 'buy').length;
  const sells = data.activity24h.sells + fresh.filter((t) => t.side === 'sell').length;
  const v3 = token.generation >= 3;
  const tabs = [
    { id: 'transactions', label: 'Transactions' },
    { id: 'holders', label: 'Holders', count: token.holders },
    { id: 'economy', label: 'Economy' },
    { id: 'updates', label: 'Updates', count: data.announcements?.length || null },
    { id: 'burn', label: 'Burn' },
    v3 && { id: 'rewards', label: 'Rewards' },
    { id: 'staking', label: 'Staking', count: activeStaking(data) || null },
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'disclosures', label: 'Disclosures' },
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
  return (
    <Card className="pl-launch-activity">
      <div className="pl-launch-activity-head">
        <div className="pl-launch-tabs-scroll" ref={strip}>
          <div className="seg soft" role="tablist" aria-label="Token details">
            {tabs.map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={active === x.id} onClick={() => open(x.id)}>
                {x.label}
                {x.count != null && <span className="mono">{x.count}</span>}
              </button>
            ))}
          </div>
        </div>
        {active === 'transactions' && (
          <span className="pl-launch-muted pl-launch-activity-sub">
            24h: <span className="pl-launch-buy mono">{buys} buys</span> · <span className="pl-launch-sell mono">{sells} sells</span> · <span className="mono">{data.activity24h.traders}</span> traders
          </span>
        )}
      </div>
      <div role="tabpanel" className={active === 'transactions' || active === 'holders' ? '' : 'pl-launch-tab-panel'}>
        {active === 'transactions' && <Trades token={token} trades={trades} now={now} />}
        {active === 'holders' && <Holders token={token} />}
        {active === 'economy' && <EconomyTab data={data} econ={econ} now={now} />}
        {active === 'updates' && <UpdatesTab data={data} now={now} />}
        {active === 'burn' && <BurnTab data={data} econ={econ} now={now} />}
        {active === 'rewards' && <RewardsTab data={data} econ={econ} now={now} />}
        {active === 'staking' && <StakingTab data={data} />}
        {active === 'campaigns' && <CampaignsTab data={data} econ={econ} />}
        {active === 'disclosures' && <DisclosuresTab data={data} econ={econ} />}
      </div>
    </Card>
  );
}

/** Creator, Created, Lifetime volume and (0.3.0) Creator and Protocol revenue, under the header. */
function Facts({ data, token: t }) {
  const { data: prof } = useProfile(t.creator);
  const name = prof?.profile?.name;
  const q = t.quote;
  const r = data.revenue;
  const rev = (raw) => {
    const v = units(raw, q.decimals);
    return q.usd != null ? usd(v * q.usd) : `${compact(v, { decimals: 4 })} ${q.symbol}`;
  };
  return (
    <dl className="pl-launch-facts">
      <div>
        <dt>Creator</dt>
        <dd className="pl-launch-inline">
          {name && <span className="pl-launch-strong">{name}</span>}
          <AddressLink address={t.creator} />
        </dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd>
          {t.createdTx ? (
            <a className="pl-place-link" href={explorerTx(t.createdTx)} target="_blank" rel="noopener noreferrer">
              {formatUtc(t.createdAt)} <ExternalLink size={12} />
            </a>
          ) : (
            formatUtc(t.createdAt)
          )}
        </dd>
      </div>
      <div>
        <dt>Lifetime volume</dt>
        <dd className="mono">{money(t.volumeAllUsd, t.volumeAll, q.symbol)}</dd>
      </div>
      {r && (
        <>
          <div>
            <dt>Creator revenue</dt>
            <dd className="mono">{rev(r.creator)}</dd>
          </div>
          <div>
            <dt>Protocol revenue</dt>
            <dd className="mono">{rev(String(BigInt(r.protocol || 0) + BigInt(r.antiSnipe || 0)))}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

function About({ data, econ }) {
  const t = data.token;
  return (
    <Card className="pl-launch-about">
      <span className="pl-launch-section-title">About</span>
      <dl className="pl-place-kv">
        <div>
          <dt>Contract</dt>
          <dd className="pl-launch-inline">
            <AddressLink address={t.address} />
            <CopyAddress address={t.address} />
          </dd>
        </div>
        <div>
          <dt>Standard</dt>
          <dd>{t.kind === 'b20' ? 'B20 (Base standard)' : 'ERC-20'}</dd>
        </div>
        <div>
          <dt>Launch type</dt>
          <dd>{econ && econ.generation >= 3 ? `${econ.type === 'economy' ? 'Economy' : 'Standard'}, ${t.version}` : t.version}</dd>
        </div>
        <div>
          <dt>Pair</dt>
          <dd>{t.quote.symbol}</dd>
        </div>
        <div>
          <dt>Supply</dt>
          <dd className="mono">1,000,000,000</dd>
        </div>
        {t.burned > 0 && (
          <div>
            <dt>Burned</dt>
            <dd className="mono">{compact(t.burned)}</dd>
          </div>
        )}
        {t.devBuy && (
          <div>
            <dt>Dev buy</dt>
            <dd className="mono">
              {compact(units(t.devBuy.amountOut, 18, 0))} {t.symbol}
            </dd>
          </div>
        )}
        <div>
          <dt>Creator vault</dt>
          <dd>
            <AddressLink address={t.vault} />
          </dd>
        </div>
        {data.communityVault && (
          <div>
            <dt>Community pool</dt>
            <dd>
              <AddressLink address={data.communityVault} />
            </dd>
          </div>
        )}
        <div>
          <dt>Metadata</dt>
          <dd>{t.metadataEditable ? 'Name and logo can change' : 'Fixed'}; ticker fixed</dd>
        </div>
        <div>
          <dt>Liquidity</dt>
          <dd>Locked for good</dd>
        </div>
      </dl>
    </Card>
  );
}

export default function LaunchTokenPage() {
  const { address } = useParams();
  const now = useNow(5000);
  const { data, error, isLoading, refetch } = useLaunchToken(address);
  const narrow = useMedia('(max-width: 1100px)');
  useLaunchLive();
  const live = useLiveToken(data?.token, data?.indexedBlock);

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
          Launchpad
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
  const q = t.quote;
  const econ = tokenEconomy(t);
  return (
    <div className="pl-launch pl-launch-token">
      <Link to={launchPath()} className="pl-place-back">
        <ArrowLeft size={14} />
        Launchpad
      </Link>

      <header className="pl-launch-token-head">
        <TokenLogo token={t} size={64} />
        <div className="pl-launch-token-title">
          <h1 className="page-title">{t.name}</h1>
          <div className="pl-launch-token-sub">
            <span className="pl-launch-strong">${t.symbol}</span>
            <span className="pl-launch-muted mono">{shortAddress(t.address)}</span>
            <CopyAddress address={t.address} />
            <KindBadge kind={t.kind} />
            <Badge tone="neutral">{q.symbol} pair</Badge>
            {econ?.type === 'economy' && (
              <Badge tone="accent">
                Tax {econ.buyTax}% / {econ.sellTax}%
              </Badge>
            )}
            <Badge tone="accent">
              <Rocket size={11} /> Launched on Place
            </Badge>
            <NewBadge createdAt={t.createdAt} now={now} />
          </div>
          <Links links={t.links} />
        </div>
        <div className="pl-launch-token-price">
          <span key={t.liveTick?.cursor} className={`pl-launch-token-price-value mono ${t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : ''}`.trim()}>{t.priceUsd != null ? usd(t.priceUsd) : priceText(t.price, q.symbol)}</span>
          <span className="pl-launch-token-price-sub">
            <Change value={t.change24h} /> <span className="pl-launch-muted">24h</span>
          </span>
          {t.priceUsd != null && <span className="pl-launch-muted mono pl-launch-small">{priceText(t.price, q.symbol)}</span>}
        </div>
      </header>

      <Facts data={data} token={t} />

      <div className="pl-launch-token-tiles">
        <Tile label="Market cap" value={money(t.marketCapUsd, t.marketCap, q.symbol)} sub={`FDV ${money(t.fdvUsd, t.fdv, q.symbol)}`} />
        <Tile label="Liquidity" value={money(t.liquidity.valueUsd, t.liquidity.value, q.symbol)} sub={`${compact(t.liquidity.quote, { decimals: 4 })} ${q.symbol} in pool`} />
        <Tile label="Volume 24h" value={money(t.volume24hUsd, t.volume24h, q.symbol)} sub={`${t.trades24h} trades, ${t.trades} all time`} />
        <Tile label="Holders" value={compact(t.holders)} icon={Users} sub={`Since ${formatUtc(t.createdAt).replace(/, \d\d:\d\d UTC/, '')}`} />
      </div>

      <div className="pl-launch-token-cols">
        <div className="pl-place-stack">
          <Chart token={t} />
          {narrow && <SwapPanel token={t} />}
          <TokenTabs data={data} token={t} econ={econ} now={now} />
        </div>
        <div className="pl-place-stack">
          {!narrow && <SwapPanel token={t} />}
          <About data={data} econ={econ} />
          <Link to={consolePath('fees')} className="pl-launch-muted pl-launch-small pl-launch-console-link">
            Created this token? Claim its fees in your profile
          </Link>
        </div>
      </div>
    </div>
  );
}
