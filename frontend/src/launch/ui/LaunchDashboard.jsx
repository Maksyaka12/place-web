// Launchpad home (/launch): live trades, the headline numbers, Trending now, and every launch as cards
// with All / Crypto / Stocks tabs, Trending / Vol 24h / New / Liquidity sorting and a Grid / Cards / Table view
// (remembered per browser; the table sorts by any column).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRight, Flame, Zap, Sprout, Droplets, Search, Rocket, LayoutDashboard, LayoutGrid, Rows3, Table as TableIcon, ArrowUpDown, ArrowUp, ArrowDown, Star } from 'lucide-react';
import { Button, Card, Tile, EmptyState } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useNow } from '../../place/hooks';
import { isTestnet } from '../../place/chain';
import { useLaunchStats, useLaunchTokens, usePairs } from '../hooks.js';
import { useLaunchLive, useLiveTokens } from '../live.js';
import { TokenCard, TokenRowCard, money } from './TokenCard.jsx';
import { TokenLogo, NewBadge, TaxBadge, CopyInline, StarButton, McBar, agoText, useWatchlist, launchTokenPath, launchNewPath, consolePath } from './parts.jsx';
import { useViewMode, FilterMenu } from './vaults.jsx';
import { usd, compact, age, price as priceText } from '../format.js';

const PAGE = 24;

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'stocks', label: 'Stocks' },
];

const SORTS = [
  { id: 'trending', label: 'Trending', Icon: Flame },
  { id: 'volume', label: 'Vol 24h', Icon: Zap },
  { id: 'new', label: 'New', Icon: Sprout },
  { id: 'liquidity', label: 'Liquidity', Icon: Droplets },
];

const VIEWS = [
  ['grid', 'Grid view', LayoutGrid],
  ['cards', 'Card view', Rows3],
  ['table', 'Table view', TableIcon],
];

/** A USD value with the same value in the pair asset under it. */
function Dual({ valueUsd, value, q, decimals = 4 }) {
  return (
    <>
      <span>{money(valueUsd, value, q)}</span>
      {valueUsd != null && value != null && (
        <span className="pl-launch-muted pl-launch-small">
          {compact(value, { decimals })} {q}
        </span>
      )}
    </>
  );
}

/** Columns of the Table view; each sorts by its value (USD when the pair has a price, else the pair amount). */
const COLUMNS = [
  { id: 'mcap', label: 'Market cap', value: (t) => t.marketCapUsd ?? t.marketCap },
  { id: 'age', label: 'Created At', value: (t) => new Date(t.createdAt).getTime() },
  { id: 'liquidity', label: 'Liquidity', value: (t) => t.liquidity?.valueUsd ?? t.liquidity?.value },
  { id: 'volume', label: 'Volume 24h', value: (t) => t.volume24hUsd ?? t.volume24h },
  { id: 'lifetime', label: 'Lifetime volume', value: (t) => t.volumeAllUsd ?? t.volumeAll },
  { id: 'trades', label: 'Trades 24h', value: (t) => t.trades24h },
  { id: 'price', label: 'Price', value: (t) => t.priceUsd ?? t.price },
];

