// Stocks (/stocks): every Coinbase tokenized stock on Base. A hero with totals, categories with logos, then all
// stocks with price, onchain liquidity (the value of the tokenized supply) and a Launch with button for the ones
// that are launch pairs on this network.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, LayoutGrid, List, Rocket, Search, X } from 'lucide-react';
import { Button, Card, EmptyState, Alert } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { isTestnet } from '../../place/chain';
import { useStocks } from '../hooks.js';
import { usd, compact } from '../format.js';
import { TokenLogo, launchNewPath } from './parts.jsx';

const PAGE = 24;
const SORTS = [
  ['liquidity', 'Liquidity'],
  ['price', 'Price'],
  ['az', 'A–Z'],
];

function StockLogo({ s, size = 40 }) {
  return <TokenLogo token={{ symbol: s.ticker, name: s.name }} src={s.icon || undefined} size={size} shape="round" />;
}

/** The logo cloud on the right of the hero: the most liquid stocks, scattered on a fixed pattern. */
function LogoCloud({ stocks }) {
  const logos = stocks.filter((s) => s.icon).slice(0, 36);
  return (
    <div className="pl-stocks-cloud" aria-hidden="true">
      {logos.map((s, i) => {
        const col = i % 6;
        const row = Math.floor(i / 6);
        const style = {
          left: `${col * 16.5 + (row % 2 ? 8 : 0) + ((i * 7) % 5) - 2}%`,
          top: `${row * 16 + ((i * 11) % 7) - 3}%`,
          width: 52 + ((i * 13) % 4) * 6,
          height: 52 + ((i * 13) % 4) * 6,
        };
        return <img key={s.address} src={s.icon} alt="" loading="lazy" style={style} />;
      })}
    </div>
  );
}

function Hero({ data }) {
  const t = data.totals;
  const minK = `$${compact(data.minLiquidityUsd)}`;
  return (
    <Card className="pl-stocks-hero">
      <div className="pl-stocks-hero-main">
        <h1 className="pl-stocks-hero-title">Stocks, paired with your token</h1>
        <p className="pl-stocks-hero-desc">
          Pick a tokenized stock on Base and launch your own token paired with it. {t.pairedTokens.toLocaleString('en-US')}{' '}
          {t.pairedTokens === 1 ? 'token pairs' : 'tokens pair'} with {t.pairs.toLocaleString('en-US')} stocks on Place so far.
        </p>
        <div className="pl-stocks-stats">
          <div className="pl-stocks-stat big">
            <span className="mono">{t.pairedTokens.toLocaleString('en-US')}</span>
            <span>Paired tokens</span>
          </div>
          <div className="pl-stocks-stat big">
            <span className="mono">{usd(t.onchainLiquidityUsd)}</span>
            <span title="The value of every tokenized share on Base">Onchain liquidity</span>
          </div>
          <div className="pl-stocks-stat">
            <span className="mono">{t.listed}</span>
            <span>Listed stocks</span>
          </div>
          <div className="pl-stocks-stat">
            <span className="mono">{t.launchReady}</span>
            <span title={`Has supply, nothing paused, a live price and at least ${minK} onchain`}>Launch ready</span>
          </div>
          <div className="pl-stocks-stat">
            <span className="mono">{t.liquid}</span>
            <span>Liquidity ≥ {minK}</span>
          </div>
        </div>
      </div>
      <LogoCloud stocks={data.stocks} />
    </Card>
  );
}

