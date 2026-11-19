// Token page tabs about rewards: Holder rewards and Trader rewards (the daily streams of an Economy token: what this
// wallet can claim, the rule, whether it qualifies today and when the next payout lands), Staking (the token's
// staking vaults), NFT (collections paired with the token) and Campaigns (rewards beyond the token's own economy:
// Community Pool and wallet-funded streams, snapshot campaigns). Staking, NFT and Campaigns use the hub's cards.
import { Link } from 'react-router-dom';
import { Gift, BarChart3, Coins, ArrowUpRight, CheckCircle2, AlertCircle, Clock, Image as ImageIcon, Megaphone } from 'lucide-react';
import { Button, EmptyState, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, Skeleton, QueryError } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useCampaigns } from '../../place/hooks';
import { formatAmount } from '../../place/format';
import { useRewards, useHubStreams } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { STREAM_LABEL, tradePct } from '../economy.js';
import { compact, amount } from '../format.js';
import { units } from './TokenEconomy.jsx';
import { HubCard, hubItems } from './HubPage.jsx';
import { PHASE_ORDER, amountText } from './vaults.jsx';
import { CollectionCard } from './CollectionParts.jsx';

/** "1,234.5 USDC" for a raw amount of a reward token ({ symbol, decimals }). */
export const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

/** "05:12": hours and minutes until the next 00:00 UTC. */
export function untilMidnight(now) {
  const day = 86_400_000;
  const left = Math.max(0, day - (now % day));
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A single-stream claim: the newest published cumulative amount and its proof. */
function claimCall(item, account) {
  return {
    label: `Claim ${STREAM_LABEL[item.kind]?.toLowerCase() || 'rewards'}`,
    to: item.distributor,
    abi: REWARDS_DISTRIBUTOR_ABI,
    functionName: 'claim',
    args: [item.streamId, account, BigInt(item.cumulative), item.proof],
  };
}

/** Whether the wallet meets the stream's rule right now, with the line that says so. */
function eligibility(kind, stream, today, t) {
  const need = BigInt(stream.criterion || 0);
  if (kind === 'holders') {
    const have = BigInt(today?.balance || 0);
    if (have >= need && have > 0n) return { ok: true, text: 'You qualify: your balance meets the minimum holding.' };
    const more = need - have;
    return { ok: false, text: have > 0n ? `Hold ${compact(units(more, 18, 2))} ${t.symbol} more at 00:00 UTC to qualify.` : `Hold at least ${compact(units(need, 18, 0))} ${t.symbol} at 00:00 UTC to qualify.` };
  }
  const have = BigInt(today?.volume || 0);
  const q = t.quote;
  if (need === 0n) return have > 0n ? { ok: true, text: 'You qualify: you traded today.' } : { ok: false, text: 'Buy or sell any amount today to qualify.' };
  if (have >= need) return { ok: true, text: 'You qualify: your volume today meets the minimum.' };
  return { ok: false, text: `Trade ${amount(units(need - have, q.decimals), q.symbol)} more today to qualify.` };
}

/** Holder rewards or Trader rewards of an Economy token: four figures, the status line, the countdown and Claim. */
export function RewardsTab({ data, econ, kind, now }) {
  const t = data.token;
  const q = t.quote;
  const { address } = usePlaceAccount();
  const mine = useRewards(address, t.address);
  const tx = usePlaceTx();
  const stream = (data.rewards || []).find((s) => s.economy && s.kind === kind);
  const holders = kind === 'holders';
  const Icon = holders ? Gift : BarChart3;
  const share = econ ? [econ.perTrade.buy[kind], econ.perTrade.sell[kind]] : [0, 0];
  const desc = holders
    ? `${tradePct(share[0])} of each buy and ${tradePct(share[1])} of each sell is shared every UTC day between holders, by balance.`
    : `${tradePct(share[0])} of each buy and ${tradePct(share[1])} of each sell is shared every UTC day between traders, by volume.`;
  if (!stream) {
    return <EmptyState icon={<Icon size={26} />} title="Rewards start with the first day" description={`${desc} The first payout opens after the first UTC day of trading closes.`} />;
  }
  const r = stream.rewardToken;
  const item = (mine.data?.rewards || []).find((x) => x.streamId === stream.id);
  const pending = (mine.data?.pending || []).find((p) => p.streamId === stream.id);
  const today = mine.data?.today;
  const claimable = BigInt(item?.claimable || 0);
  const earned = BigInt(item?.cumulative || 0) + BigInt(pending?.amount || 0);
  const requirement = holders
    ? { label: 'Minimum holding', value: `${compact(units(stream.criterion, 18, 0))} ${t.symbol}`, mine: today ? `You hold ${compact(units(today.balance, 18, 2))} ${t.symbol}` : null }
    : {
        label: 'Minimum daily volume',
        value: BigInt(stream.criterion || 0) > 0n ? amount(units(stream.criterion, q.decimals), q.symbol) : 'Any trade',
        mine: today ? `Your volume today ${amount(units(today.volume, q.decimals), q.symbol)}` : null,
      };
  const status = address && today ? eligibility(kind, stream, today, t) : null;
  const dash = address ? (mine.isLoading ? '…' : null) : '—';
  const short = (raw) => `${amountText(raw || 0, r.decimals)} ${r.symbol || ''}`.trim();
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">{desc}</p>
      <div className="pl-launch-tab-tiles">
        <Tile label="Claimable" value={dash ?? short(String(claimable))} sub={pending ? `+${short(pending.amount)} being published` : r.symbol} />
        <Tile label={requirement.label} value={requirement.value} sub={address ? requirement.mine || '…' : 'Connect wallet to check'} />
        <Tile label="Total earned" value={dash ?? short(String(earned))} sub="all days so far" />
        <Tile label="Claimed" value={dash ?? short(item?.claimed)} sub={`${short(stream.claimed)} by everyone`} />
      </div>
      <div className="pl-launch-reward-bar">
        <span className={`pl-launch-reward-status ${status ? (status.ok ? 'ok' : 'no') : ''}`.trim()}>
          {status ? status.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} /> : <Icon size={16} />}
          {status ? status.text : address ? 'Checking your wallet…' : 'Connect wallet to see whether you qualify.'}
        </span>
        <span className="pl-launch-reward-next">
          <Clock size={14} />
          Next payout in <span className="mono pl-launch-strong">{untilMidnight(now)}</span>
          <span className="pl-launch-muted pl-launch-small">at 00:00 UTC</span>
        </span>
        {address ? (
          <TxButton tx={tx} disabled={claimable === 0n} busyLabel="Claiming on Base..." onClick={() => tx.send(claimCall(item, address))}>
            {claimable === 0n ? 'Nothing to claim yet' : `Claim ${rewardText(String(claimable), r)}`}
          </TxButton>
        ) : (
          <ConnectButton />
        )}
      </div>
      <TxResult tx={tx} success="Rewards claimed" />
      <Link to={`/hub?stream=${stream.id}`} className="pl-place-link pl-launch-small pl-launch-reward-history">
        Daily history in the Rewards hub <ArrowUpRight size={13} />
      </Link>
    </div>
  );
}

