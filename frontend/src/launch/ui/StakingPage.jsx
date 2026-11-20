// A staking vault (/staking?program=<id>): one PlaceStaking program in the vault layout (VaultDetail.jsx). The head,
// the metrics (Live APR, TVL, staked, rewards, epochs, early withdraw), the staking token and reward currency, the
// schedule, the details with the lot rule, and on the right "My deposit": the position, the lots and Stake /
// Withdraw / Claim. Anyone stakes the program's token for a share of a fixed reward per epoch; rewards of an epoch
// are claimable once it ends. The list of vaults is the Staking tab of the Rewards hub (/hub?type=staking).
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, ArrowLeft } from 'lucide-react';
import { maxUint256 } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { formatAmount, formatUtc, parseAmount } from '../../place/format';
import { PLACE_STAKING_ABI } from '../abi.js';
import { ERC20_ABI } from '../swap.js';
import { useStakingPrograms, useStakingPosition, useLaunchToken, launchKeys } from '../hooks.js';
import { withdrawable } from '../profileRewards.js';
import { usd } from '../format.js';
import { num, aprText, vaultStats, amountText, sym, CopyId } from './vaults.jsx';
import { VaultLayout, VaultHead, Metrics, AssetCard, Schedule, Details, RuleNote, PositionStat } from './VaultDetail.jsx';

