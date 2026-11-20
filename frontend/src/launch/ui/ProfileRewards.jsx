// Profile → Rewards: everything this wallet earns as one list of rows, with the type tabs of the Rewards hub
// (All · Staking · Holders · Traders · NFT holders). A row: logo, name, the source under it ("Token economy ·
// TICKER", "NFT holders pool · SYMBOL", "Campaign", "Campaign · Community Pool", "Staking vault"), the amount to
// claim and Claim. Sources: staking vaults the wallet is in (PlaceStaking; a link opens the vault), daily rewards of
// the distributor (Claim all: one claimMany per rewards contract), the 30-day holders pools of NFT collections
// (claim(ids), one per collection, also in Claim all) and one-off snapshot campaigns of PlaceHub (claimFor). Their claim history is folded at the bottom.
// Logic in ../profileRewards.js.
import { useMemo } from 'react';
import { encodeFunctionData } from 'viem';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BarChart3, ChevronDown, Coins, ExternalLink, Gift, History, Image as ImageIcon, Layers } from 'lucide-react';
import { Badge, Button } from '../../themes/place/components/ui';
import { TxButton, TxResult, QueryError, Skeleton, campaignTitle, campaignPath } from '../../themes/place/pages/place/parts';
import { usePlaceTx, useClaims, useCampaignMeta } from '../../place/hooks';
import { formatAmount, formatToken, formatUtc } from '../../place/format';
import { explorerTx } from '../../place/chain';
import { PLACE_HUB_ABI } from '../../place/abi';
import { useRewards, useHubStreams, useStakingPrograms, useStakingPosition, useNftAccount } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { NFT_COLLECTION_ABI } from '../nftAbi.js';
import { collectionPath } from '../nft.js';
import { REWARD_FILTERS, profileRewardGroups, campaignType } from '../profileRewards.js';
import { AssetLogo } from './vaults.jsx';
import { TokenLogo } from './parts.jsx';

const ICONS = { all: Layers, staking: Coins, holders: Gift, traders: BarChart3, nft: ImageIcon };
const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

/** The source of a distributor stream as the row says it. */
function streamSource(source, token) {
  if (source === 'economy') return [`Token economy · ${token.symbol || 'token'}`, 'accent'];
  if (source === 'pool') return ['Campaign · Community Pool', 'accent'];
  return ['Campaign', source === 'creator' ? 'accent' : 'neutral'];
}

/** One row of the list: logo and name (a link), the source badge, the amount and the actions. */
function Row({ to, logo, name, source, tone = 'neutral', extra, amount, sub, children, result }) {
  return (
    <div className="pl-launch-reward-row">
      <Link to={to} className="pl-launch-reward-token">
        {logo}
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{name}</span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <Badge tone={tone}>{source}</Badge>
            {extra}
          </span>
        </span>
      </Link>
      <span className="pl-launch-reward-amounts">
        <span className="mono pl-launch-strong">{amount}</span>
        {sub && <span className="pl-launch-muted pl-launch-small mono">{sub}</span>}
      </span>
      <span className="pl-profile-stake-actions">{children}</span>
      {result}
    </div>
  );
}

function StakingRow({ p, account }) {
  const pos = useStakingPosition(p.id, account);
  const tx = usePlaceTx();
  const s = p.stakingToken;
  const r = p.rewardToken;
  const staked = pos.data?.staked ?? p.position?.staked ?? '0';
  return (
    <Row
      to={`/staking?program=${p.id}`}
      logo={<AssetLogo token={s} size={36} />}
      name={s.name || s.symbol}
      source="Staking vault"
      tone="accent"
      extra={`Stake ${s.symbol} · Earn ${r.symbol}`}
      amount={pos.isLoading ? '…' : rewardText(pos.data?.claimable?.total, r)}
      sub={`Staked ${rewardText(staked, s)}`}
      result={
        (tx.status !== 'idle' || pos.error) && (
          <div className="pl-launch-reward-result">
            {pos.error && <QueryError error={pos.error} retry={pos.refetch} />}
            <TxResult tx={tx} success="Claimed" />
          </div>
        )
      }
    >
      <TxButton tx={tx} size="sm" disabled={!pos.data?.tx?.claim} busyLabel="Claiming..." onClick={() => tx.send({ label: 'Claim staking rewards', to: pos.data.tx.claim.to, data: pos.data.tx.claim.data })}>
        Claim
      </TxButton>
      <Button as={Link} to={`/staking?program=${p.id}`} size="sm" variant="ghost" aria-label="Open vault">
        Vault <ArrowUpRight size={14} />
      </Button>
    </Row>
  );
}

