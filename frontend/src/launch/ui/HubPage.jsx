// Rewards hub (/hub): every reward on Place in one list, in the vault look (cards or a table with filters).
// Four kinds of reward: staking (PlaceStaking vaults), holders, traders and NFT holders (daily streams of the
// PlaceRewardsDistributor), plus the older one-off snapshot campaigns of PlaceHub. Each shows where it comes
// from: the token's own economy (tax), its Community Pool, its creator, or anyone in the community.
// `?type=` opens a tab, `?token=` narrows to one token, `?stream=<id>` opens one stream.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Gift, BarChart3, Coins, Image as ImageIcon, Layers, LayoutGrid, Plus, Rocket, Search, Sparkles, Table as TableIcon } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '../../themes/place/components/ui';
import { QueryError, Skeleton, campaignPath } from '../../themes/place/pages/place/parts';
import { usePlaceAccount } from '../../place/hooks';
import { useCampaigns } from '../../place/hooks';
import { useHubStreams, useStakingPrograms } from '../hooks.js';
import { compact, usd } from '../format.js';
import { formatUtc } from '../../place/format';
import { FilterMenu, PairLogos, PhaseBadge, CopyId, Withdrawal, aprText, num, vaultStats, PHASE_ORDER, useViewMode, amountText, conditionText, sym, SOURCE_BADGE } from './vaults.jsx';
import HubStreamDetail from './HubStreamDetail.jsx';

export const TYPES = [
  ['all', 'All', Layers],
  ['staking', 'Staking', Coins],
  ['holders', 'Holders', Gift],
  ['traders', 'Traders', BarChart3],
  ['nft', 'NFT holders', ImageIcon],
];
const VERB = { staking: 'Stake', holders: 'Hold', traders: 'Trade', nft: 'Hold' };
const PHASES = [
  ['upcoming', 'Upcoming'],
  ['open', 'Open'],
  ['live', 'Live'],
  ['ended', 'Ended'],
];
const SOURCES = [
  ['economy', 'Token economy'],
  ['official', 'Creators and pools'],
  ['community', 'Community'],
  ['external', 'Tokens from other launchpads'],
];
const SORTS = [
  ['recommended', 'Recommended'],
  ['day', 'Most per day'],
  ['pool', 'Biggest pool'],
  ['apr', 'Highest APR'],
  ['new', 'Newest'],
  ['ending', 'Ending soon'],
];
/** One stream as a hub item. */
function fromStream(s) {
  const r = s.rewardToken;
  const usdOrAmount = (u, raw) => (u == null ? `${amountText(raw, r.decimals)} ${sym(r)}` : usd(u));
  return {
    key: `s:${s.id}`,
    id: s.id,
    kind: 'stream',
    type: s.type,
    source: s.source,
    placeToken: s.placeToken || s.placeCollection,
    status: s.status,
    target: s.token,
    reward: r,
    title: `${VERB[s.type]} ${sym(s.token)}${s.type === 'nft' ? ' NFT' : ''} · Earn ${sym(r)}`,
    to: `/hub?stream=${s.id}`,
    cells: [
      { label: s.source === 'economy' ? 'Last day' : 'Per day', value: `${amountText(s.perDay, r.decimals)} ${sym(r)}`, sub: s.perDayUsd == null ? null : usd(s.perDayUsd) },
      { label: s.source === 'economy' ? 'Funded so far' : 'Pool', value: usdOrAmount(s.poolUsd, s.pool), sub: s.poolUsd == null ? (s.source === 'economy' ? 'From the tax' : null) : `${amountText(s.pool, r.decimals)} ${sym(r)}` },
      { label: 'Epochs', value: s.epochCount ? `${s.daysDone} / ${s.epochCount}` : `${s.daysDone}`, sub: s.epochCount ? 'UTC days' : 'Every day, no end' },
      { label: 'Condition', value: conditionText(s), small: true },
    ],
    unsupported: s.unsupported,
    placeCollection: s.placeCollection,
    claimable: s.mine && s.mine.claimable !== '0' ? s.mine.claimable : null,
    mine: Boolean(s.mine && (s.mine.funded || s.mine.earned !== '0')),
    funded: Boolean(s.mine?.funded),
    sort: { day: s.perDayUsd ?? 0, pool: s.poolUsd ?? 0, apr: null, created: new Date(s.createdAt).getTime(), ends: s.endsAt ? new Date(s.endsAt).getTime() : Infinity },
  };
}

