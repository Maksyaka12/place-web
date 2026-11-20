// One reward stream of the Rewards hub (/hub?stream=<id>) in the vault layout (VaultDetail.jsx): "Hold / Trade X ·
// Earn Y" with status, ID and source; the metrics (per day, pool, paid out, epochs, condition, eligible yesterday);
// the holding / trading token or collection and the reward currency; the schedule in UTC; the details with the
// daily rule; "My position" on the right (today's balance, volume or NFTs, whether that qualifies, Claim); the days
// with their tables. Manual calls (close a finished day, return the unshared budget to the funder) are folded under
// Advanced: Place closes days on its own after 00:00 UTC. Every call goes through usePlaceTx (Builder Code).
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink } from 'lucide-react';
import { Alert, Badge, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { formatUtc, countdown, ipfsUrl } from '../../place/format';
import { useHubStream, useRewards, useNftAccount } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { usd } from '../format.js';
import { collectionPath } from '../nft.js';
import { Advanced, ReadyNote } from './parts.jsx';
import { CopyId, amountText, conditionText, sym } from './vaults.jsx';
import { VaultLayout, VaultHead, Metrics, AssetCard, Schedule, Details, RuleNote, PositionStat } from './VaultDetail.jsx';

const TABLE_STATUS = {
  published: ['Published', 'success'],
  sent: ['Publishing', 'accent'],
  built: ['Publishing', 'accent'],
  empty: ['No one eligible, rolls over', 'neutral'],
  failed: ['Retrying', 'warn'],
};
const TARGET_LABEL = { holders: 'Holding token', traders: 'Trading token', nft: 'Collection' };
const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

/** Where the wallet stands today: [label, raw, token, eligible] (null when Place has no number for it). */
function useToday(s, account) {
  const isNft = s.type === 'nft';
  const rewards = useRewards(account && !isNft ? account : null, s.token.address);
  const nfts = useNftAccount(account && isNft ? account : null);
  if (!account) return null;
  const min = big(s.criterion);
  if (isNft) {
    const owned = (nfts.data?.owned || []).find((o) => o.collection?.address === s.token.address);
    if (!nfts.data) return null;
    const n = BigInt(owned?.ids?.length || 0);
    return { label: 'My NFTs', value: String(n), eligible: n >= (min > 0n ? min : 1n) };
  }
  const today = rewards.data?.today;
  if (!today) return null;
  if (s.type === 'traders') {
    const q = s.quote || s.token;
    const v = big(today.volume);
    return { label: 'My volume today', value: `${amountText(v, q.decimals)} ${sym(q)}`, eligible: v > 0n && v >= min };
  }
  const b = big(today.balance);
  return { label: 'My balance', value: `${amountText(b, s.token.decimals)} ${sym(s.token)}`, eligible: b > 0n && b >= min };
}

function MyPosition({ s, mine, account }) {
  const tx = usePlaceTx();
  const today = useToday(s, account);
  const r = s.rewardToken;
  if (!account) {
    return (
      <Card className="pl-vd-panel">
        <span className="pl-launch-section-title">My position</span>
        <p className="pl-launch-muted pl-launch-small">Connect wallet to see what you can claim.</p>
        <ConnectButton />
      </Card>
    );
  }
  const item = mine?.item;
  const claimable = big(item?.claimable);
  return (
    <Card className="pl-vd-panel">
      <span className="pl-launch-section-title">My position</span>
      {today && (
        <div className="pl-vd-pair">
          <div>
            <span className="pl-launch-muted pl-launch-small">{today.label}</span>
            <span className="mono pl-launch-strong">{today.value}</span>
          </div>
          <div>
            <span className="pl-launch-muted pl-launch-small">Today</span>
            <span>{s.status === 'live' ? <Badge tone={today.eligible ? 'success' : 'neutral'}>{today.eligible ? 'Eligible' : 'Not eligible'}</Badge> : <span className="pl-launch-muted">—</span>}</span>
          </div>
        </div>
      )}
      <div className="pl-vd-stats">
        <PositionStat label="Claimable" raw={item?.claimable ?? '0'} token={r} />
        <PositionStat label="Claimed" raw={item?.claimed ?? '0'} token={r} />
      </div>
      {mine?.pending && (
        <span className="pl-launch-muted pl-launch-small mono">
          +{amountText(mine.pending.amount, r.decimals)} {sym(r)} being published
        </span>
      )}
      <TxButton
        tx={tx}
        fullWidth
        size="lg"
        disabled={claimable === 0n}
        busyLabel="Claiming on Base..."
        onClick={() => tx.send({ label: 'Claim rewards', to: item.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claim', args: [item.streamId, account, BigInt(item.cumulative), item.proof] })}
      >
        {claimable === 0n ? 'Nothing to claim yet' : 'Claim'}
      </TxButton>
      <TxResult tx={tx} success="Rewards claimed" />
      {s.status === 'live' && <ReadyNote />}
    </Card>
  );
}

function Actions({ actions, s, account }) {
  const closeTx = usePlaceTx();
  const reclaimTx = usePlaceTx();
  const r = s.rewardToken;
  const reclaim = actions.reclaim?.ready ? actions.reclaim : null;
  if (!actions.close && !reclaim) return null;
  return (
    <Advanced note="Place closes every finished UTC day on its own within minutes of 00:00 UTC and publishes its table. Use these only if that does not happen; anyone can, and they pay nobody.">
      {actions.close && (
        <div className="pl-launch-your-reward">
          <span className="pl-launch-muted pl-launch-small">{actions.close.days === 1 ? 'Yesterday is over but not closed yet.' : `${actions.close.days} finished days are not closed yet.`}</span>
          {account ? (
            <TxButton tx={closeTx} size="sm" variant="secondary" busyLabel="Closing on Base..." onClick={() => closeTx.send({ label: 'Close the finished days', to: actions.close.tx.to, data: actions.close.tx.data, value: 0n })}>
              Close the day
            </TxButton>
          ) : (
            <ConnectButton size="sm" />
          )}
          <TxResult tx={closeTx} success="Days closed" />
        </div>
      )}
      {reclaim && (
        <div className="pl-launch-your-reward">
          <span className="pl-launch-muted pl-launch-small">
            {amountText(reclaim.amount, r.decimals)} {sym(r)} were never shared. Anyone can send them back to the funder.
          </span>
          {account ? (
            <TxButton tx={reclaimTx} size="sm" variant="secondary" busyLabel="Returning on Base..." onClick={() => reclaimTx.send({ label: 'Return the unallocated budget', to: reclaim.tx.to, data: reclaim.tx.data, value: 0n })}>
              Return to funder
            </TxButton>
          ) : (
            <ConnectButton size="sm" />
          )}
          <TxResult tx={reclaimTx} success="Returned to the funder" />
        </div>
      )}
    </Advanced>
  );
}

function Days({ s }) {
  const r = s.rewardToken;
  if (!s.epochs?.length) return null;
  return (
    <div className="pl-place-stack">
      <span className="pl-launch-section-title">Days</span>
      <Card className="pl-launch-reward-list">
        <div className="pl-launch-table pl-launch-days">
          <div className="pl-launch-table-head pl-rewards-days-grid">
            <span>Day (UTC)</span>
            <span className="num">Budget</span>
            <span className="num">Eligible</span>
            <span>Table</span>
          </div>
          {s.epochs.map((e) => {
            const [label, tone] = e.table ? TABLE_STATUS[e.table.status] || [e.table.status, 'neutral'] : ['Waiting', 'neutral'];
            return (
              <div key={e.epoch} className="pl-launch-table-row pl-rewards-days-grid">
                <span className="mono">{e.day}</span>
                <span className="num mono">{e.table?.budget && e.table.status !== 'empty' ? `${amountText(e.table.budget, r.decimals)} ${sym(r)}` : '—'}</span>
                <span className="num mono">{e.table?.eligible ?? '—'}</span>
                <span className="pl-launch-inline">
                  <Badge tone={tone}>{label}</Badge>
                  {e.table?.uri && (
                    <a className="pl-place-link pl-launch-inline" href={ipfsUrl(e.table.uri)} target="_blank" rel="noopener noreferrer" aria-label={`Table of ${e.day} on IPFS`}>
                      IPFS <ExternalLink size={12} />
                    </a>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

const SOURCE_FUNDER = { economy: 'Token tax', pool: 'Community Pool', creator: 'Creator', community: 'Funder' };

export default function HubStreamDetail({ id }) {
  const navigate = useNavigate();
  const now = useNow(10_000);
  const { address } = usePlaceAccount();
  const q = useHubStream(id, address);
  const back = (
    <button type="button" className="pl-place-back" onClick={() => navigate('/hub')}>
      <ArrowLeft size={14} /> All rewards
    </button>
  );
  if (q.isLoading) return <Skeleton height={260} />;
  if (q.error) {
    return (
      <div className="pl-place-stack">
        {back}
        <QueryError error={q.error} retry={q.refetch} />
      </div>
    );
  }
  const { stream: s, mine, actions } = q.data;
  const r = s.rewardToken;
  const t = s.token;
  const verb = s.type === 'traders' ? 'Trade' : 'Hold';
  const title = `${verb} ${sym(t)}${s.type === 'nft' ? ' NFT' : ''} · Earn ${sym(r)}`;
  const lastTable = (s.epochs || []).find((e) => e.table && e.table.eligible != null);
  const remaining = big(s.funded) - big(s.allocated);
  const totalUsd = s.poolUsd;
  const top = (
    <>
      <VaultHead a={t} b={r} title={title} status={s.status} id={s.id} idTitle="Copy stream ID" source={s.source} />
      {s.unsupported && (
        <Alert tone="warn" icon={<AlertTriangle size={16} />}>
          {s.unsupported}. Place does not build daily tables for this stream, so nobody can claim from it.
        </Alert>
      )}
      <Metrics
        items={[
          { label: s.economy ? 'Last day' : 'Per day', value: s.perDayUsd == null ? `${amountText(s.perDay, r.decimals)} ${sym(r)}` : usd(s.perDayUsd), sub: s.perDayUsd == null ? null : `${amountText(s.perDay, r.decimals)} ${sym(r)}` },
          { label: s.economy ? 'Funded so far' : 'Pool', value: s.poolUsd == null ? `${amountText(s.pool, r.decimals)} ${sym(r)}` : usd(s.poolUsd), sub: s.poolUsd == null ? null : `${amountText(s.pool, r.decimals)} ${sym(r)}` },
          { label: 'Paid out', value: `${amountText(s.allocated, r.decimals)} ${sym(r)}`, sub: `Claimed ${amountText(s.claimed, r.decimals)}` },
          { label: 'Epoch rounds', value: s.epochCount ? `${s.daysDone} / ${s.epochCount}` : `${s.daysDone}`, sub: s.epochCount ? null : 'Every day, no end' },
          { label: 'Epoch length', value: '1 day' },
          { label: 'Condition', value: conditionText(s), tip: conditionText(s, true), small: true },
          lastTable && { label: 'Eligible yesterday', value: String(lastTable.table.eligible), sub: lastTable.day },
        ]}
      />
    </>
  );
  const main = (
    <>
      <div className="pl-vd-cards">
        <AssetCard label={TARGET_LABEL[s.type]} token={t} placeToken={s.placeToken} href={s.type === 'nft' && s.placeCollection ? collectionPath(t.address) : undefined} totalLabel="Condition" total={conditionText(s)} />
        <AssetCard label="Reward currency" token={r} totalLabel={s.economy ? 'Funded so far' : 'Total rewards'} total={`${amountText(s.pool, r.decimals)} ${sym(r)}`} totalUsd={totalUsd} />
      </div>
      <div className="pl-place-stack">
        <span className="pl-launch-section-title">Schedule</span>
        <Schedule
          now={now}
          points={[
            { label: 'Starts', at: s.startsAt },
            { label: 'Ends', at: s.endsAt },
          ]}
        />
      </div>
      <div className="pl-place-stack">
        <span className="pl-launch-section-title">Details</span>
        <Details
          items={[
            { label: 'Stream ID', value: <CopyId id={s.id} title="Copy stream ID" /> },
            { label: 'Reward remaining', value: <span className="mono">{`${amountText(remaining > 0n ? remaining : 0n, r.decimals)} ${sym(r)}`}</span> },
            { label: SOURCE_FUNDER[s.source] || 'Funder', value: s.economy || !s.funder ? <span>{s.economy ? 'Part of every trade' : '—'}</span> : <AddressLink address={s.funder} /> },
            { label: 'Contract', value: <AddressLink address={s.distributor} /> },
            s.status !== 'ended' && { label: s.status === 'upcoming' ? 'Starts in' : 'Next snapshot in', value: <span className="mono">{countdown(s.status === 'upcoming' ? s.startsAt : s.nextCloseAt, now)}</span> },
            actions.reclaim && !actions.reclaim.ready && { label: 'Unshared budget returns', value: <span className="mono">{formatUtc(actions.reclaim.at)}</span> },
          ]}
        />
        <RuleNote>Snapshot at 00:00 UTC daily, split by {s.type === 'traders' ? 'volume' : s.type === 'nft' ? 'NFTs held' : 'balance'}; rewards add up and never expire.</RuleNote>
      </div>
      <Days s={s} />
      <Actions actions={actions} s={s} account={address} />
    </>
  );
  return (
    <div className="pl-place-stack pl-rewards">
      {back}
      <VaultLayout top={top} main={main} side={<MyPosition s={s} mine={mine} account={address} />} />
    </div>
  );
}
