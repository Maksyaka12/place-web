// Profile → Rewards: every daily holder and trader reward of this wallet over all 0.3.0 tokens (launch/rewards),
// claimed one by one or all at once (one claimMany transaction per rewards contract).
import { Link } from 'react-router-dom';
import { Gift, BarChart3, ArrowUpRight } from 'lucide-react';
import { Card, EmptyState, Tile, Button } from '../../themes/place/components/ui';
import { TxButton, TxResult, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { formatAmount } from '../../place/format';
import { useRewards } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { STREAM_LABEL } from '../economy.js';
import { TokenLogo, launchTokenPath } from './parts.jsx';

const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

function RewardRow({ item, pending, account }) {
  const tx = usePlaceTx();
  const t = item.token;
  const r = item.rewardToken;
  const claimable = BigInt(item.claimable || 0);
  const Icon = item.kind === 'traders' ? BarChart3 : Gift;
  const send = () =>
    tx.send({
      label: `Claim ${t.symbol || 'token'} ${item.kind} rewards`,
      to: item.distributor,
      abi: REWARDS_DISTRIBUTOR_ABI,
      functionName: 'claim',
      args: [item.streamId, account, BigInt(item.cumulative), item.proof],
    });
  return (
    <div className="pl-launch-reward-row">
      <Link to={`${launchTokenPath(t.address)}?tab=rewards`} className="pl-launch-reward-token">
        <TokenLogo token={t} size={36} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{t.name || t.symbol}</span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline">
            <Icon size={12} /> {STREAM_LABEL[item.kind] || item.kind}
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
      <TxButton tx={tx} size="sm" variant="secondary" disabled={claimable === 0n} busyLabel="Claiming on Base..." onClick={send}>
        {claimable === 0n ? 'Claimed' : 'Claim'}
      </TxButton>
      {tx.status !== 'idle' && (
        <div className="pl-launch-reward-result">
          <TxResult tx={tx} success="Claimed" />
        </div>
      )}
    </div>
  );
}

export function ProfileRewards({ address }) {
  const { data, isLoading, error, refetch } = useRewards(address);
  const allTx = usePlaceTx();
  const items = data?.rewards || [];
  const pending = new Map((data?.pending || []).map((p) => [p.streamId, p]));
  const due = items.filter((i) => i.claimable !== '0');
  // One label per reward token for the totals: the symbol and decimals of any item paying it.
  const tokens = new Map(items.map((i) => [i.rewardToken.address, i.rewardToken]));
  const totals = Object.entries(data?.totals || {});
  const sorted = [...items].sort((a, b) => (BigInt(b.claimable) > BigInt(a.claimable) ? 1 : BigInt(b.claimable) < BigInt(a.claimable) ? -1 : 0));
  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Rewards</h2>
          <p className="pl-launch-section-desc">Daily holder and trader rewards from every token you hold or trade. They add up and never expire.</p>
        </div>
        <TxButton
          tx={allTx}
          disabled={!data?.claimMany?.length}
          busyLabel="Claiming on Base..."
          onClick={() => allTx.send(data.claimMany.map((c) => ({ label: `Claim all (${c.streams.length})`, to: c.to, data: c.data, value: 0n })))}
        >
          {due.length ? `Claim all (${due.length})` : 'Claim all'}
        </TxButton>
      </div>
      <TxResult tx={allTx} success="All rewards claimed" />
      {error ? (
        <QueryError error={error} retry={refetch} />
      ) : isLoading ? (
        <Skeleton height={160} />
      ) : items.length ? (
        <>
          {totals.length > 0 && (
            <div className="pl-launch-tab-tiles">
              {totals.map(([addr, raw]) => {
                const r = tokens.get(addr);
                return <Tile key={addr} label="Ready to claim" value={formatAmount(raw, r?.decimals ?? 18, { maxDecimals: 6 })} sub={r?.symbol || ''} />;
              })}
            </div>
          )}
          <Card className="pl-launch-reward-list">
            {sorted.map((i) => (
              <RewardRow key={i.streamId} item={i} pending={pending.get(i.streamId)} account={address} />
            ))}
          </Card>
        </>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Gift size={28} />}
            title="No rewards yet"
            description="Hold or trade Economy tokens with holder or trader rewards. After each UTC day your share shows up here, ready to claim."
            action={
              <Button as={Link} to="/">
                Find tokens
                <ArrowUpRight size={15} />
              </Button>
            }
          />
        </Card>
      )}
    </div>
  );
}