/** One PlaceStaking vault as a hub item. */
function fromStaking(p, officialOf) {
  const v = vaultStats(p);
  const perDay = (num(p.rewardPerEpoch, p.rewardToken.decimals, 8) * 86_400) / p.epochDuration;
  return {
    key: `v:${p.id}`,
    id: p.id,
    kind: 'staking',
    type: 'staking',
    source: p.fromLaunchVault ? 'pool' : officialOf(p) ? 'creator' : 'community',
    placeToken: p.launchedOnPlace,
    status: p.status,
    target: p.stakingToken,
    reward: p.rewardToken,
    title: `Stake ${sym(p.stakingToken)} · Earn ${sym(p.rewardToken)}`,
    to: `/staking?program=${p.id}`,
    cells: [
      { label: 'Live APR', value: aprText(v.apr) },
      { label: 'TVL', value: v.tvlUsd == null ? `${compact(v.staked)} ${sym(p.stakingToken)}` : usd(v.tvlUsd), sub: v.tvlUsd == null ? null : `${compact(v.staked)} ${sym(p.stakingToken)}` },
      { label: 'Epochs', value: `${v.done} / ${p.epochCount}`, sub: `${Math.round(p.epochDuration / 86_400)}d each` },
      { label: 'Early withdrawal', node: <Withdrawal p={p} /> },
    ],
    staked: Boolean(p.position && p.position.staked !== '0'),
    mine: Boolean(p.position && p.position.staked !== '0'),
    sort: {
      day: p.rewardToken.usd != null ? perDay * p.rewardToken.usd : 0,
      pool: v.tvlUsd ?? 0,
      apr: v.apr,
      created: new Date(p.createdAt).getTime(),
      ends: new Date(p.endsAt).getTime(),
    },
  };
}

const SNAPSHOT_PHASE = { live: 'live', scheduled: 'upcoming', snapshotting: 'upcoming' };

/** One PlaceHub snapshot campaign (older, one payout) as a hub item. */
function fromCampaign(c) {
  const target = { address: c.target, symbol: c.targetMeta?.symbol, name: c.targetMeta?.name };
  const reward = { address: c.rewardToken, symbol: c.rewardMeta?.symbol, name: c.rewardMeta?.name, decimals: c.rewardMeta?.decimals ?? 18 };
  const type = c.kind === 'nft-holders' ? 'nft' : 'holders';
  const day = (d) => (d ? formatUtc(d).replace(/, \d{2}:\d{2} UTC$/, '') : '—');
  return {
    key: `c:${c.hub}:${c.id}`,
    id: `#${c.id}`,
    kind: 'snapshot',
    type,
    source: c.fromLaunchVault ? 'pool' : c.section === 'official' ? 'creator' : 'community',
    placeToken: c.launchedOnPlace,
    status: SNAPSHOT_PHASE[c.status] || 'ended',
    target,
    reward,
    title: `${VERB[type]} ${sym(target)}${type === 'nft' ? ' NFT' : ''} · Earn ${sym(reward)}`,
    to: campaignPath(c),
    cells: [
      { label: 'Pool', value: `${amountText(c.pool, reward.decimals)} ${sym(reward)}` },
      { label: 'Claimed', value: `${amountText(c.claimed, reward.decimals)} ${sym(reward)}` },
      { label: 'Snapshot', value: day(c.snapshotAt), sub: 'UTC, one payout' },
      { label: 'Claim until', value: day(c.claimEnd) },
    ],
    table: ['One payout', `${amountText(c.pool, reward.decimals)} ${sym(reward)}`, `Snapshot ${day(c.snapshotAt)}`, `Claim until ${day(c.claimEnd)}`],
    snapshot: true,
    sort: { day: 0, pool: 0, apr: null, created: new Date(c.snapshotAt).getTime(), ends: c.claimEnd ? new Date(c.claimEnd).getTime() : Infinity },
  };
}

