// Staking (/staking): PlaceStaking programs. Anyone stakes the program's token for a share of
// a fixed reward per epoch; rewards of an epoch are claimable once it ends. Programs paid from a Place token's
// community fund are made in the creator console (fundStaking); this page lists every program and runs stake,
// withdraw and claim. `?program=<id>` opens one program.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Coins, Lock, Rocket, Clock } from 'lucide-react';
import { maxUint256 } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { Card, Badge, EmptyState, PageHeader, Tile, Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { placeClient } from '../../place/chain';
import { formatAmount, formatUtc, parseAmount } from '../../place/format';
import { PLACE_STAKING_ABI } from '../abi.js';
import { ERC20_ABI } from '../swap.js';
import { useStakingPrograms, useStakingPosition, launchKeys } from '../hooks.js';
import { launchTokenPath } from './parts.jsx';
import { compact } from '../format.js';

const STATUS = { live: 'Live', open: 'Open', upcoming: 'Upcoming', ended: 'Ended' };
const num = (raw, decimals, max = 4) => Number(formatAmount(raw ?? 0, decimals, { maxDecimals: max }).replace(/,/g, ''));
const duration = (s) => (s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`);

function ProgramCard({ p, active, onOpen }) {
  return (
    <Card hover className={`pl-staking-card ${active ? 'active' : ''}`.trim()} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="pl-staking-card-head">
        <span className="pl-staking-icon">
          <Coins size={18} />
        </span>
        <div className="pl-staking-card-title">
          <span className="pl-launch-strong">Stake {p.stakingToken.symbol}</span>
          <span className="pl-launch-muted pl-launch-small">
            earn {p.rewardToken.symbol} · {p.epochCount} × {duration(p.epochDuration)}
          </span>
        </div>
        <Badge tone={p.status === 'live' ? 'success' : p.status === 'ended' ? 'danger' : p.status === 'open' ? 'accent' : 'neutral'} pill>
          {STATUS[p.status]}
        </Badge>
      </div>
      <dl className="pl-place-kv pl-staking-kv">
        <div>
          <dt>Per epoch</dt>
          <dd className="mono">
            {compact(num(p.rewardPerEpoch, p.rewardToken.decimals))} {p.rewardToken.symbol}
          </dd>
        </div>
        <div>
          <dt>Staked</dt>
          <dd className="mono">
            {compact(num(p.totalStaked, p.stakingToken.decimals))} {p.stakingToken.symbol}
          </dd>
        </div>
        <div>
          <dt>Stakers</dt>
          <dd className="mono">{p.stakers}</dd>
        </div>
      </dl>
      <div className="pl-staking-tags">
        {p.launchedOnPlace && (
          <Badge tone="accent">
            <Rocket size={11} /> Launched on Place
          </Badge>
        )}
        {p.fromLaunchVault && <Badge tone="neutral">Community fund</Badge>}
        {p.position && p.position.staked !== '0' && <Badge tone="success">You stake</Badge>}
      </div>
    </Card>
  );
}

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
  const { address, isDemo } = usePlaceAccount();
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
              <TxButton tx={stakeTx} onClick={stake} fullWidth disabled={!amountIn || tooMuch || !canDeposit || isDemo} busyLabel="Staking on Base...">
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
                disabled={!pos.data.tx.claim || isDemo}
                onClick={() => claimTx.send({ label: 'Claim staking rewards', to: pos.data.tx.claim.to, data: pos.data.tx.claim.data, preview: { action: 'Claim staking rewards', contract: p.staking, method: 'claim' } })}
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
                            disabled={isDemo}
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
              {p.fromLaunchVault ? 'Community fund of the token' : 'A wallet'} <AddressLink address={p.creator} />
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
  const { address } = usePlaceAccount();
  const now = useNow(10_000);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('all');
  const q = useStakingPrograms(address ? { account: address } : {});
  const programs = useMemo(() => q.data?.programs || [], [q.data]);
  const shown = programs.filter((p) => (filter === 'mine' ? p.position && p.position.staked !== '0' : filter === 'active' ? p.status !== 'ended' : true));
  const open = programs.find((p) => p.id === params.get('program'));

  return (
    <div className="pl-place-stack pl-staking">
      <PageHeader title="Staking" description="Stake tokens for a fixed reward every epoch, from creators and community funds of Place tokens" />
      <Alert tone="info" icon={<Coins size={15} />}>
        Creators of Place tokens start programs from their community fund in the creator console. Every program pays Place a 5% fee on top of its rewards.
      </Alert>
      <div className="seg soft" role="tablist" aria-label="Programs">
        {[
          ['all', 'All'],
          ['active', 'Active'],
          ['mine', 'Mine'],
        ].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} disabled={id === 'mine' && !address}>
            {label}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <Skeleton height={160} />
      ) : q.error ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : shown.length ? (
        <div className="pl-place-grid">
          {shown.map((p) => (
            <ProgramCard key={p.id} p={p} active={open?.id === p.id} onOpen={() => setParams({ program: p.id })} />
          ))}
        </div>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState icon={<Coins size={28} />} title={filter === 'mine' ? 'You stake in no program yet' : 'No staking programs yet'} description="Programs appear here as soon as a creator funds one." />
        </Card>
      )}
      {open && (
        <>
          <span className="pl-launch-section-title">
            {open.stakingToken.symbol} → {open.rewardToken.symbol}
          </span>
          <ProgramDetail p={open} now={now} />
        </>
      )}
    </div>
  );
}
