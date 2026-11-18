// Create vault / campaign (/create): anyone funds a reward for any token on Base. One form for four kinds: a staking
// vault (PlaceStaking), daily holder or trader rewards and NFT holder rewards (PlaceRewardsDistributor streams).
// Steps: 01 Assets (the token or collection, who pays, the reward currency through the reward token picker),
// 02 Schedule (start, days or epochs, the budget), 03 Criteria (the condition); on the right a sticky Preview and the
// Funding summary with the Place fee on top. The creator of a Place token can pay from its Community Pool instead
// of a wallet. `?type=` and `?token=` fill the form. Every transaction goes through usePlaceTx (Builder Code).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decodeEventLog, maxUint256 } from 'viem';
import { AlertTriangle, ArrowLeft, BarChart3, Coins, Gift, Image as ImageIcon, Info, Loader2, Rocket, Sparkles } from 'lucide-react';
import { Alert, Badge, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { placeClient, PLACE_CHAIN } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI, COMMUNITY_VAULT_ABI } from '../abi.js';
import { ERC20_ABI } from '../swap.js';
import { launchD, launchKeys, useHubAsset, usePairs, useRewardTokens, useFundQuote } from '../hooks.js';
import { planHubCreate, dayText, createSchedule, poolFromPerEpoch, walletRewardOptions, poolRewardOptions, EPOCH, MAX_DAYS } from '../hubCreate.js';
import { launchTokenPath } from './parts.jsx';
import { amountText, PairLogos } from './vaults.jsx';
import { RewardTokenButton, RewardTokenPicker, RewardOption } from './RewardTokenPicker.jsx';

const KINDS = [
  { id: 'staking', tab: 'Staking', title: 'Staking vault', Icon: Coins, desc: 'Holders lock the token for epochs and share a fixed reward per epoch.' },
  { id: 'holders', tab: 'Holders', title: 'Holder rewards', Icon: Gift, desc: 'Every UTC day, wallets holding at least the minimum share the day’s amount.' },
  { id: 'traders', tab: 'Traders', title: 'Trader rewards', Icon: BarChart3, desc: 'Every UTC day, wallets that traded at least the minimum share the day’s amount by volume. Place tokens only.' },
  { id: 'nft', tab: 'NFT holders', title: 'NFT holder rewards', Icon: ImageIcon, desc: 'Every UTC day, holders of a Place collection share the day’s amount by NFT count.' },
];
const VERB = { staking: 'Stake', holders: 'Hold', traders: 'Trade', nft: 'Hold' };
const EPOCH_PRESETS = ['1', '7', '14', '30'];
const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || '').trim());
const tomorrow = () => dayText(Math.floor(Date.now() / 1000 / EPOCH) + 1);
const digits = (v) => v.replace(/\D/g, '');
const decimal = (v) => v.replace(/[^\d.]/g, '');

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

/** A number box with its unit on the right. */
function Unit({ unit, ...input }) {
  return (
    <div className="pl-launch-prefixed suffix">
      <input className="mono" {...input} />
      {unit && <span>{unit}</span>}
    </div>
  );
}