/** Every reward as hub items: streams (`launch/hub`), staking programs (`launch/staking`), snapshot campaigns. */
export function hubItems(streams = [], programs = [], campaigns = []) {
  const officialOf = (p) => streams.some((s) => s.token.address === p.stakingToken.address && s.funder === p.creator && s.source === 'creator');
  return [...streams.map(fromStream), ...programs.map((p) => fromStaking(p, officialOf)), ...campaigns.filter((c) => !c.hidden).map(fromCampaign)];
}

function Tags({ it }) {
  const [label, tone] = SOURCE_BADGE[it.source] || [it.source, 'neutral'];
  return (
    <div className="pl-staking-tags">
      <Badge tone={tone}>{label}</Badge>
      {it.placeCollection ? (
        <Badge tone="neutral">
          <Sparkles size={11} /> Place collection
        </Badge>
      ) : (
        it.placeToken && (
          <Badge tone="neutral">
            <Rocket size={11} /> Launched on Place
          </Badge>
        )
      )}
      {it.snapshot && <Badge tone="neutral">Snapshot</Badge>}
      {it.unsupported && <Badge tone="warn">Not supported</Badge>}
      {it.claimable && <Badge tone="success">You can claim</Badge>}
      {it.staked && <Badge tone="success">You stake</Badge>}
      {it.funded && <Badge tone="neutral">You funded</Badge>}
    </div>
  );
}

export function HubCard({ it }) {
  const navigate = useNavigate();
  const open = () => navigate(it.to);
  return (
    <Card hover className="pl-vault-card pl-rewards-card" onClick={open} role="link" tabIndex={0} aria-label={it.title} onKeyDown={(e) => e.key === 'Enter' && open()}>
      <div className="pl-vault-head">
        <PairLogos a={it.target} b={it.reward} />
        <div className="pl-vault-title">
          <span className="pl-vault-name">{it.title}</span>
          {it.kind === 'snapshot' ? <span className="pl-vault-id mono">Campaign {it.id}</span> : <CopyId id={it.id} />}
        </div>
        <PhaseBadge status={it.status} />
        <ArrowUpRight size={16} className="pl-vault-arrow" />
      </div>
      <dl className="pl-vault-grid">
        {it.cells.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className={c.node ? undefined : `mono ${c.small ? 'pl-rewards-small' : ''}`.trim()}>{c.node || c.value}</dd>
            {c.sub && <dd className="mono pl-vault-sub">{c.sub}</dd>}
          </div>
        ))}
      </dl>
      <Tags it={it} />
    </Card>
  );
}

const TYPE_LABEL = Object.fromEntries(TYPES.map(([v, l]) => [v, l]));

function HubTable({ list }) {
  return (
    <div className="pl-schedule-card pl-vault-table">
      <div className="pl-vault-row pl-rewards-row head">
        <span>Reward</span>
        <span>Type</span>
        <span>Per day / APR</span>
        <span>Pool / TVL</span>
        <span>Epochs</span>
        <span>Condition</span>
        <span>Status</span>
      </div>
      {list.map((it) => (
        <Link key={it.key} to={it.to} className="pl-vault-row pl-rewards-row">
          <span className="pl-vault-row-name">
            <PairLogos a={it.target} b={it.reward} size={24} />
            <span className="pl-rewards-row-title">
              <span>{it.title}</span>
              <span className="pl-launch-muted pl-launch-small">{SOURCE_BADGE[it.source]?.[0]}</span>
            </span>
          </span>
          <span>{TYPE_LABEL[it.type]}</span>
          {it.table ? (
            it.table.map((v, i) => (
              <span key={i} className={i === 3 ? 'mono pl-rewards-small' : 'mono'}>
                {v}
              </span>
            ))
          ) : (
            <>
              <span className="mono">{it.cells[0].value}</span>
              <span className="mono">{it.cells[1].value}</span>
              <span className="mono">{it.cells[2].value}</span>
              <span className={it.cells[3].node ? undefined : 'mono pl-rewards-small'}>{it.cells[3].node || it.cells[3].value}</span>
            </>
          )}
          <span>
            <PhaseBadge status={it.status} />
          </span>
        </Link>
      ))}
    </div>
  );
}

