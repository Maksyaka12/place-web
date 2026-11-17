// Launchpad home (/launch): live trades, the headline numbers, Trending now, and every launch as cards
// with All / Crypto / Stocks tabs and Trending / Vol 24h / New / Liquidity sorting.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRight, Flame, Zap, Sprout, Droplets, Search, Rocket, LayoutDashboard } from 'lucide-react';
import { Button, Card, Tile, EmptyState } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useNow } from '../../place/hooks';
import { isTestnet } from '../../place/chain';
import { useLaunchStats, useLaunchTokens } from '../hooks.js';
import { useLaunchLive, useLiveTokens } from '../live.js';
import { TokenCard, money } from './TokenCard.jsx';
import { TokenLogo, launchTokenPath, launchNewPath, consolePath } from './parts.jsx';
import { usd, compact, age } from '../format.js';

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

  const set = (key, value, fallback) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setPages(1);
  };

  const query = useMemo(
    () => ({ sort, category: category === 'all' ? undefined : category, q: search.trim() || undefined, limit: PAGE * pages }),
    [sort, category, search, pages]
  );
  const feed = useLaunchTokens(query);
  const tokens = useLiveTokens(feed.data?.tokens, feed.data?.indexedBlock);

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
          <div className="pl-launch-grid">
            {tokens.map((t) => (
              <TokenCard key={t.address} t={t} now={now} />
            ))}
          </div>
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
            title={search ? 'No tokens match your search' : category === 'stocks' ? 'No launches paired with stocks yet' : 'No launches yet'}
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
