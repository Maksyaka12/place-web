// Projects (/projects): every project on Place as a card. Tokens launched on Place are projects on their own, run by
// whoever launched them; external tokens join through Register token. A card opens the project page (/token/:address)
// with its rewards, staking, campaigns and collections.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Boxes, Gift, Rocket, Search } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useCampaigns } from '../../place/hooks';
import { useHubStreams, useLaunchTokens, useStakingPrograms } from '../hooks.js';
import { TokenArt, Stat, launchNewPath } from './parts.jsx';
import { money } from './TokenCard.jsx';
import { hubItems } from './HubPage.jsx';
import { tokenEconomy } from '../economy.js';
import { compact } from '../format.js';

const TYPES = [
  ['all', 'All'],
  ['economy', 'Economy'],
  ['standard', 'Standard'],
];
const CATEGORIES = [
  ['all', 'All'],
  ['crypto', 'Crypto'],
  ['stocks', 'Stocks'],
];
const SORTS = [
  ['mcap', 'Market cap'],
  ['new', 'Newest'],
  ['campaigns', 'Most campaigns'],
];

export const projectPath = (address) => `/token/${address}`;

/** Live and upcoming rewards per target address: streams, staking vaults and snapshot campaigns. */
function useCampaignCounts() {
  const streams = useHubStreams({});
  const staking = useStakingPrograms({});
  const snapshots = useCampaigns({ status: 'all', limit: 100 });
  return useMemo(() => {
    const m = new Map();
    for (const it of hubItems(streams.data?.streams, staking.data?.programs, snapshots.data?.campaigns)) {
      if (it.status === 'ended') continue;
      const a = String(it.target.address || '').toLowerCase();
      m.set(a, (m.get(a) || 0) + 1);
    }
    return m;
  }, [streams.data, staking.data, snapshots.data]);
}

function ProjectCard({ t, campaigns }) {
  const econ = tokenEconomy(t);
  const q = t.quote?.symbol || '';
  const rewards = econ?.shares && econ.shares.holders + econ.shares.traders > 0;
  return (
    <Link to={projectPath(t.address)} className="card card-hover pl-launch-card pl-projects-card" data-testid="project-card">
      <div className="pl-launch-art">
        <TokenArt token={t} />
        <div className="pl-launch-art-overlay" />
        <div className="pl-launch-art-badges">
          <Badge tone={econ?.type === 'economy' ? 'accent' : 'neutral'}>{econ?.type === 'economy' ? 'Economy' : 'Standard'}</Badge>
          {t.generation < 3 && <Badge tone="neutral">{t.version || (t.generation === 2 ? '0.2.0' : '0.1.0')}</Badge>}
        </div>
        <div className="pl-launch-art-title">
          <span className="pl-launch-art-name">{t.name}</span>
          <span className="pl-launch-art-symbol">${t.symbol}</span>
        </div>
      </div>
      <div className="pl-launch-card-body">
        <div className="pl-launch-card-mc">
          <span className="pl-launch-card-mc-value mono">{money(t.marketCapUsd, t.marketCap, q)}</span>
          <span className="pl-launch-card-mc-label">MC</span>
        </div>
        <div className="pl-launch-card-stats">
          <Stat label="Campaigns" value={String(campaigns)} />
          <Stat label="Holders" value={compact(t.holders)} className="right" />
        </div>
        <div className="pl-projects-tags">
          {econ?.type === 'economy' && (
            <Badge tone="neutral">
              Tax {econ.buyTax}% / {econ.sellTax}%
            </Badge>
          )}
          {rewards && (
            <Badge tone="success">
              <Gift size={11} /> Rewards
            </Badge>
          )}
        </div>
        <div className="pl-launch-card-foot">
          <span className="pl-launch-pair">
            {t.symbol} / {q || 'Pair'}
          </span>
          <span className="pl-launch-muted pl-launch-small">
            <Rocket size={12} /> Place
          </span>
        </div>
      </div>
    </Link>
  );
}

function Seg({ label, options, value, onChange }) {
  return (
    <div className="seg soft" role="tablist" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export default function ProjectsPage() {
  const [text, setText] = useState('');
  const [type, setType] = useState('all');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('mcap');
  const q = useLaunchTokens({
    sort: sort === 'new' ? 'new' : 'mcap',
    limit: 100,
    ...(category !== 'all' ? { category } : {}),
    ...(text.trim() ? { q: text.trim() } : {}),
  });
  const counts = useCampaignCounts();
  const countOf = (t) => counts.get(String(t.address).toLowerCase()) || 0;
  const tokens = useMemo(() => {
    const list = (q.data?.tokens || []).filter((t) => type === 'all' || (tokenEconomy(t)?.type === 'economy') === (type === 'economy'));
    const n = (t) => counts.get(String(t.address).toLowerCase()) || 0;
    return sort === 'campaigns' ? [...list].sort((a, b) => n(b) - n(a)) : list;
  }, [q.data, type, sort, counts]);

  return (
    <div className="pl-place-stack pl-projects">
      <PageHeader
        title="Projects"
        description="Every project on Place with its rewards, staking, campaigns and collections"
        action={
          <div className="pl-projects-actions">
            <Button as={Link} to="/projects/register">
              <BadgeCheck size={15} /> Register token
            </Button>
            <Button as={Link} to={launchNewPath()} variant="primary">
              <Rocket size={15} /> Launch token
            </Button>
          </div>
        }
      />
      <div className="pl-projects-toolbar">
        <label className="pl-launch-search">
          <Search size={15} />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name, ticker or address" aria-label="Search projects" />
        </label>
        <div className="pl-projects-filters">
          <Seg label="Launch type" options={TYPES} value={type} onChange={setType} />
          <Seg label="Pair" options={CATEGORIES} value={category} onChange={setCategory} />
          <Seg label="Sort" options={SORTS} value={sort} onChange={setSort} />
        </div>
      </div>
      {q.isLoading ? (
        <div className="pl-launch-grid">
          <Skeleton count={5} height={300} />
        </div>
      ) : q.error ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : tokens.length ? (
        <div className="pl-launch-grid">
          {tokens.map((t) => (
            <ProjectCard key={t.address} t={t} campaigns={countOf(t)} />
          ))}
        </div>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Boxes size={28} />}
            title={q.data?.tokens?.length || text.trim() ? 'No projects match' : 'No projects yet'}
            description={q.data?.tokens?.length || text.trim() ? 'Clear a filter or the search to see more projects.' : 'Projects appear here when tokens launch on Place or their creators register them.'}
            action={
              <Button as={Link} to={launchNewPath()} variant="primary">
                Launch token
              </Button>
            }
          />
        </Card>
      )}
    </div>
  );
}
