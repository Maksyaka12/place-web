// Create vault / campaign (/create): anyone funds a reward for any token on Base. Four kinds: a staking vault
// (PlaceStaking), daily holder or trader rewards and NFT holder rewards (PlaceRewardsDistributor streams).
// The creator of a Place token can pay from its Community Pool instead of a wallet. `?type=` and `?token=`
// fill the form. Every transaction goes through usePlaceTx (Builder Code).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decodeEventLog, maxUint256 } from 'viem';
import { AlertTriangle, ArrowLeft, BarChart3, Coins, Gift, Image as ImageIcon, Info, Rocket, Sparkles } from 'lucide-react';
import { Alert, Badge, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { placeClient, PLACE_CHAIN } from '../../place/chain';
import { formatAmount, shortAddress } from '../../place/format';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI, COMMUNITY_VAULT_ABI } from '../abi.js';
import { ERC20_ABI } from '../swap.js';
import { launchD, launchKeys, useHubAsset, usePairs, useRewardTokens, useFundQuote } from '../hooks.js';
import { planHubCreate, dayText, EPOCH, MAX_DAYS } from '../hubCreate.js';
import { launchTokenPath } from './parts.jsx';
import { amountText } from './vaults.jsx';

const KINDS = [
  { id: 'staking', title: 'Staking vault', Icon: Coins, desc: 'Holders lock the token for epochs and share a fixed reward per epoch.' },
  { id: 'holders', title: 'Holder rewards', Icon: Gift, desc: 'Every UTC day, wallets holding at least the minimum share the day’s budget.' },
  { id: 'traders', title: 'Trader rewards', Icon: BarChart3, desc: 'Every UTC day, wallets that traded at least the minimum share it by volume. Place tokens only.' },
  { id: 'nft', title: 'NFT holder rewards', Icon: ImageIcon, desc: 'Every UTC day, holders of a Place collection share it by NFT count.' },
];
const ETH_ADDR = '0x0000000000000000000000000000000000000000';
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || '').trim());
const tomorrow = () => dayText(Math.floor(Date.now() / 1000 / EPOCH) + 1);

function Field({ label, hint, error, children }) {
  return (
    <label className="pl-place-field">
      <span className="pl-launch-field-label">{label}</span>
      {children}
      {error ? <span className="pl-place-hint error">{error}</span> : hint ? <span className="pl-place-hint">{hint}</span> : null}
    </label>
  );
}

function Step({ n, title, desc, children }) {
  return (
    <section className="pl-launch-step">
      <div className="pl-launch-step-head">
        <span className="pl-launch-step-n mono">{String(n).padStart(2, '0')}</span>
        <div>
          <h2 className="pl-launch-step-title">{title}</h2>
          {desc && <p className="pl-launch-section-desc">{desc}</p>}
        </div>
      </div>
      <div className="pl-launch-step-body">{children}</div>
    </section>
  );
}

/** The fee of the distributor and of staking, read from the chain. */
function useHubFees() {
  const d = launchD();
  return useQuery({
    queryKey: [...launchKeys.all, 'hub-fees', d?.rewardsDistributor, d?.staking],
    enabled: Boolean(d?.rewardsDistributor || d?.staking),
    staleTime: 60_000,
    queryFn: async () => {
      const client = placeClient();
      const [stream, staking] = await Promise.all([
        d.rewardsDistributor ? client.readContract({ address: d.rewardsDistributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'streamFeeBps' }) : null,
        d.staking ? client.readContract({ address: d.staking, abi: PLACE_STAKING_ABI, functionName: 'feeConfig' }) : null,
      ]);
      return {
        distributor: d.rewardsDistributor,
        staking: d.staking,
        streamFeeBps: stream == null ? null : Number(stream),
        stakingFeeBps: staking ? Number(staking[0]) : null,
        stakingFeeVersion: staking ? staking[2].toString() : null,
      };
    },
  });
}

/** Allowance and balance of the paying wallet in the reward token. */
function useWalletFunds(account, token, spender) {
  return useQuery({
    queryKey: [...launchKeys.all, 'hub-funds', account, token, spender],
    enabled: Boolean(account && token && spender),
    refetchInterval: 15_000,
    queryFn: async () => {
      const client = placeClient();
      if (token === 'eth') return { balance: await client.getBalance({ address: account }), allowance: maxUint256 };
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, spender] }),
      ]);
      return { balance, allowance };
    },
  });
}