const TABS = ['Stake', 'Withdraw', 'Claim'];
const days = (s) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} hours` : `${Math.round(s / 60)} minutes`);

function useTokenBalance(token, account) {
  return useQuery({
    queryKey: [...launchKeys.all, 'stake-balance', token, account],
    enabled: Boolean(token && account && token !== 'eth'),
    queryFn: async () => ({ balance: await placeClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }) }),
  });
}

function useAllowance(token, account, spender) {
  return useQuery({
    queryKey: [...launchKeys.all, 'stake-allowance', token, account, spender],
    enabled: Boolean(token && account && spender && token !== 'eth'),
    queryFn: () => placeClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, spender] }),
  });
}

/** Pool (Community Pool), Creator (the token's creator from a wallet) or Community. */
function useSource(p) {
  const t = useLaunchToken(!p.fromLaunchVault && p.launchedOnPlace ? p.stakingToken.address : null);
  if (p.fromLaunchVault) return 'pool';
  const tok = t.data?.token;
  return tok && [tok.creator, tok.originalCreator].includes(p.creator) ? 'creator' : 'community';
}

function StakeForm({ p, address, now }) {
  const bal = useTokenBalance(p.stakingToken.address, address);
  const allowance = useAllowance(p.stakingToken.address, address, p.staking);
  const [text, setText] = useState('');
  const tx = usePlaceTx({ onSuccess: () => setText('') });
  const s = p.stakingToken;
  const amountIn = parseAmount(text, s.decimals);
  const tooMuch = amountIn && bal.data && amountIn > bal.data.balance;
  const canDeposit = p.status !== 'ended' && now >= new Date(p.depositsOpenAt).getTime();
  const value = amountIn && s.usd != null ? num(amountIn, s.decimals, 8) * s.usd : null;
  const stake = () => {
    const calls = [];
    if ((allowance.data ?? 0n) < amountIn) calls.push({ label: `Allow staking to use ${s.symbol}`, to: s.address, abi: ERC20_ABI, functionName: 'approve', args: [p.staking, maxUint256] });
    calls.push({ label: `Stake ${s.symbol}`, to: p.staking, abi: PLACE_STAKING_ABI, functionName: 'deposit', args: [p.id, amountIn] });
    return tx.send(calls);
  };
  return (
    <>
      <div className="pl-vd-amount">
        <div className="pl-vd-amount-top">
          <span className="pl-launch-muted pl-launch-small">Amount to stake</span>
          <span className="pl-launch-muted pl-launch-small mono">Balance {bal.data ? `${amountText(bal.data.balance, s.decimals)} ${sym(s)}` : '—'}</span>
        </div>
        <div className="pl-vd-amount-row">
          <input value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.0" inputMode="decimal" className="mono" aria-label="Amount to stake" />
          {bal.data?.balance > 0n && (
            <button type="button" className="pl-place-link-btn" onClick={() => setText(formatAmount(bal.data.balance, s.decimals, { maxDecimals: 18 }).replace(/,/g, ''))}>
              MAX
            </button>
          )}
          <span className="pl-launch-strong">{sym(s)}</span>
        </div>
        <span className={`pl-launch-small ${tooMuch ? 'pl-place-hint error' : 'pl-launch-muted'}`}>{tooMuch ? 'More than your balance' : `Estimated value ${value == null ? '—' : usd(value)}`}</span>
      </div>
      <div className="pl-vd-pair">
        <div>
          <span className="pl-launch-muted pl-launch-small">Earn</span>
          <span className="pl-launch-strong">{sym(p.rewardToken)}</span>
        </div>
        <div>
          <span className="pl-launch-muted pl-launch-small">Lock</span>
          <span className="pl-launch-strong">1 epoch · {days(p.epochDuration)}</span>
        </div>
      </div>
      <TxButton tx={tx} onClick={stake} fullWidth size="lg" disabled={!amountIn || tooMuch || !canDeposit} busyLabel="Staking on Base...">
        {!canDeposit ? (p.status === 'ended' ? 'Vault ended' : `Opens ${formatUtc(p.depositsOpenAt)}`) : 'Stake'}
      </TxButton>
      <TxResult tx={tx} success="Staked" />
    </>
  );
}

function WithdrawForm({ p, pos, address, now }) {
  const tx = usePlaceTx();
  const s = p.stakingToken;
  const out = withdrawable(pos.lots, now);
  const send = () => tx.send(out.ready.map((l) => ({ label: `Withdraw ${s.symbol}`, to: p.staking, abi: PLACE_STAKING_ABI, functionName: 'withdraw', args: [p.id, BigInt(l.lotId), BigInt(l.amount), address] })));
  return (
    <>
      <div className="pl-vd-pair">
        <div>
          <span className="pl-launch-muted pl-launch-small">Unlocked</span>
          <span className="mono pl-launch-strong">
            {amountText(out.total, s.decimals)} {sym(s)}
          </span>
        </div>
        <div>
          <span className="pl-launch-muted pl-launch-small">Next unlock</span>
          <span className="mono pl-launch-strong">{out.nextUnlock ? formatUtc(out.nextUnlock) : '—'}</span>
        </div>
      </div>
      <TxButton tx={tx} onClick={send} fullWidth size="lg" variant="secondary" disabled={!out.ready.length} busyLabel="Withdrawing on Base...">
        {out.ready.length ? `Withdraw ${amountText(out.total, s.decimals)} ${sym(s)}` : 'Nothing unlocked yet'}
      </TxButton>
      <TxResult tx={tx} success="Withdrawn" />
    </>
  );
}

function ClaimForm({ p, pos }) {
  const tx = usePlaceTx();
  const r = p.rewardToken;
  const c = pos.claimable;
  return (
    <>
      <div className="pl-vd-pair">
        <div>
          <span className="pl-launch-muted pl-launch-small">Claimable</span>
          <span className="mono pl-launch-strong">
            {amountText(c.total, r.decimals)} {sym(r)}
          </span>
        </div>
        <div>
          <span className="pl-launch-muted pl-launch-small">Epochs</span>
          <span className="mono pl-launch-strong">{c.epochs.length}</span>
        </div>
      </div>
      <TxButton tx={tx} fullWidth size="lg" disabled={!pos.tx.claim} busyLabel="Claiming on Base..." onClick={() => tx.send({ label: 'Claim staking rewards', to: pos.tx.claim.to, data: pos.tx.claim.data })}>
        {pos.tx.claim ? 'Claim' : 'Nothing to claim yet'}
      </TxButton>
      <TxResult tx={tx} success="Claimed" />
    </>
  );
}

function MyDeposit({ p, now }) {
  const { address } = usePlaceAccount();
  const pos = useStakingPosition(p.id, address);
  const [tab, setTab] = useState('Stake');
  const [page, setPage] = useState(0);
  const s = p.stakingToken;
  const r = p.rewardToken;
  if (!address) {
    return (
      <Card className="pl-vd-panel">
        <span className="pl-launch-section-title">My deposit</span>
        <p className="pl-launch-muted pl-launch-small">Connect wallet to stake and see your position.</p>
        <ConnectButton fullWidth>Connect wallet to stake</ConnectButton>
      </Card>
    );
  }
  const d = pos.data;
  const lots = d?.lots || [];
  const PER = 3;
  const shown = lots.slice(page * PER, page * PER + PER);
  return (
    <Card className="pl-vd-panel">
      <span className="pl-launch-section-title">My deposit</span>
      {pos.error ? (
        <QueryError error={pos.error} retry={pos.refetch} />
      ) : pos.isLoading ? (
        <Skeleton height={120} />
      ) : (
        <>
          <div className="pl-vd-stats">
            <PositionStat label="Total staked" raw={d.staked} token={s} />
            <PositionStat label="Claimable" raw={d.claimable.total} token={r} />
            <PositionStat label="Claimed" raw={p.position?.claimed ?? '0'} token={r} />
            <PositionStat label="Unlocked" raw={withdrawable(lots, now).total} token={s} />
          </div>
          <div className="pl-vd-lots">
            <span className="pl-launch-muted pl-launch-small mono">{lots.length ? `${page * PER + 1}-${page * PER + shown.length} / ${lots.length} lots` : '0 lots'}</span>
            {shown.length ? (
              shown.map((l) => (
                <div key={l.lotId} className="pl-vd-lot">
                  <span className="mono">
                    {amountText(l.amount, s.decimals)} {sym(s)}
                  </span>
                  <span className="pl-launch-muted pl-launch-small pl-launch-inline">
                    {l.unlocked ? (
                      <Badge tone="success">Unlocked</Badge>
                    ) : (
                      <>
                        <Lock size={12} /> {formatUtc(l.unlockAt)}
                      </>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <p className="pl-launch-muted pl-launch-small">No active lots.</p>
            )}
            {lots.length > PER && (
              <div className="pl-vd-lot-pages">
                <button type="button" className="pl-place-link-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <button type="button" className="pl-place-link-btn" disabled={(page + 1) * PER >= lots.length} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </div>
            )}
          </div>
          <div className="seg pl-vd-tabs" role="tablist" aria-label="Action">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          {tab === 'Stake' ? <StakeForm p={p} address={address} now={now} /> : tab === 'Withdraw' ? <WithdrawForm p={p} pos={d} address={address} now={now} /> : <ClaimForm p={p} pos={d} />}
        </>
      )}
    </Card>
  );
}

function ProgramDetail({ p, now }) {
  const source = useSource(p);
  const s = p.stakingToken;
  const r = p.rewardToken;
  const v = vaultStats(p);
  const totalReward = num(p.totalReward, r.decimals, 8);
  const perEpoch = num(p.rewardPerEpoch, r.decimals, 8);
  const remaining = BigInt(p.totalReward || 0) - BigInt(p.claimed || 0);
  const rUsd = (n) => (r.usd == null ? null : n * r.usd);
  const top = (
    <>
      <VaultHead a={s} b={r} title={`Stake ${sym(s)} · Earn ${sym(r)}`} status={p.status} id={p.id} idTitle="Copy vault ID" source={source} />
      <Metrics
        items={[
          { label: 'Live APR', value: aprText(v.apr), tip: 'Rewards of one year at the current reward per epoch, divided by the value staked now. It changes as people stake and withdraw.' },
          { label: 'TVL', value: v.tvlUsd == null ? `${amountText(p.totalStaked, s.decimals)} ${sym(s)}` : usd(v.tvlUsd), sub: v.tvlUsd == null ? null : `${amountText(p.totalStaked, s.decimals)} ${sym(s)}` },
          { label: 'Total staked', value: `${amountText(p.totalStaked, s.decimals)} ${sym(s)}`, sub: `${p.stakers} staker${p.stakers === 1 ? '' : 's'}` },
          { label: 'Total rewards', value: rUsd(totalReward) == null ? `${amountText(p.totalReward, r.decimals)} ${sym(r)}` : usd(rUsd(totalReward)), sub: rUsd(totalReward) == null ? null : `${amountText(p.totalReward, r.decimals)} ${sym(r)}` },
          { label: 'Total rewards / epoch', value: rUsd(perEpoch) == null ? `${amountText(p.rewardPerEpoch, r.decimals)} ${sym(r)}` : usd(rUsd(perEpoch)), sub: rUsd(perEpoch) == null ? null : `${amountText(p.rewardPerEpoch, r.decimals)} ${sym(r)}` },
          { label: 'Epoch rounds', value: `${v.done} / ${p.epochCount}` },
          { label: 'Epoch length', value: days(p.epochDuration) },
          { label: 'Early withdraw', value: p.earlyExit ? <Badge tone="warn">Allowed · {p.penaltyBps / 100}% penalty</Badge> : <Badge tone="danger">Forbidden</Badge> },
        ]}
      />
    </>
  );
  const main = (
    <>
      <div className="pl-vd-cards">
        <AssetCard label="Staking token" token={s} placeToken={p.launchedOnPlace} totalLabel="Total staked" total={`${amountText(p.totalStaked, s.decimals)} ${sym(s)}`} totalUsd={v.tvlUsd} />
        <AssetCard label="Reward currency" token={r} totalLabel="Total rewards" total={`${amountText(p.totalReward, r.decimals)} ${sym(r)}`} totalUsd={rUsd(totalReward)} />
      </div>
      <div className="pl-place-stack">
        <span className="pl-launch-section-title">Schedule</span>
        <Schedule
          now={now}
          points={[
            { label: 'Deposits open', at: p.depositsOpenAt },
            { label: 'Starts', at: p.startTime },
            { label: 'Ends', at: p.endsAt },
          ]}
        />
      </div>
      <div className="pl-place-stack">
        <span className="pl-launch-section-title">Vault details</span>
        <Details
          items={[
            { label: 'Vault ID', value: <CopyId id={p.id} title="Copy vault ID" /> },
            { label: 'Reward remaining', value: <span className="mono">{`${amountText(remaining > 0n ? remaining : 0n, r.decimals)} ${sym(r)}`}</span> },
            { label: p.fromLaunchVault ? 'Funded by (Community Pool)' : 'Creator', value: <AddressLink address={p.creator} /> },
            { label: 'Staking contract', value: <AddressLink address={p.staking} /> },
            { label: 'Place fee', value: <span className="mono">{p.feeBps / 100}%</span> },
          ]}
        />
        <RuleNote>
          Every deposit creates a separate lot, locked for one epoch.{' '}
          {p.earlyExit ? `Leaving early costs a ${p.penaltyBps / 100}% penalty.` : 'No early withdrawal.'} Rewards of an epoch can be claimed once it ends.
        </RuleNote>
      </div>
    </>
  );
  return <VaultLayout top={top} main={main} side={<MyDeposit p={p} now={now} />} />;
}

export default function StakingPage() {
  const now = useNow(10_000);
  const navigate = useNavigate();
  const { address } = usePlaceAccount();
  const [params] = useSearchParams();
  const id = params.get('program');
  const q = useStakingPrograms(address ? { account: address } : {}, { enabled: Boolean(id) });
  if (!id) return <Navigate to="/hub?type=staking" replace />;
  const open = (q.data?.programs || []).find((p) => p.id === id);
  const back = (
    <button type="button" className="pl-place-back" onClick={() => navigate('/hub?type=staking')}>
      <ArrowLeft size={14} /> Back to vaults
    </button>
  );
  if (q.isLoading) return <Skeleton height={240} />;
  if (q.error) return <QueryError error={q.error} retry={q.refetch} />;
  if (!open) {
    return (
      <div className="pl-place-stack pl-staking">
        {back}
        <Card>
          <p className="pl-launch-muted">This vault is not indexed yet, or the ID is wrong.</p>
        </Card>
      </div>
    );
  }
  return (
    <div className="pl-place-stack pl-staking pl-rewards">
      {back}
      <ProgramDetail p={open} now={now} />
    </div>
  );
}
