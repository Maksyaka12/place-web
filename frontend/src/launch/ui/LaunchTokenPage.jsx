// A launch token (/launch/token/:address): price and chart, buy and sell on its pool, trades, holders,
// metadata and links, the token's economics and its holder rewards in the Place hub.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Globe, ExternalLink, Send, Gift, Flame, Users, Rocket, ArrowUpRight, Coins, Clock } from 'lucide-react';
import { Card, Tile, Badge, EmptyState, Button } from '../../themes/place/components/ui';
import { CopyAddress, AddressLink, QueryError, Skeleton, StatusBadge, campaignPath } from '../../themes/place/pages/place/parts';
import { useNow } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { useLaunchToken, useCandles, useLaunchHolders, useProfile } from '../hooks.js';
import { CandleChart } from './CandleChart.jsx';
import { SwapPanel } from './SwapPanel.jsx';
import { TokenLogo, KindBadge, NewBadge, Change, EconomicsBar, launchPath, consolePath } from './parts.jsx';
import { tokenShares, feeFlow, flowSentence } from '../economy.js';
import { money } from './TokenCard.jsx';
import { useLaunchLive, useLiveToken, useLiveTrades, useLiveCandles, freshTrades, liveTradesOf } from '../live.js';
import { usd, price as priceText, compact, age, bpsText, amount } from '../format.js';

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
const num = (raw, decimals, maxDecimals = 8) => Number(formatAmount(raw ?? 0, decimals, { maxDecimals }).replace(/,/g, ''));

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

function Activity({ data, token, now }) {
  const [tab, setTab] = useState('trades');
  const trades = useLiveTrades(data.trades, data.indexedBlock, token.poolId, 50);
  const fresh = freshTrades(liveTradesOf(token.poolId), data.indexedBlock);
  const buys = data.activity24h.buys + fresh.filter((t) => t.side === 'buy').length;
  const sells = data.activity24h.sells + fresh.filter((t) => t.side === 'sell').length;
  return (
    <Card className="pl-launch-activity">
      <div className="pl-launch-activity-head">
        <div className="seg soft" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'trades'} onClick={() => setTab('trades')}>
            Trades
          </button>
          <button type="button" role="tab" aria-selected={tab === 'holders'} onClick={() => setTab('holders')}>
            Holders <span className="mono">{token.holders}</span>
          </button>
        </div>
        <span className="pl-launch-muted pl-launch-activity-sub">
          24h: <span className="pl-launch-buy mono">{buys} buys</span> · <span className="pl-launch-sell mono">{sells} sells</span> ·{' '}
          <span className="mono">{data.activity24h.traders}</span> traders
        </span>
      </div>
      {tab === 'trades' ? <Trades token={token} trades={trades} now={now} /> : <Holders token={token} />}
    </Card>
  );
}