/** Where a created stream or vault lives, from the transaction's logs. */
function createdPath(receipt) {
  for (const l of receipt?.logs || []) {
    for (const abi of [REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI, COMMUNITY_VAULT_ABI]) {
      try {
        const ev = decodeEventLog({ abi, data: l.data, topics: l.topics });
        if (ev.eventName === 'StreamCreated' || ev.eventName === 'FundCampaignCreated') return `/hub?stream=${String(ev.args.streamId || ev.args.id).toLowerCase()}`;
        if (ev.eventName === 'VaultCreated') return `/staking?program=${String(ev.args.vaultId).toLowerCase()}`;
      } catch {
        // another contract's log
      }
    }
  }
  return null;
}

function AssetCard({ asset, type }) {
  if (!asset) return null;
  return (
    <div className="pl-rewards-asset">
      <span className="pl-launch-strong">
        {asset.name || 'Unnamed'} {asset.symbol && <span className="pl-launch-muted">({asset.symbol})</span>}
      </span>
      <span className="pl-staking-tags">
        {asset.isNft ? <Badge tone="neutral">NFT collection</Badge> : <Badge tone="neutral">Token</Badge>}
        {asset.place && (
          <Badge tone="accent">
            <Rocket size={11} /> Launched on Place{asset.place.launchType === 'economy' ? ' · Economy' : ''}
          </Badge>
        )}
        {asset.placeCollection && (
          <Badge tone="accent">
            <Sparkles size={11} /> Place collection
          </Badge>
        )}
        {asset.place && (
          <Link className="pl-place-link pl-launch-small" to={launchTokenPath(asset.address)}>
            Token page
          </Link>
        )}
      </span>
      {type === 'nft' && asset.isNft && !asset.placeCollection && <span className="pl-place-hint">Only collections launched on Place can get NFT holder rewards.</span>}
    </div>
  );
}