function HubList() {
  const { address } = usePlaceAccount();
  const [params, setParams] = useSearchParams();
  const type = TYPES.some(([v]) => v === params.get('type')) ? params.get('type') : 'all';
  const [reward, setReward] = useState(null);
  const [token, setToken] = useState(params.get('token')?.toLowerCase() || null);
  const [phase, setPhase] = useState(null);
  const [source, setSource] = useState(null);
  const [sort, setSort] = useState('recommended');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [view, pickView] = useViewMode();

  const streams = useHubStreams(address ? { account: address } : {});
  const staking = useStakingPrograms(address ? { account: address } : {});
  const snapshots = useCampaigns({ status: 'all', limit: 100 });

  const items = useMemo(() => hubItems(streams.data?.streams, staking.data?.programs, snapshots.data?.campaigns), [streams.data, staking.data, snapshots.data]);

  const counts = useMemo(() => {
    const out = { all: 0 };
    for (const it of items) {
      if (it.status === 'ended') continue;
      out.all++;
      out[it.type] = (out[it.type] || 0) + 1;
    }
    return out;
  }, [items]);

  const options = (side) => [...new Map(items.filter((i) => type === 'all' || i.type === type).map((i) => [i[side].address, sym(i[side])])).entries()];
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = items.filter(
      (it) =>
        (type === 'all' || it.type === type) &&
        (reward == null || it.reward.address === reward) &&
        (token == null || it.target.address === token) &&
        (phase == null || it.status === phase) &&
        (source == null ||
          (source === 'economy' && it.source === 'economy') ||
          (source === 'official' && (it.source === 'pool' || it.source === 'creator')) ||
          (source === 'community' && it.source === 'community') ||
          (source === 'external' && !it.placeToken)) &&
        (!mine || it.mine || it.claimable) &&
        (!term ||
          String(it.id).toLowerCase().startsWith(term) ||
          String(it.target.address).toLowerCase() === term ||
          [it.target.symbol, it.reward.symbol, it.target.name].some((s) => String(s || '').toLowerCase().includes(term)))
    );
    const by = {
      recommended: (a, b) => PHASE_ORDER[a.status] - PHASE_ORDER[b.status] || Boolean(a.unsupported) - Boolean(b.unsupported) || Boolean(a.snapshot) - Boolean(b.snapshot) || b.sort.day - a.sort.day || b.sort.pool - a.sort.pool,
      day: (a, b) => b.sort.day - a.sort.day,
      pool: (a, b) => b.sort.pool - a.sort.pool,
      apr: (a, b) => (b.sort.apr ?? -1) - (a.sort.apr ?? -1),
      new: (a, b) => b.sort.created - a.sort.created,
      ending: (a, b) => (a.status === 'ended') - (b.status === 'ended') || a.sort.ends - b.sort.ends,
    };
    return [...list].sort(by[sort]);
  }, [items, type, reward, token, phase, source, mine, search, sort]);

  const loading = streams.isLoading && staking.isLoading;
  const error = streams.error && staking.error ? streams.error : null;
  const perDayUsd = items.filter((i) => i.status === 'live').reduce((s, i) => s + (i.sort.day || 0), 0);
  const claimable = items.filter((i) => i.claimable).length;
  const setType = (v) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete('type');
    else next.set('type', v);
    setParams(next, { replace: true });
    setReward(null);
  };

  return (
    <div className="pl-rewards">
      <div className="pl-rewards-head">
        <div className="pl-vaults-header">
          <h1 className="page-title">Rewards</h1>
          <p className="page-desc">All in one place: staking, holder, trader and NFT holder rewards for any token on Base</p>
        </div>
        <div className="pl-rewards-actions">
          <Button as={Link} to="/launch/nft">
            <Sparkles size={15} /> Launch NFT
          </Button>
          <Button as={Link} to={token ? `/create?token=${token}` : '/create'} variant="primary">
            <Plus size={16} /> Create vault / campaign
          </Button>
        </div>
      </div>

      <div className="pl-rewards-stats">
        <div>
          <span>Live now</span>
          <strong className="mono">{counts.all}</strong>
        </div>
        <div>
          <span>Paid out per day</span>
          <strong className="mono">{perDayUsd ? usd(perDayUsd) : '—'}</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong className="mono">{new Set(items.map((i) => i.target.address)).size}</strong>
        </div>
        <div>
          <span>You can claim</span>
          <strong className="mono">{address ? (claimable ? `${claimable} ${claimable === 1 ? 'reward' : 'rewards'}` : 'Nothing yet') : '—'}</strong>
          {address && claimable > 0 && (
            <Link className="pl-place-link pl-launch-small" to="/profile/rewards">
              Claim all in Profile
            </Link>
          )}
        </div>
      </div>

      <div className="pl-launch-tabs-scroll">
        <div className="seg soft pl-rewards-types" role="tablist" aria-label="Type of reward">
          {TYPES.map(([v, label, Icon]) => (
            <button key={v} type="button" role="tab" aria-selected={type === v} onClick={() => setType(v)}>
              <Icon size={14} /> {label}
              {counts[v] ? <span className="pl-rewards-count">{counts[v]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="pl-vaults-toolbar">
        <div className="pl-vaults-filters">
          <FilterMenu label="Reward currency" value={reward} options={options('reward')} onChange={setReward} />
          <FilterMenu label={type === 'staking' ? 'Staking token' : type === 'nft' ? 'Collection' : 'Token'} value={token} options={options('target')} onChange={setToken} />
          <FilterMenu label="Phase" value={phase} options={PHASES} onChange={setPhase} />
          <FilterMenu label="Source" value={source} options={SOURCES} onChange={setSource} />
          <FilterMenu label="Sort" value={sort} options={SORTS} onChange={(v) => setSort(v || 'recommended')} anyLabel={null} />
          <button
            type="button"
            className={`pl-filter-btn ${mine ? 'on' : ''}`.trim()}
            aria-pressed={mine}
            onClick={() => setMine((v) => !v)}
            disabled={!address}
            title={address ? 'Rewards you earn, stake in or funded' : 'Connect wallet to see your rewards'}
          >
            Mine
          </button>
        </div>
        <div className="pl-vaults-right">
          <label className="pl-launch-search pl-vaults-search">
            <Search size={16} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ID, token or address" aria-label="Search rewards" />
          </label>
          <div className="seg soft" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'cards'} onClick={() => pickView('cards')}>
              <LayoutGrid size={14} /> Cards
            </button>
            <button type="button" role="tab" aria-selected={view === 'table'} onClick={() => pickView('table')}>
              <TableIcon size={14} /> Table
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="pl-vaults-grid">
          <Skeleton count={4} height={210} />
        </div>
      ) : error ? (
        <QueryError error={error} retry={() => (streams.refetch(), staking.refetch())} />
      ) : shown.length ? (
        <>
          <p className="pl-vaults-total">
            Total {shown.length} {shown.length === 1 ? 'reward' : 'rewards'}
          </p>
          {view === 'table' ? (
            <HubTable list={shown} />
          ) : (
            <div className="pl-vaults-grid">
              {shown.map((it) => (
                <HubCard key={it.key} it={it} />
              ))}
            </div>
          )}
        </>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Gift size={28} />}
            title={items.length ? 'Nothing matches these filters' : 'No rewards yet'}
            description={items.length ? 'Clear a filter or the search to see more rewards.' : 'Rewards show up here as soon as a token pays its holders or traders, or someone funds a vault or a campaign.'}
            action={
              <Button as={Link} to="/create" variant="primary">
                Create vault / campaign
              </Button>
            }
          />
        </Card>
      )}
    </div>
  );
}

export default function HubPage() {
  const [params] = useSearchParams();
  const stream = params.get('stream');
  return stream ? <HubStreamDetail id={stream.toLowerCase()} /> : <HubList />;
}