function Categories({ categories, active, onPick }) {
  return (
    <div className="pl-stocks-section">
      <h2 className="section-title">Categories</h2>
      <div className="pl-stocks-categories">
        {categories.map((c) => (
          <button key={c.id} type="button" className={`pl-stocks-category ${active === c.id ? 'active' : ''}`.trim()} aria-pressed={active === c.id} onClick={() => onPick(active === c.id ? null : c.id)}>
            <span className="pl-stocks-category-logos">
              {c.icons.map((i) => (
                <TokenLogo key={i.ticker} token={{ symbol: i.ticker }} src={i.icon || undefined} size={32} shape="round" />
              ))}
            </span>
            <span className="pl-stocks-category-name">{c.label}</span>
            <span className="pl-stocks-category-count">
              {c.count} {c.count === 1 ? 'stock' : 'stocks'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LaunchWith({ s }) {
  const label = (
    <>
      Launch with <StockLogo s={s} size={18} /> {s.ticker}
    </>
  );
  if (s.pair) {
    return (
      <Button as={Link} to={`${launchNewPath()}?pair=${s.address}`} variant="primary" size="sm" className="pl-stocks-launch">
        {label}
      </Button>
    );
  }
  return (
    <Button size="sm" disabled className="pl-stocks-launch" title={isTestnet ? 'Stocks are launch pairs on Base mainnet' : 'Not a launch pair yet'}>
      {label}
    </Button>
  );
}

function StockCard({ s, rank, maxLiquidity }) {
  const bar = s.liquidityUsd > 0 ? Math.max(4, (Math.log10(s.liquidityUsd + 1) / Math.log10(maxLiquidity + 1)) * 100) : 0;
  return (
    <Card className="pl-stocks-card">
      <div className="pl-stocks-card-head">
        <StockLogo s={s} />
        <div className="pl-stocks-card-name">
          <span className="pl-launch-strong">{s.ticker}</span>
          <span className="pl-launch-muted pl-launch-small">{s.name}</span>
        </div>
        <span className="pl-stocks-rank mono">#{rank}</span>
      </div>
      <div className="pl-stocks-card-numbers">
        <div>
          <span className="pl-stocks-price mono">{s.priceUsd == null ? '—' : usd(s.priceUsd)}</span>
          <span className="pl-launch-muted pl-launch-small">{s.supply > 0 ? `${compact(s.supply)} shares` : 'No supply yet'}</span>
        </div>
        <div className="pl-stocks-card-liq">
          <span className="pl-launch-muted pl-launch-small">Liquidity</span>
          <span className="mono pl-launch-strong">{usd(s.liquidityUsd)}</span>
        </div>
      </div>
      <div className="pl-stocks-bar" aria-hidden="true">
        <span style={{ width: `${bar}%` }} />
      </div>
      <div className="pl-stocks-card-foot">
        <span className="pl-stocks-launches" title="Place tokens paired with this stock">
          <Rocket size={14} />
          <span className="mono">{s.launches}</span>
        </span>
        <LaunchWith s={s} />
      </div>
    </Card>
  );
}

function StockRows({ list }) {
  return (
    <div className="pl-schedule-card pl-stocks-table">
      <div className="pl-stocks-row head">
        <span>#</span>
        <span>Stock</span>
        <span>Price</span>
        <span>Shares</span>
        <span>Liquidity</span>
        <span>Tokens</span>
        <span />
      </div>
      {list.map(({ s, rank }) => (
        <div key={s.address} className="pl-stocks-row">
          <span className="mono pl-launch-muted">{rank}</span>
          <span className="pl-stocks-row-name">
            <StockLogo s={s} size={28} />
            <span>
              <span className="pl-launch-strong">{s.ticker}</span> <span className="pl-launch-muted pl-launch-small">{s.name}</span>
            </span>
          </span>
          <span className="mono">{s.priceUsd == null ? '—' : usd(s.priceUsd)}</span>
          <span className="mono">{s.supply > 0 ? compact(s.supply) : '—'}</span>
          <span className="mono">{usd(s.liquidityUsd)}</span>
          <span className="mono">{s.launches}</span>
          <span>
            <LaunchWith s={s} />
          </span>
        </div>
      ))}
    </div>
  );
}

export default function StocksPage() {
  const q = useStocks();
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState(null);
  const [sort, setSort] = useState('liquidity');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('cards');
  const [pages, setPages] = useState(1);

  const data = q.data;
  const stocks = useMemo(() => data?.stocks || [], [data]);
  // Rank by liquidity, whatever the sort.
  const rankOf = useMemo(() => new Map(stocks.map((s, i) => [s.address, i + 1])), [stocks]);
  const maxLiquidity = stocks[0]?.liquidityUsd || 1;

  const filters = data
    ? [
        ['all', 'All', data.totals.listed],
        ['ready', 'Launch ready', data.totals.launchReady],
        ['liquid', `Liquidity ≥ $${compact(data.minLiquidityUsd)}`, data.totals.liquid],
        ['empty', 'No token supply', data.totals.noSupply],
      ]
    : [];

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = stocks.filter(
      (s) =>
        (filter === 'all' ||
          (filter === 'ready' && s.launchReady) ||
          (filter === 'liquid' && s.liquidityUsd >= (data?.minLiquidityUsd ?? 0)) ||
          (filter === 'empty' && !(s.supply > 0))) &&
        (!category || s.category === category) &&
        (!term || s.ticker.toLowerCase().includes(term) || s.name.toLowerCase().includes(term) || s.address.startsWith(term))
    );
    if (sort === 'price') return [...list].sort((a, b) => (b.priceUsd ?? -1) - (a.priceUsd ?? -1));
    if (sort === 'az') return [...list].sort((a, b) => a.ticker.localeCompare(b.ticker));
    return list;
  }, [stocks, filter, category, search, sort, data]);

  const pickCategory = (id) => {
    setCategory(id);
    setPages(1);
    if (id) document.getElementById('all-stocks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (q.isLoading) {
    return (
      <div className="pl-place-stack">
        <Skeleton height={360} />
        <Skeleton height={160} />
      </div>
    );
  }
  if (q.error) return <QueryError error={q.error} retry={q.refetch} />;

  const visible = shown.slice(0, PAGE * pages).map((s) => ({ s, rank: rankOf.get(s.address) }));
  const categoryLabel = data.categories.find((c) => c.id === category)?.label;

  return (
    <div className="pl-stocks">
      <Hero data={data} />
      {isTestnet && (
        <Alert tone="info" icon={<Info size={15} />}>
          These are the tokenized stocks on Base mainnet. Launches pair with them on mainnet; on Base Sepolia the list is for browsing.
        </Alert>
      )}
      <Categories categories={data.categories} active={category} onPick={pickCategory} />

      <div className="pl-stocks-section" id="all-stocks">
        <div className="pl-stocks-list-head">
          <h2 className="section-title">
            All stocks
            {categoryLabel && (
              <button type="button" className="pl-stocks-chip" onClick={() => pickCategory(null)}>
                {categoryLabel} <X size={12} />
              </button>
            )}
          </h2>
        </div>
        <div className="pl-stocks-toolbar">
          <div className="seg soft pl-stocks-filters" role="tablist" aria-label="Filter">
            {filters.map(([id, label, n]) => (
              <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => (setFilter(id), setPages(1))}>
                {label} <span className="pl-stocks-count">{n}</span>
              </button>
            ))}
          </div>
          <div className="pl-stocks-toolbar-right">
            <div className="seg soft" role="tablist" aria-label="Sort">
              {SORTS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={sort === id} onClick={() => setSort(id)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="pl-launch-search pl-stocks-search">
              <Search size={16} />
              <input value={search} onChange={(e) => (setSearch(e.target.value), setPages(1))} placeholder="Search ticker, company or address" aria-label="Search stocks" />
            </label>
            <div className="seg soft" role="tablist" aria-label="View">
              <button type="button" role="tab" aria-selected={view === 'cards'} aria-label="Cards" onClick={() => setView('cards')}>
                <LayoutGrid size={14} />
              </button>
              <button type="button" role="tab" aria-selected={view === 'list'} aria-label="List" onClick={() => setView('list')}>
                <List size={14} />
              </button>
            </div>
          </div>
        </div>

        {visible.length === 0 ? (
          <Card className="pl-place-empty-card">
            <EmptyState icon={<Search size={28} />} title="No stocks match" description="Try another filter, category or search." />
          </Card>
        ) : view === 'list' ? (
          <StockRows list={visible} />
        ) : (
          <div className="pl-stocks-grid">
            {visible.map(({ s, rank }) => (
              <StockCard key={s.address} s={s} rank={rank} maxLiquidity={maxLiquidity} />
            ))}
          </div>
        )}
        {shown.length > visible.length && (
          <div className="pl-stocks-more">
            <Button onClick={() => setPages((p) => p + 1)}>Show more ({shown.length - visible.length})</Button>
          </div>
        )}
      </div>
    </div>
  );
}