export default function HubCreatePage() {
  const { address } = usePlaceAccount();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [f, setF] = useState(() => ({
    type: KINDS.some((k) => k.id === params.get('type')) ? params.get('type') : 'holders',
    token: params.get('token') || '',
    funding: 'wallet',
    reward: 'eth',
    customReward: '',
    amount: '',
    days: '30',
    startDay: tomorrow(),
    criterion: '',
    epochDays: '1',
    earlyExit: false,
    penaltyPct: '10',
    slippagePct: '1',
  }));
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  const [touched, setTouched] = useState(false);
  const tx = usePlaceTx();

  const tokenAddr = isAddr(f.token) ? f.token.trim().toLowerCase() : null;
  const assetQ = useHubAsset(tokenAddr, address);
  const asset = assetQ.data || null;
  const fees = useHubFees();
  const pairs = usePairs();
  const pool = f.funding === 'pool';
  const quote = asset?.place?.quote || null;
  const poolRewards = useRewardTokens(pool && quote ? quote.address : null);

  // Reward token choices: ETH, the launch pairs, the token itself, any address; from the pool, what its routes reach.
  const choices = useMemo(() => {
    if (pool) {
      return (poolRewards.data?.tokens || []).map((t) => [t.address === 'self' ? tokenAddr : t.address, t.address === 'self' ? `${asset?.symbol || 'The token'} (bought in its pool)` : t.symbol || shortAddress(t.address)]);
    }
    const list = [['eth', 'ETH']];
    for (const p of pairs.data?.pairs || []) if (p.address !== 'eth' && p.symbol) list.push([p.address, p.symbol]);
    if (tokenAddr && asset && !asset.isNft && !list.some(([a]) => a === tokenAddr)) list.push([tokenAddr, `${asset.symbol || 'This token'} (same token)`]);
    list.push(['custom', 'Another token (address)']);
    return list;
  }, [pool, poolRewards.data, pairs.data, tokenAddr, asset]);
  const rewardValue = f.reward === 'custom' ? f.customReward.trim().toLowerCase() : f.reward;
  const rewardIsAddr = isAddr(rewardValue);
  const rewardQ = useHubAsset(rewardIsAddr && rewardValue !== ETH_ADDR ? rewardValue : null);
  const rewardMeta = rewardValue === 'eth' ? { symbol: 'ETH', decimals: 18, isNft: false } : rewardQ.data ? { symbol: rewardQ.data.symbol, decimals: rewardQ.data.decimals, isNft: rewardQ.data.isNft } : null;

  const plan = planHubCreate({ ...f, token: tokenAddr || f.token, reward: rewardValue }, { now: Math.floor(Date.now() / 1000), asset, rewardMeta, ...(fees.data || {}) });
  const quoteQ = useFundQuote(pool ? plan.fundQuery : null);
  const funds = useWalletFunds(!pool ? address : null, rewardValue === 'eth' ? 'eth' : rewardIsAddr ? rewardValue : null, plan.spender);
  const short = !pool && funds.data && plan.pay > 0n && funds.data.balance < plan.pay;
  const err = (k) => (touched || (k === 'token' && tokenAddr) ? plan.errors[k] : null);
  const sym = rewardMeta?.symbol || (pool ? choices.find(([a]) => a === rewardValue)?.[1] : '') || '';
  const kind = KINDS.find((k) => k.id === f.type);
  const staking = f.type === 'staking';
  const poolOk = asset?.pool?.available && asset.pool.isCreator && f.type !== 'nft';

  const submit = async () => {
    setTouched(true);
    if (!address) return;
    let receipt = null;
    if (pool) {
      const q = quoteQ.data;
      if (!q?.tx || Object.keys(plan.errors).length) return;
      receipt = await tx.send({ label: staking ? 'Create staking vault from the Community Pool' : 'Create rewards from the Community Pool', to: q.tx.to, data: q.tx.data, value: 0n });
    } else {
      if (!plan.call || short) return;
      const calls = [];
      if (rewardValue !== 'eth' && (funds.data?.allowance ?? 0n) < plan.pay) {
        calls.push({ label: `Allow Place to use ${sym || 'the reward token'}`, to: rewardValue, abi: ERC20_ABI, functionName: 'approve', args: [plan.spender, plan.pay] });
      }
      calls.push(plan.call);
      receipt = await tx.send(calls);
    }
    const path = createdPath(receipt);
    if (path) navigate(path);
  };

  const q = quoteQ.data;
  return (
    <div className="pl-launch pl-launch-new pl-rewards-create">
      <Link to="/hub" className="pl-place-back">
        <ArrowLeft size={14} />
        Rewards
      </Link>
      <header className="pl-launch-new-header">
        <h1 className="page-title">Create vault / campaign</h1>
        <p className="page-desc">Reward stakers, holders, traders or NFT holders of any token on {PLACE_CHAIN.name}, funded in one transaction</p>
      </header>
      <div className="pl-launch-new-cols">
        <form className="pl-place-form pl-launch-new-form" onSubmit={(e) => e.preventDefault()} noValidate>
          <Step n={1} title="What to reward">
            <div className="pl-launch-kinds pl-rewards-kinds" role="radiogroup" aria-label="Type of reward">
              {KINDS.map(({ id, title, desc, Icon }) => (
                <button key={id} type="button" role="radio" aria-checked={f.type === id} className="card pl-launch-kind" onClick={() => set({ type: id, criterion: '', funding: id === 'nft' ? 'wallet' : f.funding })}>
                  <span className="pl-launch-kind-title">
                    <Icon size={16} /> {title}
                  </span>
                  <span className="pl-launch-kind-desc">{desc}</span>
                </button>
              ))}
            </div>
          </Step>

          <Step n={2} title={f.type === 'nft' ? 'Collection' : 'Token'} desc={f.type === 'nft' ? 'A collection launched on Place' : 'Any ERC-20 on Base. Trader rewards need a token launched on Place'}>
            <Field label={f.type === 'nft' ? 'Collection address' : 'Token address'} error={err('token') || (assetQ.error ? assetQ.error.message : null)}>
              <input className="mono" value={f.token} onChange={(e) => set({ token: e.target.value.trim(), reward: 'eth' })} placeholder="0x..." spellCheck={false} />
            </Field>
            <AssetCard asset={asset} type={f.type} />
            {asset && (
              <div className="seg soft pl-rewards-funding" role="radiogroup" aria-label="Pay from">
                <button type="button" role="radio" aria-checked={!pool} onClick={() => set({ funding: 'wallet', reward: 'eth' })}>
                  My wallet
                </button>
                <button type="button" role="radio" aria-checked={pool} disabled={!poolOk} onClick={() => set({ funding: 'pool', reward: quote?.address || 'eth' })} title={poolOk ? undefined : asset.pool.available ? (f.type === 'nft' ? asset.pool.note : 'Only the token’s creator can spend its Community Pool') : 'This token has no Community Pool'}>
                  Community Pool
                </button>
              </div>
            )}
            {err('funding') && <span className="pl-place-hint error">{err('funding')}</span>}
            {pool && <span className="pl-place-hint">The pool pays in {quote?.symbol}. Choose another reward token and the pool swaps it in the same transaction, with a minimum you set below.</span>}
          </Step>

          <Step n={3} title="Reward and schedule">
            <div className="pl-launch-two even">
              <Field label="Reward token" error={err('reward')}>
                <select value={choices.some(([a]) => a === f.reward) ? f.reward : choices[0]?.[0] || ''} onChange={(e) => set({ reward: e.target.value })}>
                  {choices.map(([a, label]) => (
                    <option key={a} value={a}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              {f.reward === 'custom' && !pool ? (
                <Field label="Reward token address" hint={rewardQ.data ? `${rewardQ.data.name || ''} (${rewardQ.data.symbol || '?'})` : null} error={rewardQ.error?.message}>
                  <input className="mono" value={f.customReward} onChange={(e) => set({ customReward: e.target.value })} placeholder="0x..." spellCheck={false} />
                </Field>
              ) : (
                <Field label={pool ? `Spend from the pool, ${quote?.symbol || ''}` : `Reward pool${sym ? `, ${sym}` : ''}`} error={err('amount')} hint={pool ? null : 'Split evenly over the days; the Place fee comes on top'}>
                  <input className="mono" inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" />
                </Field>
              )}
            </div>
            {f.reward === 'custom' && !pool && (
              <Field label={`Reward pool${sym ? `, ${sym}` : ''}`} error={err('amount')} hint="Split evenly over the days; the Place fee comes on top">
                <input className="mono" inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0" />
              </Field>
            )}
            <div className="pl-launch-three">
              <Field label={staking ? 'Epochs' : 'Days'} error={err('days')} hint={staking ? null : `Up to ${MAX_DAYS}`}>
                <input className="mono" inputMode="numeric" value={f.days} onChange={(e) => set({ days: e.target.value.replace(/\D/g, '') })} />
              </Field>
              {staking && (
                <Field label="Epoch length, days" error={err('epochDays')}>
                  <input className="mono" inputMode="numeric" value={f.epochDays} onChange={(e) => set({ epochDays: e.target.value.replace(/\D/g, '') })} />
                </Field>
              )}
              <Field label="Starts (00:00 UTC)" error={err('startDay')}>
                <input type="date" className="mono" value={f.startDay} onChange={(e) => set({ startDay: e.target.value })} />
              </Field>
            </div>
            {staking ? (
              <div className="pl-launch-two even">
                <Field label="Early withdrawal">
                  <select value={f.earlyExit ? 'on' : 'off'} onChange={(e) => set({ earlyExit: e.target.value === 'on' })}>
                    <option value="off">Forbidden until the epoch ends</option>
                    <option value="on">Allowed with a penalty</option>
                  </select>
                </Field>
                {f.earlyExit && (
                  <Field label="Penalty, %" error={err('penaltyPct')} hint="Burned">
                    <input className="mono" inputMode="decimal" value={f.penaltyPct} onChange={(e) => set({ penaltyPct: e.target.value })} />
                  </Field>
                )}
              </div>
            ) : (
              <Field
                label={f.type === 'nft' ? 'Minimum NFTs per wallet' : f.type === 'traders' ? `Minimum daily volume${quote ? `, ${quote.symbol}` : ''}` : `Minimum balance${asset?.symbol ? `, ${asset.symbol}` : ''}`}
                error={err('criterion')}
                hint={f.type === 'traders' ? 'Buys plus sells in one UTC day. Empty for any trade' : f.type === 'nft' ? 'At the end of each UTC day' : 'At the end of each UTC day. Empty for any balance'}
              >
                <input className="mono" inputMode="decimal" value={f.criterion} onChange={(e) => set({ criterion: e.target.value.replace(/[^\d.]/g, '') })} placeholder={f.type === 'nft' ? '1' : '0'} />
              </Field>
            )}
            {pool && (
              <Field label="Slippage, %" error={err('slippagePct')} hint="The least the swap may return below the quote">
                <input className="mono" inputMode="decimal" value={f.slippagePct} onChange={(e) => set({ slippagePct: e.target.value })} />
              </Field>
            )}
          </Step>
        </form>

        <aside className="pl-launch-new-side">
          <Card className="pl-launch-summary">
            <span className="pl-launch-section-title">{kind?.title}</span>
            <dl className="pl-launch-summary-kv">
              <div>
                <dt>{f.type === 'nft' ? 'Collection' : 'Token'}</dt>
                <dd>{asset?.symbol || (tokenAddr ? shortAddress(tokenAddr) : '—')}</dd>
              </div>
              <div>
                <dt>Paid from</dt>
                <dd>{pool ? 'Community Pool' : 'Your wallet'}</dd>
              </div>
              {pool ? (
                <>
                  <div>
                    <dt>Pool spends</dt>
                    <dd className="mono">{f.amount ? `${f.amount} ${quote?.symbol || ''}` : '—'}</dd>
                  </div>
                  <div>
                    <dt>{staking ? 'Per epoch' : 'Per day'}</dt>
                    <dd className="mono">{q?.perEpoch ? `${amountText(q.perEpoch, rewardQ.data?.decimals ?? (rewardValue === 'eth' ? 18 : quote?.decimals ?? 18))} ${sym}` : quoteQ.isFetching ? '…' : '—'}</dd>
                  </div>
                  <div>
                    <dt>Place fee</dt>
                    <dd className="mono">{q?.feeBps != null ? `${q.feeBps / 100}%` : '—'}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>{staking ? 'Per epoch' : 'Per day'}</dt>
                    <dd className="mono">{plan.perEpoch ? `${amountText(plan.perEpoch, rewardMeta?.decimals ?? 18)} ${sym}` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Place fee</dt>
                    <dd className="mono">
                      {plan.fee ? `${amountText(plan.fee, rewardMeta?.decimals ?? 18)} ${sym}` : '—'}
                      {fees.data && <span className="pl-launch-muted"> · {(staking ? fees.data.stakingFeeBps : fees.data.streamFeeBps) / 100}%</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>You pay</dt>
                    <dd className="mono">{plan.pay ? `${amountText(plan.pay, rewardMeta?.decimals ?? 18)} ${sym}` : '—'}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>Runs</dt>
                <dd className="mono">{plan.errors.days || plan.errors.startDay ? '—' : staking ? `${f.days} × ${f.epochDays}d from ${f.startDay}` : `${f.days} days from ${f.startDay}`}</dd>
              </div>
            </dl>
            <div className="pl-launch-submit">
              {!address ? (
                <ConnectButton size="lg">Connect wallet to create</ConnectButton>
              ) : (
                <TxButton
                  tx={tx}
                  onClick={submit}
                  size="lg"
                  fullWidth
                  variant="primary"
                  disabled={touched && (Object.keys(plan.errors).length > 0 || short || (pool && !q?.tx))}
                  busyLabel="Creating on Base..."
                >
                  {staking ? 'Create staking vault' : 'Create rewards'}
                </TxButton>
              )}
              {short && (
                <span className="pl-place-hint error">
                  Your balance is {formatAmount(funds.data.balance, rewardMeta?.decimals ?? 18, { maxDecimals: 6 })} {sym}.
                </span>
              )}
              {pool && q?.error && <span className="pl-place-hint error">{q.error}</span>}
              {pool && quoteQ.error && <span className="pl-place-hint error">{quoteQ.error.message}</span>}
              {touched && plan.errors.form && <span className="pl-place-hint">{plan.errors.form}</span>}
              {touched && Object.keys(plan.errors).filter((k) => k !== 'form').length > 0 && <span className="pl-place-hint error">Fix the fields marked on the left.</span>}
              {tx.step && tx.busy && <span className="pl-place-hint">Step: {tx.step}</span>}
              <TxResult tx={tx} success="Created. Opening it in the hub" />
            </div>
          </Card>
          <Alert tone="info" icon={<Info size={16} />}>
            {staking
              ? 'Rewards of an epoch go to everyone staked in it, in proportion to amount and time. Nobody can take the reward back once the vault is funded.'
              : 'Place builds a public table every UTC day and publishes its root on chain; wallets claim any time. Whatever is never shared goes back to you 30 days after the last day.'}
          </Alert>
          {f.type === 'nft' && (
            <Alert tone="warn" icon={<AlertTriangle size={16} />}>
              NFT holder rewards are only for collections launched on Place. <Link className="pl-place-link" to="/launch/nft">Launch a collection</Link>
            </Alert>
          )}
        </aside>
      </div>
    </div>
  );
}
