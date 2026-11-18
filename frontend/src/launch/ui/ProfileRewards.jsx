// Profile → Rewards: everything this wallet earns, with the filters of the Rewards hub (All · Staking · Holders ·
// Traders · NFT holders). Staking vaults it takes part in always show, with the end date, Claim (earnings) and
// Withdraw (the stake) apart. Holders, traders and NFT holders show what can be claimed now: daily rewards of the
// distributor (Claim, or Claim all: one claimMany per rewards contract), the 30-day holders pools of NFT collections
// (claim(ids)) and one-off snapshot campaigns. Logic in ../profileRewards.js.
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BarChart3, Coins, Gift, Image as ImageIcon, Layers, Lock } from 'lucide-react';
import { Button, Card, EmptyState, SectionTitle } from '../../themes/place/components/ui';
import { TxButton, TxResult, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { usePlaceTx, useNow, useClaims } from '../../place/hooks';
import { formatAmount, formatUtc } from '../../place/format';
import { useRewards, useHubStreams, useStakingPrograms, useStakingPosition, useNftAccount } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI } from '../abi.js';
import { REWARD_FILTERS, profileRewardGroups, withdrawable } from '../profileRewards.js';
import { PairLogos, PhaseBadge } from './vaults.jsx';
import { NftClaimRow } from './ProfileNfts.jsx';
import CampaignRewards from '../../themes/place/pages/place/RewardsPage.jsx';

const ICONS = { all: Layers, staking: Coins, holders: Gift, traders: BarChart3, nft: ImageIcon };
const TYPE_TEXT = { holders: 'Holder rewards', traders: 'Trader rewards', nft: 'NFT holder rewards' };
const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

/** One staking vault the wallet is in: the end, the stake, what it earned; Claim and Withdraw are separate. */
function StakingRow({ p, account, now }) {
  const pos = useStakingPosition(p.id, account);
  const claimTx = usePlaceTx();
  const withdrawTx = usePlaceTx();
  const s = p.stakingToken;
  const r = p.rewardToken;
  const earned = pos.data?.claimable?.total ?? '0';
  const out = withdrawable(pos.data?.lots, now);
  const staked = pos.data?.staked ?? p.position?.staked ?? '0';
  const ended = p.status === 'ended';
  const withdraw = () =>
    withdrawTx.send(out.ready.map((l) => ({ label: `Withdraw ${s.symbol}`, to: p.staking, abi: PLACE_STAKING_ABI, functionName: 'withdraw', args: [p.id, BigInt(l.lotId), BigInt(l.amount), account] })));
  return (
    <div className="pl-launch-reward-row pl-profile-stake-row">
      <Link to={`/staking?program=${p.id}`} className="pl-launch-reward-token">
        <PairLogos a={s} b={r} size={28} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">
            Stake {s.symbol} · Earn {r.symbol}
          </span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <PhaseBadge status={p.status} /> {ended ? 'Ended' : 'Ends'} {formatUtc(p.endsAt)}
          </span>
        </span>
      </Link>
      <span className="pl-launch-reward-amounts">
        <span className="mono pl-launch-strong">Earned {rewardText(earned, r)}</span>
        <span className="pl-launch-muted pl-launch-small mono">Staked {rewardText(staked, s)}</span>
        {out.total === 0n && out.nextUnlock && (
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <Lock size={11} /> Unlocks {formatUtc(out.nextUnlock)}
          </span>
        )}
      </span>
      <span className="pl-profile-stake-actions">
        <TxButton
          tx={claimTx}
          size="sm"
          disabled={!pos.data?.tx?.claim}
          busyLabel="Claiming..."
          onClick={() => claimTx.send({ label: 'Claim staking rewards', to: pos.data.tx.claim.to, data: pos.data.tx.claim.data })}
        >
          Claim
        </TxButton>
        <TxButton tx={withdrawTx} size="sm" variant="secondary" disabled={out.ready.length === 0} busyLabel="Withdrawing..." onClick={withdraw}>
          Withdraw
        </TxButton>
      </span>
      {(claimTx.status !== 'idle' || withdrawTx.status !== 'idle' || pos.error) && (
        <div className="pl-launch-reward-result">
          {pos.error && <QueryError error={pos.error} retry={pos.refetch} />}
          <TxResult tx={claimTx} success="Claimed" />
          <TxResult tx={withdrawTx} success="Withdrawn" />
        </div>
      )}
    </div>
  );
}