function StreamRow({ item, source, pending, account }) {
  const tx = usePlaceTx();
  const t = item.token;
  const r = item.rewardToken;
  const [label, tone] = streamSource(source, t);
  const send = () => tx.send({ label: `Claim ${t.symbol || 'token'} rewards`, to: item.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claim', args: [item.streamId, account, BigInt(item.cumulative), item.proof] });
  return (
    <Row
      to={`/hub?stream=${item.streamId}`}
      logo={<AssetLogo token={t} size={36} />}
      name={t.name || t.symbol}
      source={label}
      tone={tone}
      amount={rewardText(item.claimable, r)}
      sub={pending ? `+${rewardText(pending.amount, r)} being published` : null}
      result={
        tx.status !== 'idle' && (
          <div className="pl-launch-reward-result">
            <TxResult tx={tx} success="Claimed" />
          </div>
        )
      }
    >
      <TxButton tx={tx} size="sm" busyLabel="Claiming..." onClick={send}>
        Claim
      </TxButton>
    </Row>
  );
}

function PoolRow({ c, item }) {
  const tx = usePlaceTx();
  const ids = item.ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id));
  const r = item.rewardToken || c?.rewardToken;
  return (
    <Row
      to={collectionPath(item.collection)}
      logo={<TokenLogo token={{ symbol: c?.symbol, name: c?.name, contractURI: c?.contractURI }} size={36} />}
      name={c?.name || 'Collection'}
      source={`NFT holders pool · ${c?.symbol || 'NFT'}`}
      tone="accent"
      extra={`${item.ids.length} NFT${item.ids.length === 1 ? '' : 's'}`}
      amount={item.claimable == null ? '—' : rewardText(item.claimable, r)}
      result={
        tx.status !== 'idle' && (
          <div className="pl-launch-reward-result">
            <TxResult tx={tx} success="Claimed" />
          </div>
        )
      }
    >
      <TxButton tx={tx} size="sm" busyLabel="Claiming..." onClick={() => tx.send({ label: 'Claim', to: item.collection, abi: NFT_COLLECTION_ABI, functionName: 'claim', args: [ids] })}>
        Claim
      </TxButton>
    </Row>
  );
}

/** A one-off snapshot campaign of PlaceHub with a payout ready for this wallet. */
function CampaignRow({ c, account }) {
  const { data: meta } = useCampaignMeta(c);
  const tx = usePlaceTx();
  const send = () => tx.send({ label: 'Claim', to: c.hub, abi: PLACE_HUB_ABI, functionName: 'claimFor', args: [account, BigInt(c.id), BigInt(c.amount), c.proof] });
  return (
    <Row
      to={campaignPath(c)}
      logo={<TokenLogo token={{ symbol: c.targetMeta?.symbol || c.rewardMeta?.symbol }} size={36} shape="round" />}
      name={campaignTitle(c, meta)}
      source="Campaign"
      extra={`Claim until ${formatUtc(c.claimEnd)}`}
      amount={formatToken(c.amount, c.rewardMeta)}
      result={
        tx.status !== 'idle' && (
          <div className="pl-launch-reward-result">
            <TxResult tx={tx} success="Claimed" />
          </div>
        )
      }
    >
      <TxButton tx={tx} size="sm" busyLabel="Claiming..." disabled={tx.status === 'success'} onClick={send}>
        Claim
      </TxButton>
    </Row>
  );
}

function HistoryRow({ c, kind }) {
  const { data: meta } = useCampaignMeta(c);
  return (
    <div className="pl-place-row">
      <div className="pl-place-row-main">
        <Link className="pl-place-row-title" to={campaignPath(c)}>
          {campaignTitle(c, meta)}
        </Link>
        <span className="pl-place-row-sub">
          {kind === 'claimed' ? 'Claimed' : `Expired ${formatUtc(c.claimEnd)}`}
          {kind === 'claimed' && c.claimTx && (
            <>
              {' · '}
              <a className="pl-place-link" href={explorerTx(c.claimTx)} target="_blank" rel="noopener noreferrer">
                Transaction <ExternalLink size={11} />
              </a>
            </>
          )}
        </span>
      </div>
      <div className="pl-place-row-amount">{formatToken(c.amount, c.rewardMeta)}</div>
    </div>
  );
}