/** 0.2.0: the three baskets, the community fund and the daily burn. */
function Economics({ data, now }) {
  const t = data.token;
  const shares = tokenShares(t.economics);
  if (!shares) return <LegacyEconomics data={data} />;
  const totals = data.vault?.totals;
  const fund = data.fund;
  const q = t.quote;
  const xPct = (t.economics.xShares || []).reduce((s, x) => s + Number(x.bps), 0) / 100;
  const flow = feeFlow({ burn: shares.burn, fund: shares.fund, xPct });
  const nextProcess = fund?.process?.nextAt ? new Date(fund.process.nextAt).getTime() : null; // ms, like useNow
  return (
    <Card className="pl-launch-econ-card">
      <span className="pl-launch-section-title">Economics</span>
      <p className="pl-launch-section-desc">Each trade pays 1%: 0.7% to the token&apos;s vault, 0.3% to Place. The vault splits its part like this, and the burn and fund shares can only go up.</p>
      <EconomicsBar burn={shares.burn} fund={shares.fund} x={(shares.creator * xPct) / 100} you={(shares.creator * (100 - xPct)) / 100} youLabel="Creator" />
      <p className="pl-launch-small pl-launch-muted">{flowSentence(flow, { you: 'the creator' })}.</p>
      <dl className="pl-place-kv">
        {fund && (
          <div>
            <dt>
              <Users size={13} /> Community fund
            </dt>
            <dd className="mono">
              {amount(num(fund.balance, q.decimals), q.symbol)}
              {fund.pending !== '0' && <span className="pl-launch-muted"> +{amount(num(fund.pending, q.decimals), q.symbol)} pending</span>}
            </dd>
          </div>
        )}
        {totals && (
          <>
            <div>
              <dt>
                <Flame size={13} /> Burned so far
              </dt>
              <dd className="mono">{amount(num(data.burns?.totalTokens, 18, 2), t.symbol)}</dd>
            </div>
            <div>
              <dt>Fees collected</dt>
              <dd className="mono">{amount(num(totals.collected, q.decimals), q.symbol)}</dd>
            </div>
            <div>
              <dt>Sent to the fund</dt>
              <dd className="mono">{amount(num(totals.toFund, q.decimals), q.symbol)}</dd>
            </div>
          </>
        )}
        {fund && shares.burn > 0 && (
          <div>
            <dt>
              <Clock size={13} /> Next burn
            </dt>
            <dd>{nextProcess && nextProcess > now ? formatUtc(fund.process.nextAt) : 'Due now, Place runs it daily'}</dd>
          </div>
        )}
        {fund && shares.fund > 0 && (
          <div>
            <dt>Default campaign</dt>
            <dd>{new Date(fund.defaultCampaign.nextAt).getTime() > now ? `If unused until ${formatUtc(fund.defaultCampaign.nextAt)}` : 'Anyone can start it now'}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

/** Burns with links to their transactions. */
function Burns({ data, now }) {
  const t = data.token;
  const burns = data.burns;
  if (!burns || (!burns.count && !tokenShares(t.economics)?.burn)) return null;
  return (
    <Card className="pl-launch-burns">
      <div className="pl-launch-section-head">
        <span className="pl-launch-section-title">Burns</span>
        <span className="pl-launch-muted mono pl-launch-small">{burns.count} total</span>
      </div>
      {burns.list.length ? (
        <div className="pl-launch-hub-list">
          {burns.list.slice(0, 8).map((b) => (
            <a key={b.tx} className="pl-launch-hub-row" href={explorerTx(b.tx)} target="_blank" rel="noopener noreferrer">
              <span className="pl-launch-inline">
                <Flame size={13} className="pl-launch-buy" />
                <span className="mono">{compact(num(b.tokens, 18, 2))} {t.symbol}</span>
              </span>
              <span className="pl-launch-hub-row-right">
                <span className="mono pl-launch-muted">{compact(num(b.quoteIn, t.quote.decimals), { decimals: 6 })} {t.quote.symbol}</span>
                <span className="mono pl-launch-muted">{age(b.at, now)}</span>
                <ExternalLink size={12} />
              </span>
            </a>
          ))}
        </div>
      ) : (
        <p className="pl-launch-muted pl-launch-small">No burns yet. The first one comes with the first daily process after trading starts.</p>
      )}
    </Card>
  );
}

/** 0.1.0 tokens: buyback and holder rewards shares. */
function LegacyEconomics({ data }) {
  const t = data.token;
  const e = t.economics;
  const totals = data.vault?.totals;
  const qd = t.quote.decimals;
  const xPct = (e.xShares || []).reduce((s, x) => s + Number(x.bps), 0);
  const youBps = 10_000 - e.buybackBps - e.rewardsBps - xPct;
  return (
    <Card className="pl-launch-econ-card">
      <div className="pl-launch-section-head">
        <span className="pl-launch-section-title">Economics</span>
        <Badge tone="neutral">0.1.0</Badge>
      </div>
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
              <dd className="mono">{amount(Number(formatAmount(totals.collected, qd, { maxDecimals: 8 }).replace(/,/g, '')), t.quote.symbol)}</dd>
            </div>
            <div>
              <dt>{e.buybackBurn ? 'Bought back and burned' : 'Bought back'}</dt>
              <dd className="mono">{amount(Number(formatAmount(totals.boughtBackTokens, 18, { maxDecimals: 2 }).replace(/,/g, '')), t.symbol)}</dd>
            </div>
            <div>
              <dt>Sent to holder rewards</dt>
              <dd className="mono">{amount(Number(formatAmount(totals.toCampaigns, qd, { maxDecimals: 8 }).replace(/,/g, '')), t.quote.symbol)}</dd>
            </div>
          </>
        )}
      </dl>
    </Card>
  );
}

function CampaignRows({ campaigns, t }) {
  return (
    <div className="pl-launch-hub-list">
      {campaigns.slice(0, 4).map((c) => (
        <Link key={`${c.hub}-${c.id}`} to={campaignPath(c)} className="pl-launch-hub-row">
          <span>
            Campaign #{c.id}
            {c.fromVault && <span className="pl-launch-muted"> · community fund</span>}
          </span>
          <span className="pl-launch-hub-row-right">
            {c.rewardToken === t.quote.address || (c.rewardToken === 'eth' && t.quote.address === 'eth') ? (
              <span className="mono">{formatAmount(c.pool, t.quote.decimals)} {t.quote.symbol}</span>
            ) : c.rewardToken === t.address ? (
              <span className="mono">{compact(num(c.pool, 18, 0))} {t.symbol}</span>
            ) : (
              <span className="mono">{c.rewardSymbol ? `${compact(num(c.pool, c.rewardDecimals ?? 18, 6), { decimals: 6 })} ${c.rewardSymbol}` : shortAddress(c.rewardToken)}</span>
            )}
            <StatusBadge status={c.status} />
          </span>
        </Link>
      ))}
    </div>
  );
}

function HubRewards({ data }) {
  const t = data.token;
  const campaigns = data.campaigns || [];
  const official = campaigns.filter((c) => c.section !== 'community');
  const community = campaigns.filter((c) => c.section === 'community');
  const staking = data.staking || [];
  const shares = tokenShares(t.economics);
  return (
    <Card className="pl-launch-hub-card">
      <div className="pl-launch-section-head">
        <span className="pl-launch-section-title">Holder rewards in Place</span>
        <Badge tone="accent">Place hub</Badge>
      </div>
      <p className="pl-launch-section-desc">
        {shares
          ? shares.fund
            ? 'Part of every trade fills a community fund. The creator turns it into Place campaigns and staking programs for holders, never into their own wallet.'
            : 'This token has no community fund share yet. Its creator can add one later. Anyone can still start a campaign for its holders.'
          : t.economics.rewardsBps
            ? 'Part of every trade fills a rewards pool that turns into Place campaigns for all holders.'
            : 'This token has no holder rewards share. Anyone can still start a campaign for its holders.'}
      </p>
      <span className="pl-launch-field-label">Official</span>
      {official.length ? <CampaignRows campaigns={official} t={t} /> : <p className="pl-launch-muted pl-launch-small">No campaigns from the creator or the fund yet.</p>}
      {community.length > 0 && (
        <>
          <span className="pl-launch-field-label">From the community</span>
          <CampaignRows campaigns={community} t={t} />
        </>
      )}
      {staking.length > 0 && (
        <>
          <span className="pl-launch-field-label">Staking</span>
          <div className="pl-launch-hub-list">
            {staking.slice(0, 3).map((p) => (
              <Link key={p.id} to={`/staking?program=${p.id}`} className="pl-launch-hub-row">
                <span className="pl-launch-inline">
                  <Coins size={13} />
                  {compact(num(p.rewardPerEpoch, p.rewardToken.decimals, 4))} {p.rewardToken.symbol} per epoch
                </span>
                <span className="pl-launch-hub-row-right">
                  <span className="mono pl-launch-muted">{p.epochCount} × {Math.round(p.epochDuration / 3600)}h</span>
                  <StatusBadge status={p.status === 'live' ? 'Live' : p.status === 'ended' ? 'Ended' : 'Upcoming'} />
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      <Button as={Link} to={`/token/${t.address}`} fullWidth>
        Open in Place hub
        <ArrowUpRight size={15} />
      </Button>
    </Card>
  );
}

function About({ data }) {
  const t = data.token;
  const { data: prof } = useProfile(t.creator);
  const p = prof?.profile;
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
          <dt>Type</dt>
          <dd>{t.kind === 'b20' ? 'B20 (Base standard)' : 'ERC-20'}</dd>
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
          <dt>Creator</dt>
          <dd className="pl-launch-inline">
            {p?.name && <span className="pl-launch-strong">{p.name}</span>}
            <AddressLink address={t.creator} />
          </dd>
        </div>
        {t.devBuy && (
          <div>
            <dt>Dev buy</dt>
            <dd className="mono">
              {compact(Number(formatAmount(t.devBuy.amountOut, 18, { maxDecimals: 0 }).replace(/,/g, '')))} {t.symbol}
            </dd>
          </div>
        )}
        <div>
          <dt>Creator vault</dt>
          <dd>
            <AddressLink address={t.vault} />
          </dd>
        </div>
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

      <div className="pl-launch-token-tiles">
        <Tile label="Market cap" value={money(t.marketCapUsd, t.marketCap, q.symbol)} sub={`FDV ${money(t.fdvUsd, t.fdv, q.symbol)}`} />
        <Tile label="Liquidity" value={money(t.liquidity.valueUsd, t.liquidity.value, q.symbol)} sub={`${compact(t.liquidity.quote, { decimals: 4 })} ${q.symbol} in pool`} />
        <Tile label="Volume 24h" value={money(t.volume24hUsd, t.volume24h, q.symbol)} sub={`${t.trades24h} trades`} />
        <Tile label="All-time volume" value={money(t.volumeAllUsd, t.volumeAll, q.symbol)} sub={`${t.trades} trades`} />
        <Tile label="Holders" value={compact(t.holders)} icon={Users} sub={`Since ${formatUtc(t.createdAt).replace(/, \d\d:\d\d UTC/, '')}`} />
      </div>

      <div className="pl-launch-token-cols">
        <div className="pl-place-stack">
          <Chart token={t} />
          {narrow && <SwapPanel token={t} />}
          <Activity data={data} token={t} now={now} />
        </div>
        <div className="pl-place-stack">
          {!narrow && <SwapPanel token={t} />}
          <HubRewards data={data} />
          <Economics data={data} now={now} />
          <Burns data={data} now={now} />
          <About data={data} />
          <Link to={consolePath('fees')} className="pl-launch-muted pl-launch-small pl-launch-console-link">
            Created this token? Claim its fees in the creator console
          </Link>
        </div>
      </div>
    </div>
  );
}