/** A small pill switch (`.seg.soft`) for two or more choices. */
function Choice({ label, value, options, onChange, disabledOf }) {
  return (
    <div className="seg soft pl-rewards-choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} disabled={disabledOf?.(v)} title={title} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
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

/** A pasted reward token address in the picker: checked through `launch/hub/asset` before it can be picked. */
function AddressReward({ address, onPick, describe }) {
  const q = useHubAsset(address);
  if (q.isLoading) {
    return (
      <p className="pl-place-hint pl-collection-picker-note">
        <Loader2 size={13} className="spin" /> Checking this token...
      </p>
    );
  }
  if (q.error) return <Alert tone="danger" icon={<AlertTriangle size={16} />}>{q.error.message}</Alert>;
  const a = q.data;
  if (!a) return null;
  if (a.isNft) return <Alert tone="warn" icon={<AlertTriangle size={16} />}>This is an NFT collection. Rewards are paid in ETH or an ERC-20 token.</Alert>;
  const t = { address, symbol: a.symbol, name: a.name, decimals: a.decimals, source: 'address', category: 'crypto', contractURI: a.place?.contractURI ?? null, placeLaunch: Boolean(a.place) };
  return <RewardOption t={t} picked={false} onPick={() => onPick(t)} describe={describe} />;
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
    customToken: null,
    amountMode: 'pool',
    amount: '',
    perEpoch: '',
    days: '30',
    startDay: tomorrow(),
    criterion: '',
    epochDays: '7',
    earlyExit: false,
    penaltyPct: '10',
    slippagePct: '1',
  }));
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  const [touched, setTouched] = useState(false);
  const [picking, setPicking] = useState(false);
  const tx = usePlaceTx();

  const tokenAddr = isAddr(f.token) ? f.token.trim().toLowerCase() : null;
  const assetQ = useHubAsset(tokenAddr, address);
  const asset = assetQ.data || null;
  const fees = useHubFees();
  const pairs = usePairs();
  const pool = f.funding === 'pool';
  const quote = asset?.place?.quote || null;
  const poolRewards = useRewardTokens(pool && quote ? quote.address : null);
  const staking = f.type === 'staking';
  const kind = KINDS.find((k) => k.id === f.type);

  // Reward currencies: from a wallet ETH, the launch pairs, the token itself and any pasted ERC-20; from the pool,
  // what its routes reach.
  const options = useMemo(() => {
    if (pool) return poolRewardOptions(poolRewards.data?.tokens, tokenAddr, asset);
    const list = walletRewardOptions({ pairs: pairs.data?.pairs, token: tokenAddr, asset });
    if (f.customToken && !list.some((t) => t.address === f.customToken.address)) list.push(f.customToken);
    return list;
  }, [pool, poolRewards.data, pairs.data, tokenAddr, asset, f.customToken]);
  const rewardValue = f.reward;
  const picked = options.find((t) => t.address === rewardValue) || null;
  const rewardIsAddr = isAddr(rewardValue);
  const rewardQ = useHubAsset(rewardIsAddr && picked?.decimals == null ? rewardValue : null);
  const rewardMeta = rewardValue === 'eth' ? { symbol: 'ETH', decimals: 18, isNft: false } : picked?.decimals != null ? { symbol: picked.symbol, decimals: picked.decimals, isNft: false } : rewardQ.data ? { symbol: rewardQ.data.symbol, decimals: rewardQ.data.decimals, isNft: rewardQ.data.isNft } : null;
  const sym = rewardMeta?.symbol || picked?.symbol || '';
  const decimals = rewardMeta?.decimals ?? 18;

  // Staking can be set as a reward per epoch: the form turns it into the pool it sends.
  const perEpochMode = staking && !pool && f.amountMode === 'epoch';
  const amount = perEpochMode ? poolFromPerEpoch(f.perEpoch, f.days, rewardMeta?.decimals) : f.amount;
  const plan = planHubCreate({ ...f, amount, token: tokenAddr || f.token, reward: rewardValue }, { now: Math.floor(Date.now() / 1000), asset, rewardMeta, ...(fees.data || {}) });
  const schedule = createSchedule(f);
  const quoteQ = useFundQuote(pool ? plan.fundQuery : null);
  const funds = useWalletFunds(!pool ? address : null, rewardValue === 'eth' ? 'eth' : rewardIsAddr ? rewardValue : null, plan.spender);
  const short = !pool && funds.data && plan.pay > 0n && funds.data.balance < plan.pay;
  const err = (k) => (touched || (k === 'token' && tokenAddr) ? plan.errors[k] : null);
  const poolOk = asset?.pool?.available && asset.pool.isCreator && f.type !== 'nft';
  const q = quoteQ.data;
  const feeBps = pool ? q?.feeBps ?? null : fees.data ? (staking ? fees.data.stakingFeeBps : fees.data.streamFeeBps) : null;
  const per = pool ? (q?.perEpoch ? BigInt(q.perEpoch) : 0n) : plan.perEpoch || 0n;
  const perText = per ? `${amountText(per, decimals)} ${sym}` : '—';
  const targetLabel = asset?.symbol || (tokenAddr ? shortAddress(tokenAddr) : f.type === 'nft' ? 'NFT' : 'TOKEN');
  const title = `${VERB[f.type]} ${targetLabel}${f.type === 'nft' ? ' NFT' : ''} · Earn ${sym || '…'}`;

  const describe = (t) => {
    if (t.source === 'pair') return { title: t.symbol, sub: pool ? 'The pool pays in it: no swap' : t.address === 'eth' ? 'Native ETH' : 'A launch pair asset' };
    if (t.source === 'token') return { title: t.symbol || 'The token', sub: pool ? 'Bought in its own pool' : 'The token itself' };
    if (t.source === 'route') return { title: t.symbol || 'Unknown', sub: 'The pool buys it in the same transaction' };
    if (t.source === 'address') return { title: t.symbol || shortAddress(t.address), sub: t.name && t.name !== t.symbol ? t.name : 'ERC-20 by address' };
    return null;
  };

  const pickType = (id) => set({ type: id, criterion: '', funding: id === 'nft' ? 'wallet' : f.funding, amountMode: 'pool', reward: id === 'nft' && pool ? 'eth' : f.reward });
  const pickReward = (value) => (typeof value === 'object' ? set({ reward: value.address, customToken: value }) : set({ reward: value }));

  const submit = async () => {
    setTouched(true);
    if (!address) return;
    let receipt = null;
    if (pool) {
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

  const target = { address: tokenAddr || '0x', symbol: asset?.symbol || (f.type === 'nft' ? 'NFT' : '?'), name: asset?.name, contractURI: asset?.place?.contractURI };
  const reward = picked || { address: rewardValue, symbol: sym || '?' };
  const conditionLine =
    f.type === 'staking'
      ? 'Any amount'
      : f.type === 'nft'
        ? `At least ${f.criterion || '1'} NFT${(f.criterion || '1') === '1' ? '' : 's'}`
        : f.type === 'traders'
          ? f.criterion
            ? `${f.criterion} ${quote?.symbol || ''} a day`.trim()
            : 'Any trade a day'
          : f.criterion
            ? `${f.criterion} ${asset?.symbol || ''}`.trim()
            : 'Any balance';

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
      <div className="pl-launch-tabs-scroll pl-rewards-create-types">
        <div className="seg soft pl-rewards-types" role="radiogroup" aria-label="Type of reward">
          {KINDS.map(({ id, tab, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={f.type === id} onClick={() => pickType(id)}>
              <Icon size={14} /> {tab}
            </button>
          ))}
        </div>
      </div>
      <p className="pl-launch-section-desc pl-rewards-create-desc">{kind.desc}</p>

      <div className="pl-launch-new-cols">
        <form className="pl-place-form pl-launch-new-form" onSubmit={(e) => e.preventDefault()} noValidate>
          <Step n={1} title="Assets" desc={f.type === 'nft' ? 'The collection whose holders earn, and what they earn' : f.type === 'traders' ? 'The token whose traders earn, and what they earn' : `The token people ${staking ? 'stake' : 'hold'}, and what they earn`}>
            <Field
              label={f.type === 'nft' ? 'Collection' : staking ? 'Staking token' : 'Token'}
              hint={f.type === 'nft' ? 'The address of a collection launched on Place' : f.type === 'traders' ? 'A token launched on Place' : 'Any ERC-20 on Base'}
              error={err('token') || (assetQ.error ? assetQ.error.message : null)}
            >
              <input className="mono" value={f.token} onChange={(e) => set({ token: e.target.value.trim(), reward: 'eth', funding: 'wallet' })} placeholder="0x..." spellCheck={false} />
            </Field>
            <AssetCard asset={asset} type={f.type} />
            {asset && (
              <div className="pl-place-field">
                <span className="pl-launch-field-label">Pay from</span>
                <Choice
                  label="Pay from"
                  value={f.funding}
                  options={[
                    ['wallet', 'My wallet'],
                    ['pool', 'Community Pool', poolOk ? undefined : asset.pool.available ? (f.type === 'nft' ? asset.pool.note : 'Only the token’s creator can spend its Community Pool') : 'This token has no Community Pool'],
                  ]}
                  disabledOf={(v) => v === 'pool' && !poolOk}
                  onChange={(v) => set(v === 'pool' ? { funding: 'pool', reward: quote?.address || 'eth', amountMode: 'pool' } : { funding: 'wallet', reward: 'eth' })}
                />
                {err('funding') && <span className="pl-place-hint error">{err('funding')}</span>}
                {pool && <span className="pl-place-hint">The pool holds {quote?.symbol}. Pick another reward and the pool swaps it in the same transaction, with the slippage you set below.</span>}
              </div>
            )}
            <div className="pl-place-field">
              <span className="pl-launch-field-label">Reward currency</span>
              <RewardTokenButton token={picked || (rewardMeta && rewardIsAddr ? { address: rewardValue, symbol: rewardMeta.symbol, source: 'address' } : null)} describe={describe} onClick={() => setPicking(true)} placeholder="Choose what people earn" />
              {err('reward') && <span className="pl-place-hint error">{err('reward')}</span>}
              {pool && poolRewards.isLoading && <span className="pl-place-hint">Loading what the pool can pay in...</span>}
            </div>
          </Step>

          <Step n={2} title="Schedule" desc={staking ? 'Epochs start at 00:00 UTC. Rewards of an epoch are claimable once it ends' : 'Every UTC day is one epoch. The pool is split evenly over the days'}>
            <div className="pl-launch-two even">
              <Field label="Start, 00:00 UTC" error={err('startDay')} hint={staking ? 'A future day' : 'Today or later'}>
                <input type="date" className="mono" value={f.startDay} onChange={(e) => set({ startDay: e.target.value })} />
              </Field>
              <Field label={staking ? 'Number of epochs' : 'Number of days'} error={err('days')} hint={`Up to ${MAX_DAYS}`}>
                <Unit inputMode="numeric" value={f.days} onChange={(e) => set({ days: digits(e.target.value) })} unit={staking ? 'epochs' : 'days'} aria-label={staking ? 'Number of epochs' : 'Number of days'} />
              </Field>
            </div>
            {staking && (
              <div className="pl-place-field">
                <span className="pl-launch-field-label">Epoch duration</span>
                <div className="pl-rewards-inline">
                  <Choice label="Epoch duration" value={f.epochDays} options={EPOCH_PRESETS.map((d) => [d, `${d}d`])} onChange={(v) => set({ epochDays: v })} />
                  <Unit inputMode="numeric" value={f.epochDays} onChange={(e) => set({ epochDays: digits(e.target.value) })} unit="days" aria-label="Epoch duration in days" />
                </div>
                {err('epochDays') ? <span className="pl-place-hint error">{err('epochDays')}</span> : <span className="pl-place-hint">1 to 30 days. A stake stays locked for one epoch</span>}
              </div>
            )}
            {pool ? (
              <div className="pl-launch-two even">
                <Field label="Spend from the pool" error={err('amount')} hint={`The pool pays the Place fee from this amount`}>
                  <Unit inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: decimal(e.target.value) })} placeholder="0" unit={quote?.symbol} aria-label="Spend from the pool" />
                </Field>
                <Field label="Slippage" error={err('slippagePct')} hint="The least the swap may return below the quote">
                  <Unit inputMode="decimal" value={f.slippagePct} onChange={(e) => set({ slippagePct: e.target.value })} unit="%" aria-label="Slippage" />
                </Field>
              </div>
            ) : (
              <div className="pl-place-field">
                <span className="pl-launch-field-label">
                  {perEpochMode ? 'Reward per epoch' : 'Reward pool'}
                  {staking && <Choice label="Set the reward as" value={f.amountMode} options={[['pool', 'Pool'], ['epoch', 'Per epoch']]} onChange={(v) => set({ amountMode: v })} />}
                </span>
                {perEpochMode ? (
                  <Unit inputMode="decimal" value={f.perEpoch} onChange={(e) => set({ perEpoch: decimal(e.target.value) })} placeholder="0" unit={sym} aria-label="Reward per epoch" />
                ) : (
                  <Unit inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: decimal(e.target.value) })} placeholder="0" unit={sym} aria-label="Reward pool" />
                )}
                {err('amount') ? <span className="pl-place-hint error">{err('amount')}</span> : <span className="pl-place-hint">The Place fee comes on top</span>}
              </div>
            )}
            <div className="pl-rewards-split">
              <span className="pl-launch-muted pl-launch-small">{staking ? 'Per epoch' : 'Per day'}</span>
              <strong className="mono">{pool && quoteQ.isFetching && !q ? '…' : perText}</strong>
              <span className="pl-launch-muted pl-launch-small">
                {staking ? `Shared by everyone staked in the epoch, by amount and time` : `Pool ÷ ${schedule?.epochs || 'N'} days, shared by the wallets eligible that day. A day with nobody eligible rolls over`}
              </span>
            </div>
            {staking && (
              <div className="pl-place-field">
                <span className="pl-launch-field-label">Early withdrawal</span>
                <div className="pl-rewards-inline">
                  <Choice
                    label="Early withdrawal"
                    value={f.earlyExit ? 'on' : 'off'}
                    options={[
                      ['off', 'Forbidden'],
                      ['on', 'With a penalty'],
                    ]}
                    onChange={(v) => set({ earlyExit: v === 'on' })}
                  />
                  {f.earlyExit && <Unit inputMode="decimal" value={f.penaltyPct} onChange={(e) => set({ penaltyPct: e.target.value })} unit="%" aria-label="Penalty" />}
                </div>
                {err('penaltyPct') ? (
                  <span className="pl-place-hint error">{err('penaltyPct')}</span>
                ) : (
                  <span className="pl-place-hint">{f.earlyExit ? 'A stake may leave before its epoch ends; the penalty is burned' : 'A stake stays until its epoch ends'}</span>
                )}
              </div>
            )}
          </Step>

          <Step n={3} title="Criteria" desc={staking ? 'Who can take part' : 'What a wallet needs at the end of a UTC day to share it'}>
            {staking ? (
              <p className="pl-launch-muted pl-launch-small">Anyone can stake any amount of {asset?.symbol || 'the token'}. Each epoch&apos;s reward is shared by stake and time in the epoch.</p>
            ) : (
              <Field
                label={f.type === 'nft' ? 'Minimum NFTs per wallet' : f.type === 'traders' ? 'Minimum daily volume' : 'Minimum balance'}
                error={err('criterion')}
                hint={f.type === 'traders' ? 'Buys plus sells in one UTC day. Empty for any trade' : f.type === 'nft' ? 'Counted at the end of each UTC day' : 'At the end of each UTC day. Empty for any balance'}
              >
                <Unit
                  inputMode="decimal"
                  value={f.criterion}
                  onChange={(e) => set({ criterion: f.type === 'nft' ? digits(e.target.value) : decimal(e.target.value) })}
                  placeholder={f.type === 'nft' ? '1' : '0'}
                  unit={f.type === 'nft' ? 'NFTs' : f.type === 'traders' ? quote?.symbol : asset?.symbol}
                  aria-label="Criterion"
                />
              </Field>
            )}
          </Step>
        </form>

        <aside className="pl-launch-new-side">
          <Card className="pl-launch-preview pl-rewards-preview">
            <span className="pl-launch-preview-label">Preview</span>
            <div className="pl-launch-preview-head">
              <PairLogos a={target} b={reward} size={36} />
              <div className="pl-launch-preview-title">
                <span className="pl-rewards-preview-name">{title}</span>
                <span className="pl-launch-muted pl-launch-small">{kind.title}</span>
              </div>
            </div>
            <dl className="pl-launch-summary-kv">
              <div>
                <dt>Starts</dt>
                <dd className="mono">{schedule ? formatUtc(schedule.startsAt) : '—'}</dd>
              </div>
              <div>
                <dt>Ends</dt>
                <dd className="mono">{schedule ? formatUtc(schedule.endsAt) : '—'}</dd>
              </div>
              <div>
                <dt>Epochs</dt>
                <dd className="mono">{schedule ? (staking ? `${schedule.epochs} × ${schedule.epochDays}d` : `${schedule.epochs} × 1 day`) : '—'}</dd>
              </div>
              <div>
                <dt>{staking ? 'Per epoch' : 'Per day'}</dt>
                <dd className="mono">{perText}</dd>
              </div>
              <div>
                <dt>Condition</dt>
                <dd>{conditionLine}</dd>
              </div>
              {staking && (
                <div>
                  <dt>Early withdrawal</dt>
                  <dd>{f.earlyExit ? `${f.penaltyPct || '?'}% penalty` : 'Forbidden'}</dd>
                </div>
              )}
            </dl>
          </Card>

          <Card className="pl-launch-summary">
            <span className="pl-launch-section-title">Funding summary</span>
            <dl className="pl-launch-summary-kv">
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
                    <dt>Place fee</dt>
                    <dd className="mono">{feeBps != null ? `${feeBps / 100}%` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Rewards</dt>
                    <dd className="mono">{per && schedule ? `${amountText(per * BigInt(schedule.epochs), decimals)} ${sym}` : '—'}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>Reward budget</dt>
                    <dd className="mono">{plan.total ? `${amountText(plan.total, decimals)} ${sym}` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Place fee{feeBps != null ? ` ${feeBps / 100}%` : ''}</dt>
                    <dd className="mono">{plan.fee ? `${amountText(plan.fee, decimals)} ${sym}` : '—'}</dd>
                  </div>
                  <div className="pl-rewards-total">
                    <dt>Total</dt>
                    <dd className="mono">{plan.pay ? `${amountText(plan.pay, decimals)} ${sym}` : '—'}</dd>
                  </div>
                  {address && funds.data && (
                    <div>
                      <dt>Your balance</dt>
                      <dd className="mono">
                        {formatAmount(funds.data.balance, decimals, { maxDecimals: 6 })} {sym}
                      </dd>
                    </div>
                  )}
                </>
              )}
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
              {short && <span className="pl-place-hint error">Not enough {sym} in your wallet for the total.</span>}
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
              ? 'Rewards of an epoch go to everyone staked in it, in proportion to amount and time. Claiming earnings and withdrawing the stake are separate. Nobody can take the reward back once the vault is funded.'
              : 'Place builds a public table after every UTC day and publishes it on chain within minutes of 00:00 UTC; wallets claim any time and rewards add up. Whatever is never shared goes back to you 30 days after the last day.'}
          </Alert>
          {f.type === 'nft' && (
            <Alert tone="warn" icon={<AlertTriangle size={16} />}>
              NFT holder rewards are only for collections launched on Place. <Link className="pl-place-link" to="/launch/nft">Launch a collection</Link>
            </Alert>
          )}
        </aside>
      </div>
      {picking && (
        <RewardTokenPicker
          tokens={options}
          value={rewardValue}
          title="Reward currency"
          desc={pool ? `The Community Pool holds ${quote?.symbol || 'its pair asset'}. Any other token is bought with it in the same transaction.` : 'People claim rewards in this token. You send the budget and the Place fee from your wallet.'}
          describe={describe}
          onPick={pickReward}
          onClose={() => setPicking(false)}
          addressSlot={pool ? undefined : (addr, pick) => <AddressReward key={addr} address={addr} describe={describe} onPick={(t) => pick(t)} />}
        />
      )}
    </div>
  );
}