/** One daily reward of the distributor that can be claimed now. */
function StreamRow({ item, pending, account }) {
  const tx = usePlaceTx();
  const t = item.token;
  const r = item.rewardToken;
  const send = () =>
    tx.send({ label: `Claim ${t.symbol || 'token'} ${TYPE_TEXT[item.type]?.toLowerCase() || 'rewards'}`, to: item.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claim', args: [item.streamId, account, BigInt(item.cumulative), item.proof] });
  const Icon = ICONS[item.type] || Gift;
  return (
    <div className="pl-launch-reward-row">
      <Link to={`/hub?stream=${item.streamId}`} className="pl-launch-reward-token">
        <PairLogos a={t} b={r} size={28} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{t.name || t.symbol}</span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <Icon size={12} /> {TYPE_TEXT[item.type] || item.kind}
          </span>
        </span>
      </Link>
      <span className="pl-launch-reward-amounts">
        <span className="mono pl-launch-strong">{rewardText(item.claimable, r)}</span>
        <span className="pl-launch-muted pl-launch-small mono">
          {BigInt(item.claimed || 0) > 0n ? `Claimed ${rewardText(item.claimed, r)}` : 'Not claimed yet'}
          {pending ? ` · +${rewardText(pending.amount, r)} being published` : ''}
        </span>
      </span>
      <TxButton tx={tx} size="sm" busyLabel="Claiming..." onClick={send}>
        Claim
      </TxButton>
      {tx.status !== 'idle' && (
        <div className="pl-launch-reward-result">
          <TxResult tx={tx} success="Claimed" />
        </div>
      )}
    </div>
  );
}

function Group({ title, count, empty, children }) {
  return (
    <div className="pl-place-stack">
      <SectionTitle title={title} count={count} />
      {count ? <Card className="pl-launch-reward-list">{children}</Card> : <p className="pl-launch-muted pl-launch-small">{empty}</p>}
    </div>
  );
}

export function ProfileRewards({ address }) {
  const [params, setParams] = useSearchParams();
  const filter = REWARD_FILTERS.some(([v]) => v === params.get('type')) ? params.get('type') : 'all';
  const now = useNow(60_000);
  const rewards = useRewards(address);
  const streams = useHubStreams({ account: address });
  const programs = useStakingPrograms({ account: address, mine: '1', limit: 200 });
  const nfts = useNftAccount(address);
  const claims = useClaims(address);
  const allTx = usePlaceTx();

  const groups = useMemo(
    () =>
      profileRewardGroups({
        rewards: rewards.data?.rewards,
        streams: streams.data?.streams,
        programs: programs.data?.programs,
        collections: nfts.data?.deployed ? nfts.data.claimable : [],
        campaigns: claims.data?.claimable,
      }),
    [rewards.data, streams.data, programs.data, nfts.data, claims.data]
  );
  const pending = new Map((rewards.data?.pending || []).map((p) => [p.streamId, p]));
  const collectionOf = new Map([...(nfts.data?.owned || []).map((o) => o.collection), ...(nfts.data?.created || [])].map((c) => [c.address, c]));
  const claimMany = rewards.data?.claimMany || [];
  const dueStreams = groups.holders.length + groups.traders.length + groups.nft.streams.length;
  const setFilter = (v) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete('type');
    else next.set('type', v);
    setParams(next, { replace: true });
  };
  const show = (k) => filter === 'all' || filter === k;
  const loading = rewards.isLoading || programs.isLoading;
  const error = rewards.error || programs.error;
  const streamRows = (list) => list.map((i) => <StreamRow key={i.streamId} item={i} pending={pending.get(i.streamId)} account={address} />);

  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Rewards</h2>
          <p className="pl-launch-section-desc">Staking you take part in, and holder, trader and NFT holder rewards you can claim. Daily rewards add up and never expire.</p>
        </div>
        <TxButton
          tx={allTx}
          disabled={!claimMany.length}
          busyLabel="Claiming on Base..."
          onClick={() => allTx.send(claimMany.map((c) => ({ label: `Claim all (${c.streams.length})`, to: c.to, data: c.data, value: 0n })))}
        >
          {dueStreams ? `Claim all (${dueStreams})` : 'Claim all'}
        </TxButton>
      </div>
      <TxResult tx={allTx} success="All daily rewards claimed" />

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
        <Skeleton height={160} count={2} />
      ) : (
        <>
          {filter === 'all' && groups.counts.all === 0 && (
            <Card className="pl-place-empty-card">
              <EmptyState
                icon={<Gift size={28} />}
                title="Nothing to claim yet"
                description="Stake in a vault, or hold and trade tokens with holder or trader rewards. After each UTC day your share shows up here, ready to claim."
                action={
                  <Button as={Link} to="/hub">
                    Find rewards
                    <ArrowUpRight size={15} />
                  </Button>
                }
              />
            </Card>
          )}
          {show('staking') && (filter === 'staking' || groups.staking.length > 0) && (
            <Group title="Staking" count={groups.staking.length} empty="You are not staking anywhere. Vaults you stake in stay here until you withdraw.">
              {groups.staking.map((p) => (
                <StakingRow key={p.id} p={p} account={address} now={now} />
              ))}
            </Group>
          )}
          {show('holders') && ((filter === 'holders' && !groups.campaigns.holders) || groups.holders.length > 0) && (
            <Group title="Holders" count={groups.holders.length} empty={groups.campaigns.holders ? 'No daily holder rewards to claim. One-off campaigns are below.' : 'Nothing to claim from holder rewards right now.'}>
              {streamRows(groups.holders)}
            </Group>
          )}
          {show('traders') && (filter === 'traders' || groups.traders.length > 0) && (
            <Group title="Traders" count={groups.traders.length} empty="Nothing to claim from trader rewards right now.">
              {streamRows(groups.traders)}
            </Group>
          )}
          {show('nft') && ((filter === 'nft' && !groups.campaigns.nft) || groups.nft.streams.length + groups.nft.pools.length > 0) && (
            <Group title="NFT holders" count={groups.nft.streams.length + groups.nft.pools.length} empty="Nothing to claim from NFT holder rewards right now. Collection pools pay daily at 00:00 UTC.">
              {streamRows(groups.nft.streams)}
              {groups.nft.pools.map((item) => (
                <NftClaimRow key={item.collection} c={collectionOf.get(item.collection)} item={item} />
              ))}
            </Group>
          )}
          {(filter === 'all' || filter === 'holders' || filter === 'nft') && <CampaignRewards only={filter === 'all' ? null : filter} quiet />}
        </>
      )}
    </div>
  );
}