// ─────────────────────────────── Staking / NFT / Campaigns ───────────────────────────────

/** Who counts as official for this token: its fee vault, Community Pool and creators. */
const officialSet = (data) => new Set([data.token.vault, data.communityVault, data.token.creator, data.token.originalCreator].filter(Boolean));

/** Staking vaults of this token that have not ended: the number on the Staking tab. */
export const activeStaking = (data) => (data.staking || []).filter((p) => p.status !== 'ended').length;

const byPhase = (a, b) => (PHASE_ORDER[a.status] ?? 9) - (PHASE_ORDER[b.status] ?? 9);

function CardGrid({ items }) {
  return (
    <div className="pl-vaults-grid pl-launch-staking-grid">
      {items.map((it) => (
        <HubCard key={it.key} it={it} />
      ))}
    </div>
  );
}

function HubLinks({ create, createLabel, hub }) {
  return (
    <div className="pl-launch-tab-actions">
      <Button as={Link} to={create}>
        {createLabel}
      </Button>
      <Button as={Link} to={hub} variant="ghost">
        Open in Rewards hub
        <ArrowUpRight size={15} />
      </Button>
    </div>
  );
}

export function StakingTab({ data }) {
  const t = data.token;
  const staking = data.staking || [];
  const vaults = officialSet(data);
  // A vault funded by the token's creator is marked as theirs.
  const items = hubItems([], staking)
    .map((it, i) => (it.source === 'community' && vaults.has(staking[i].creator) ? { ...it, source: 'creator' } : it))
    .sort(byPhase);
  return (
    <div className="pl-launch-tab-body">
      {items.length ? (
        <CardGrid items={items} />
      ) : (
        <EmptyState icon={<Coins size={28} />} title="No staking vaults yet" description={`Anyone can fund a staking vault for ${t.symbol}: stakers share a fixed reward every epoch.`} />
      )}
      <HubLinks create={`/create?type=staking&token=${t.address}`} createLabel="Create staking vault" hub={`/hub?type=staking&token=${t.address}`} />
    </div>
  );
}

export function NftTab({ token, collections }) {
  return (
    <div className="pl-launch-tab-body">
      <div className="pl-launch-nft-grid">
        {collections.map((c) => (
          <CollectionCard key={c.address} c={c} />
        ))}
      </div>
      <div className="pl-launch-tab-actions">
        <Button as={Link} to="/launch/nft">
          <ImageIcon size={15} />
          Launch NFT
        </Button>
        <Button as={Link} to={`/token/${token.address}`} variant="ghost">
          Open project page
          <ArrowUpRight size={15} />
        </Button>
      </div>
    </div>
  );
}

/** Rewards for this token beyond its own economy streams: Community Pool or wallet-funded streams and snapshot campaigns. */
export function CampaignsTab({ data }) {
  const t = data.token;
  const { address } = usePlaceAccount();
  // Every stream (the hub's own query): those on this token, plus those its Community Pool funded for other targets
  // (an NFT holders campaign for a paired collection).
  const streams = useHubStreams(address ? { account: address } : {});
  const snapshots = useCampaigns({ status: 'all', target: t.address, limit: 50 });
  if (streams.isLoading || snapshots.isLoading) return <Skeleton height={220} />;
  if (streams.error) return <QueryError error={streams.error} retry={streams.refetch} />;
  const pool = data.communityVault;
  const extra = (streams.data?.streams || []).filter((s) => s.source !== 'economy' && (s.token?.address === t.address || (pool && s.funder === pool)));
  const items = hubItems(extra, [], snapshots.data?.campaigns || []).sort(byPhase);
  return (
    <div className="pl-launch-tab-body">
      {items.length ? (
        <CardGrid items={items} />
      ) : (
        <EmptyState
          icon={<Megaphone size={28} />}
          title="No campaigns yet"
          description={`Holder, trader and NFT holder campaigns for ${t.symbol} from its Community Pool or any wallet show up here.`}
        />
      )}
      <HubLinks create={`/create?token=${t.address}`} createLabel="Create campaign" hub={`/hub?token=${t.address}`} />
    </div>
  );
}