function TokenTable({ tokens, now, watch }) {
  const navigate = useNavigate();
  const [by, setBy] = useState(null);
  const list = useMemo(() => {
    if (!by) return tokens;
    const col = COLUMNS.find((c) => c.id === by.id);
    return [...tokens].sort((a, b) => ((Number(col.value(a)) || 0) - (Number(col.value(b)) || 0)) * (by.dir === 'asc' ? 1 : -1));
  }, [tokens, by]);
  const sortBy = (id) => setBy((cur) => (cur?.id === id ? (cur.dir === 'desc' ? { id, dir: 'asc' } : null) : { id, dir: 'desc' }));
  return (
    <div className="pl-schedule-card pl-launch-list">
      <div className="pl-launch-list-row head">
        <span>Token</span>
        {COLUMNS.map((c) => {
          const on = by?.id === c.id;
          const Icon = on ? (by.dir === 'desc' ? ArrowDown : ArrowUp) : ArrowUpDown;
          return (
            <span key={c.id} aria-sort={on ? (by.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
              <button type="button" className={`pl-launch-list-sort ${on ? 'on' : ''}`.trim()} onClick={() => sortBy(c.id)}>
                {c.label}
                <Icon size={12} />
              </button>
            </span>
          );
        })}
        <span className="num">Trade</span>
      </div>
      {list.map((t) => {
        const q = t.quote?.symbol || '';
        const to = launchTokenPath(t.address);
        return (
          <div
            key={t.address}
            className="pl-launch-list-row"
            data-testid="launch-card"
            role="link"
            tabIndex={0}
            aria-label={`${t.name} (${t.symbol})`}
            onClick={() => navigate(to)}
            onKeyDown={(e) => e.key === 'Enter' && navigate(to)}
          >
            <span className="pl-launch-list-token">
              <TokenLogo token={t} size={36} />
              <span className="pl-launch-list-name">
                <span className="pl-launch-list-title">
                  <span className="pl-launch-strong">{t.symbol}</span>
                  <span className="pl-launch-muted pl-launch-ellipsis">{t.name}</span>
                  <CopyInline value={t.address} />
                </span>
                <span className="pl-launch-list-tags">
                  <span className="pl-launch-muted pl-launch-small">{q}</span>
                  <NewBadge createdAt={t.createdAt} now={now} />
                  <TaxBadge token={t} />
                </span>
              </span>
            </span>
            <span className="pl-launch-list-cell mono">
              <span className="pl-launch-list-mc">
                <span key={t.liveTick?.cursor} className={t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : undefined}>
                  {money(t.marketCapUsd, t.marketCap, q)}
                </span>
                <McBar usdValue={t.marketCapUsd} />
              </span>
              {t.marketCapUsd != null && (
                <span className="pl-launch-muted pl-launch-small">
                  {compact(t.marketCap, { decimals: 4 })} {q}
                </span>
              )}
            </span>
            <span className="pl-launch-list-cell">{agoText(t.createdAt, now)}</span>
            <span className="pl-launch-list-cell mono">
              <Dual valueUsd={t.liquidity?.valueUsd} value={t.liquidity?.value} q={q} />
            </span>
            <span className="pl-launch-list-cell mono">
              <Dual valueUsd={t.volume24hUsd} value={t.volume24h} q={q} />
            </span>
            <span className="pl-launch-list-cell mono">
              <Dual valueUsd={t.volumeAllUsd} value={t.volumeAll} q={q} />
            </span>
            <span className="pl-launch-list-cell mono">{compact(t.trades24h ?? 0)}</span>
            <span className="pl-launch-list-cell mono">
              <span>{t.priceUsd != null ? usd(t.priceUsd) : priceText(t.price, q)}</span>
              {t.priceUsd != null && <span className="pl-launch-muted pl-launch-small">{priceText(t.price, q)}</span>}
            </span>
            <span className="pl-launch-list-actions">
              <StarButton address={t.address} watch={watch} />
              <span className="pl-launch-trade-btn">
                <Zap size={13} />
                Trade
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Metrics() {
  const { data: s, isLoading } = useLaunchStats();
  const v = (x) => (isLoading ? '…' : x);
  const top = s?.topMarketCap;
  return (
    <div className="pl-launch-metrics">
      <Tile label="Tokens launched" value={v(compact(s?.tokens ?? 0))} />
      <Tile label="Traders" value={v(compact(s?.traders ?? 0))} />
      <Tile label="Volume" value={v(usd(s?.volumeUsd ?? 0))} sub={s ? `${usd(s.volume24hUsd)} in 24h` : null} />
      <Tile
        label="Highest market cap"
        value={v(top ? money(top.marketCapUsd, top.marketCap, top.quote?.symbol) : '—')}
        sub={top ? <Link className="pl-place-link" to={launchTokenPath(top.address)}>${top.symbol}</Link> : null}
      />
    </div>
  );
}

function Trending({ now }) {
  const { data, isLoading } = useLaunchTokens({ sort: 'trending', limit: 5 });
  const list = useLiveTokens(data?.tokens, data?.indexedBlock);
  return (
    <Card className="pl-launch-trending">
      <div className="pl-launch-trending-head">
        <span className="pl-launch-trending-title">
          <Flame size={16} />
          Trending now
        </span>
      </div>
      {isLoading ? (
        <Skeleton height={56} count={3} className="pl-launch-trending-skel" />
      ) : list.length ? (
        <ol className="pl-launch-trending-list">
          {list.map((t, i) => (
            <li key={t.address}>
              <Link to={launchTokenPath(t.address)} className="pl-launch-trending-row">
                <span className={`pl-launch-rank ${i < 3 ? 'top' : ''}`.trim()}>{i + 1}</span>
                <TokenLogo token={t} size={36} />
                <span className="pl-launch-trending-main">
                  <span className="pl-launch-trending-name">
                    {t.name} <span className="pl-launch-muted">{t.symbol}</span>
                  </span>
                  <span className="pl-launch-trending-sub">
                    {t.quote?.symbol} · {age(t.createdAt, now)} ago
                  </span>
                </span>
                <span className="pl-launch-trending-nums">
                  <span key={t.liveTick?.cursor} className={`mono pl-launch-strong ${t.liveTick ? `pl-launch-flash ${t.liveTick.side}` : ''}`.trim()}>
                    {money(t.marketCapUsd, t.marketCap, t.quote?.symbol)}
                  </span>
                  <span className="pl-launch-trending-sub">
                    Vol 24h <span className="mono">{money(t.volume24hUsd, t.volume24h, t.quote?.symbol)}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="pl-launch-muted pl-launch-trending-empty">No trades yet. The first launch to trade shows up here.</p>
      )}
    </Card>
  );
}

/** The launchpad feed. The top-bar search arrives as `?q=`. */
export default function LaunchDashboard() {
  useLaunchLive();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const category = CATEGORIES.some((c) => c.id === params.get('tab')) ? params.get('tab') : 'all';
  const sort = SORTS.some((s) => s.id === params.get('sort')) ? params.get('sort') : 'trending';
  const urlQuery = params.get('q') || '';
  const [search, setSearch] = useState(urlQuery);
  useEffect(() => setSearch(urlQuery), [urlQuery]);
  const [pages, setPages] = useState(1);
  const [view, pickView] = useViewMode('place_launch_view', VIEWS.map(([id]) => id));
  const asset = params.get('asset') || null;
  const [onlyWatch, setOnlyWatch] = useState(false);
  const watch = useWatchlist();
  const pairsQ = usePairs();
  const assets = (pairsQ.data?.pairs || []).filter((p) => p.launches > 0).map((p) => [p.address, p.symbol || p.address]);

  const set = (key, value, fallback) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setPages(1);
  };

  const query = useMemo(
    () => ({ sort, category: category === 'all' ? undefined : category, quote: asset || undefined, q: search.trim() || undefined, limit: PAGE * pages }),
    [sort, category, asset, search, pages]
  );
  const feed = useLaunchTokens(query);
  const live = useLiveTokens(feed.data?.tokens, feed.data?.indexedBlock);
  const tokens = onlyWatch ? live.filter((t) => watch.has(t.address)) : live;

  return (
    <div className="pl-launch">
      <div className="pl-launch-hero">
        <div className="pl-launch-hero-main">
          <h1 className="page-title">Launchpad</h1>
          <p className="page-desc">
            Launch a B20 or ERC-20 token on Base with liquidity locked for good, then trade it and reward its holders in Place
          </p>
          <div className="pl-launch-hero-actions">
            <Button as={Link} to={launchNewPath()} variant="primary" size="lg">
              <Plus size={18} />
              Launch token
            </Button>
            <Button as={Link} to={consolePath()} size="lg">
              <LayoutDashboard size={18} />
              Profile
            </Button>
          </div>
          <Metrics />
        </div>
        <Trending now={now} />
      </div>

      <div className="pl-launch-toolbar">
        <div className="pl-launch-tabs" role="tablist" aria-label="Pair type">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={category === c.id} onClick={() => set('tab', c.id, 'all')}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="pl-launch-toolbar-right">
          <div className="seg soft pl-launch-sorts" role="tablist" aria-label="Sort">
            {SORTS.map(({ id, label, Icon }) => (
              <button key={id} type="button" role="tab" aria-selected={sort === id} onClick={() => set('sort', id, 'trending')}>
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
          <button type="button" className={`pl-launch-watch-chip ${onlyWatch ? 'on' : ''}`.trim()} aria-pressed={onlyWatch} onClick={() => setOnlyWatch((v) => !v)}>
            <Star size={14} />
            Watchlist
          </button>
          <FilterMenu label={asset ? "Asset" : "All assets"} value={asset} options={assets} anyLabel="All assets" onChange={(v) => set('asset', v ?? '', '')} />
          <div className="seg soft pl-launch-views" role="tablist" aria-label="View">
            {VIEWS.map(([id, label, Icon]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} aria-label={label} title={label} onClick={() => pickView(id)}>
                <Icon size={15} />
              </button>
            ))}
          </div>
          <label className="pl-launch-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPages(1);
              }}
              placeholder="Name, ticker or address"
              aria-label="Search tokens"
              spellCheck={false}
            />
          </label>
        </div>
      </div>

      {feed.error ? (
        <QueryError error={feed.error} retry={feed.refetch} />
      ) : feed.isLoading ? (
        <div className="pl-launch-grid">
          <Skeleton height={330} count={8} />
        </div>
      ) : tokens.length ? (
        <>
          {view === 'table' ? (
            <TokenTable tokens={tokens} now={now} watch={watch} />
          ) : view === 'cards' ? (
            <div className="pl-launch-rowcards">
              {tokens.map((t, i) => (
                <TokenRowCard key={t.address} t={t} now={now} rank={i + 1} watch={watch} />
              ))}
            </div>
          ) : (
            <div className="pl-launch-grid">
              {tokens.map((t) => (
                <TokenCard key={t.address} t={t} now={now} />
              ))}
            </div>
          )}
          {feed.data?.nextOffset != null && (
            <div className="pl-launch-more">
              <Button onClick={() => setPages((p) => p + 1)} disabled={feed.isFetching}>
                {feed.isFetching ? 'Loading...' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Rocket size={28} />}
            title={onlyWatch ? 'Your watchlist is empty' : search ? 'No tokens match your search' : category === 'stocks' ? 'No launches paired with stocks yet' : 'No launches yet'}
            description={
              category === 'stocks' && isTestnet
                ? 'Tokenized stocks are not on Base Sepolia. Stock pairs open with the mainnet launch.'
                : search
                  ? 'Try a name, a ticker or a full token address.'
                  : 'Launch the first token: it gets its pool, locked liquidity and a page here in one transaction.'
            }
            action={
              !search && (
                <Button as={Link} to={launchNewPath()} variant="primary">
                  Launch token
                  <ArrowRight size={16} />
                </Button>
              )
            }
          />
        </Card>
      )}
    </div>
  );
}