export function ProfileRewards({ address }) {
  const [params, setParams] = useSearchParams();
  const filter = REWARD_FILTERS.some(([v]) => v === params.get('type')) ? params.get('type') : 'all';
  const rewards = useRewards(address);
  const streams = useHubStreams({ account: address });
  const programs = useStakingPrograms({ account: address, mine: '1', limit: 200 });
  const nfts = useNftAccount(address);
  const claims = useClaims(address);
  const allTx = usePlaceTx();

  const campaigns = useMemo(() => claims.data?.claimable || [], [claims.data]);
  const groups = useMemo(
    () =>
      profileRewardGroups({
        rewards: rewards.data?.rewards,
        streams: streams.data?.streams,
        programs: programs.data?.programs,
        collections: nfts.data?.deployed ? nfts.data.claimable : [],
        campaigns,
      }),
    [rewards.data, streams.data, programs.data, nfts.data, campaigns]
  );
  const sourceOf = new Map((streams.data?.streams || []).map((s) => [s.id, s.source]));
  const pending = new Map((rewards.data?.pending || []).map((p) => [p.streamId, p]));
  const collectionOf = new Map([...(nfts.data?.owned || []).map((o) => o.collection), ...(nfts.data?.created || [])].map((c) => [c.address, c]));
  const claimMany = rewards.data?.claimMany || [];
  const campaignTxs = claims.data?.transactions || [];
  // NFT holders pools: one claim(ids) per collection, with the NFTs that have something to claim.
  const poolTxs = groups.nft.pools
    .map((item) => ({ to: item.collection, ids: item.ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id)) }))
    .filter((p) => p.ids.length)
    .map((p) => ({ to: p.to, data: encodeFunctionData({ abi: NFT_COLLECTION_ABI, functionName: 'claim', args: [p.ids] }), value: 0n }));
  const allTxs = [
    ...claimMany.map((c) => ({ to: c.to, data: c.data, value: 0n })),
    ...poolTxs,
    ...campaignTxs.map((t) => ({ to: t.to, data: t.data, value: t.value })),
  ];
  const dueCount = groups.holders.length + groups.traders.length + groups.nft.streams.length + poolTxs.length + campaigns.length;
  const history = [...(claims.data?.claimed || []).map((c) => ({ c, kind: 'claimed' })), ...(claims.data?.expired || []).map((c) => ({ c, kind: 'expired' }))];
  const setFilter = (v) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete('type');
    else next.set('type', v);
    setParams(next, { replace: true });
  };
  const show = (k) => filter === 'all' || filter === k;
  const loading = rewards.isLoading || programs.isLoading;
  const error = rewards.error || programs.error;
  const streamRows = (list) => list.map((i) => <StreamRow key={i.streamId} item={i} source={sourceOf.get(i.streamId)} pending={pending.get(i.streamId)} account={address} />);
  const campaignRows = (kind) => campaigns.filter((c) => campaignType(c) === kind).map((c) => <CampaignRow key={`${c.hub}:${c.id}`} c={c} account={address} />);

  const rows = [
    ...(show('staking') ? groups.staking.map((p) => <StakingRow key={p.id} p={p} account={address} />) : []),
    ...(show('holders') ? [...streamRows(groups.holders), ...campaignRows('holders')] : []),
    ...(show('traders') ? streamRows(groups.traders) : []),
    ...(show('nft')
      ? [...streamRows(groups.nft.streams), ...groups.nft.pools.map((item) => <PoolRow key={item.collection} c={collectionOf.get(item.collection)} item={item} />), ...campaignRows('nft')]
      : []),
  ];

  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Rewards</h2>
          <p className="pl-launch-section-desc">Staking, holder, trader and NFT holder rewards of this wallet. Daily rewards add up and never expire.</p>
        </div>
        <TxButton
          tx={allTx}
          disabled={!allTxs.length}
          busyLabel="Claiming on Base..."
          onClick={() => allTx.send(allTxs.map((x, i) => ({ ...x, label: allTxs.length > 1 ? `Claim all (${i + 1} of ${allTxs.length})` : 'Claim all' })))}
        >
          {dueCount ? `Claim all (${dueCount})` : 'Claim all'}
        </TxButton>
      </div>
      <TxResult tx={allTx} success="All daily, NFT holder and campaign rewards claimed" />

      <div className="pl-launch-tabs-scroll">
        <div className="seg soft pl-rewards-types" role="tablist" aria-label="Type of reward">
          {REWARD_FILTERS.map(([v, label]) => {
            const Icon = ICONS[v];
            return (
              <button key={v} type="button" role="tab" aria-selected={filter === v} onClick={() => setFilter(v)}>
                <Icon size={14} /> {label}
                {groups.counts[v] ? <span className="pl-rewards-count">{groups.counts[v]}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {error ? (
        <QueryError error={error} retry={() => (rewards.refetch(), programs.refetch())} />
      ) : loading ? (
        <Skeleton height={72} count={3} />
      ) : rows.length ? (
        <div className="pl-launch-reward-list pl-fee-list">{rows}</div>
      ) : (
        <p className="pl-launch-muted pl-launch-small pl-launch-inline start">
          Nothing to claim here right now.
          <Link className="pl-place-link pl-launch-inline" to="/hub">
            Find rewards <ArrowUpRight size={13} />
          </Link>
        </p>
      )}

      {history.length > 0 && (
        <details className="pl-launch-advanced">
          <summary>
            <History size={14} /> Campaign history ({history.length})
            <ChevronDown size={14} className="pl-launch-advanced-chevron" />
          </summary>
          <div className="pl-launch-advanced-body">
            <div className="pl-place-rows">
              {history.map(({ c, kind }) => (
                <HistoryRow key={`${c.hub}:${c.id}`} c={c} kind={kind} />
              ))}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
