// A staking vault (/staking?program=<id>): one PlaceStaking program with stake, position, claim and withdraw. Anyone
// stakes the program's token for a share of a fixed reward per epoch; rewards of an epoch are claimable once it ends.
// The list of vaults is the Staking tab of the Rewards hub (/hub?type=staking); /staking without a program opens it.
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Clock, ArrowLeft } from 'lucide-react';
import { maxUint256 } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { Card, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { formatAmount, formatUtc, parseAmount } from '../../place/format';
import { PLACE_STAKING_ABI } from '../abi.js';
import { ERC20_ABI } from '../swap.js';
import { useStakingPrograms, useStakingPosition, launchKeys } from '../hooks.js';
import { launchTokenPath } from './parts.jsx';
import { compact } from '../format.js';
import { num, duration, PairLogos, PhaseBadge, CopyId } from './vaults.jsx';


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

function ProgramDetail({ p, now }) {
  const { address } = usePlaceAccount();
  const pos = useStakingPosition(p.id, address);
  const bal = useTokenBalance(p.stakingToken.address, address);
  const allowance = useAllowance(p.stakingToken.address, address, p.staking);
  const [text, setText] = useState('');
  const stakeTx = usePlaceTx({ onSuccess: () => setText('') });
  const claimTx = usePlaceTx();
  const withdrawTx = usePlaceTx();
  const amountIn = parseAmount(text, p.stakingToken.decimals);
  const tooMuch = amountIn && bal.data && amountIn > bal.data.balance;
  const openAt = new Date(p.depositsOpenAt).getTime() / 1000;
  const canDeposit = p.status !== 'ended' && now >= openAt;

  const stake = () => {
    const calls = [];
    if ((allowance.data ?? 0n) < amountIn) {
      calls.push({ label: `Allow staking to use ${p.stakingToken.symbol}`, to: p.stakingToken.address, abi: ERC20_ABI, functionName: 'approve', args: [p.staking, maxUint256] });
    }
    calls.push({ label: `Stake ${p.stakingToken.symbol}`, to: p.staking, abi: PLACE_STAKING_ABI, functionName: 'deposit', args: [p.id, amountIn] });
    return stakeTx.send(calls);
  };

  const claimable = pos.data?.claimable;
  return (
    <div className="pl-place-stack">
      <div className="pl-launch-token-tiles pl-staking-tiles">
        <Tile label="Reward per epoch" value={`${compact(num(p.rewardPerEpoch, p.rewardToken.decimals))} ${p.rewardToken.symbol}`} sub={`${p.epochCount} epochs of ${duration(p.epochDuration)}`} />
        <Tile label="Total staked" value={`${compact(num(p.totalStaked, p.stakingToken.decimals))} ${p.stakingToken.symbol}`} sub={`${p.stakers} stakers`} />
        <Tile label="Starts" value={formatUtc(p.startTime).replace(' UTC', '')} sub="UTC" icon={Clock} />
        <Tile label="Ends" value={formatUtc(p.endsAt).replace(' UTC', '')} sub="UTC" />
      </div>
      <div className="pl-place-cols">
        <Card className="pl-place-stack">
          <span className="pl-launch-section-title">Stake {p.stakingToken.symbol}</span>
          <p className="pl-launch-section-desc">
            Your share of each epoch&apos;s reward follows your stake and how long it was in. A stake is locked for one epoch
            {p.earlyExit ? `, or leaves early with a ${p.penaltyBps / 100}% penalty that is burned` : ''}.
          </p>
          {!address ? (
            <ConnectButton>Connect wallet to stake</ConnectButton>
          ) : (
            <>
              <label className="pl-place-field">
                <span className="pl-launch-field-label">Amount</span>
                <div className="pl-launch-prefixed suffix">
                  <input value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" inputMode="decimal" className="mono" />
                  <span>{p.stakingToken.symbol}</span>
                </div>
                <span className={`pl-place-hint ${tooMuch ? 'error' : ''}`.trim()}>
                  {bal.data ? `Balance: ${formatAmount(bal.data.balance, p.stakingToken.decimals, { maxDecimals: 4 })} ${p.stakingToken.symbol}` : ' '}
                  {bal.data && bal.data.balance > 0n && (
                    <button type="button" className="pl-place-link-btn" onClick={() => setText(formatAmount(bal.data.balance, p.stakingToken.decimals, { maxDecimals: 18 }).replace(/,/g, ''))}>
                      {' '}
                      Max
                    </button>
                  )}
                </span>
              </label>
              <TxButton tx={stakeTx} onClick={stake} fullWidth disabled={!amountIn || tooMuch || !canDeposit} busyLabel="Staking on Base...">
                {!canDeposit ? (p.status === 'ended' ? 'Program ended' : `Opens ${formatUtc(p.depositsOpenAt)}`) : 'Stake'}
              </TxButton>
              <TxResult tx={stakeTx} success="Staked" />
            </>
          )}
        </Card>
        <Card className="pl-place-stack">
          <span className="pl-launch-section-title">Your position</span>
          {!address ? (
            <p className="pl-launch-muted pl-launch-small">Connect wallet to see your stake and rewards.</p>
          ) : pos.isLoading ? (
            <Skeleton height={80} />
          ) : pos.error ? (
            <QueryError error={pos.error} retry={pos.refetch} />
          ) : (
            <>
              <dl className="pl-place-kv">
                <div>
                  <dt>Staked</dt>
                  <dd className="mono">
                    {formatAmount(pos.data.staked, p.stakingToken.decimals, { maxDecimals: 4 })} {p.stakingToken.symbol}
                  </dd>
                </div>
                <div>
                  <dt>Claimable</dt>
                  <dd className="mono">
                    {formatAmount(claimable.total, p.rewardToken.decimals, { maxDecimals: 6 })} {p.rewardToken.symbol}
                    {claimable.epochs.length > 0 && <span className="pl-launch-muted"> · {claimable.epochs.length} epochs</span>}
                  </dd>
                </div>
              </dl>
              <TxButton
                tx={claimTx}
                fullWidth
                variant="primary"
                disabled={!pos.data.tx.claim}
                onClick={() => claimTx.send({ label: 'Claim staking rewards', to: pos.data.tx.claim.to, data: pos.data.tx.claim.data })}
                busyLabel="Claiming on Base..."
              >
                {pos.data.tx.claim ? `Claim ${formatAmount(claimable.total, p.rewardToken.decimals, { maxDecimals: 6 })} ${p.rewardToken.symbol}` : 'Nothing to claim yet'}
              </TxButton>
              <TxResult tx={claimTx} success="Claimed" />
              {!pos.data.tx.claim && p.status !== 'ended' && <span className="pl-place-hint">Rewards of an epoch can be claimed once it ends.</span>}
              {pos.data.lots.length > 0 && (
                <div className="pl-launch-hub-list">
                  {pos.data.lots.map((l) => (
                    <div key={l.lotId} className="pl-launch-hub-row">
                      <span className="mono">
                        {compact(num(l.amount, p.stakingToken.decimals))} {p.stakingToken.symbol}
                      </span>
                      <span className="pl-launch-hub-row-right">
                        {l.unlocked ? (
                          <TxButton
                            tx={withdrawTx}
                            size="sm"
                            onClick={() => withdrawTx.send({ label: 'Withdraw stake', to: p.staking, abi: PLACE_STAKING_ABI, functionName: 'withdraw', args: [p.id, BigInt(l.lotId), BigInt(l.amount), address] })}
                          >
                            Withdraw
                          </TxButton>
                        ) : (
                          <span className="pl-launch-muted pl-launch-small pl-launch-inline">
                            <Lock size={12} /> until {formatUtc(l.unlockAt)}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <TxResult tx={withdrawTx} success="Withdrawn" />
            </>
          )}
        </Card>
      </div>
      <Card>
        <dl className="pl-place-kv">
          <div>
            <dt>Token</dt>
            <dd>
              {p.launchedOnPlace ? (
                <Link className="pl-place-link" to={launchTokenPath(p.stakingToken.address)}>
                  {p.stakingToken.symbol}
                </Link>
              ) : (
                <AddressLink address={p.stakingToken.address} />
              )}
            </dd>
          </div>
          <div>
            <dt>Funded by</dt>
            <dd className="pl-launch-inline">
              {p.fromLaunchVault ? 'Community Pool of the token' : 'A wallet'} <AddressLink address={p.creator} />
            </dd>
          </div>
          <div>
            <dt>Total reward</dt>
            <dd className="mono">
              {formatAmount(p.totalReward, p.rewardToken.decimals, { maxDecimals: 4 })} {p.rewardToken.symbol} (+{p.feeBps / 100}% Place fee)
            </dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd>
              <AddressLink address={p.staking} />
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

export default function StakingPage() {
  const now = useNow(10_000);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get('program');
  const q = useStakingPrograms({}, { enabled: Boolean(id) });
  if (!id) return <Navigate to="/hub?type=staking" replace />;
  const open = (q.data?.programs || []).find((p) => p.id === id);
  const back = (
    <button type="button" className="pl-place-back" onClick={() => navigate('/hub?type=staking')}>
      <ArrowLeft size={14} /> All staking vaults
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
    <div className="pl-place-stack pl-staking">
      {back}
      <div className="pl-vault-detail-head">
        <PairLogos a={open.stakingToken} b={open.rewardToken} size={40} />
        <div className="pl-vault-title">
          <h1 className="pl-vault-detail-title">
            Stake {open.stakingToken.symbol} · Earn {open.rewardToken.symbol}
          </h1>
          <CopyId id={open.id} title="Copy vault ID" />
        </div>
        <PhaseBadge status={open.status} />
      </div>
      <ProgramDetail p={open} now={now} />
    </div>
  );
}
