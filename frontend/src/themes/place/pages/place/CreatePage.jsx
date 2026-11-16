// Create: Holder Rewards and NFT Holder Rewards (form → holder preview → rules and details pinned
// to IPFS → approve for ERC-20 → createCampaign on the active hub), and NFT Collection (NftFactory).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Coins, Image as ImageIcon, Sparkles, Users, AlertTriangle, CheckCircle2, ExternalLink, Info } from 'lucide-react';
import { isAddress, parseAbi, decodeEventLog } from 'viem';
import { PageHeader, Card, Alert, Button, Badge, SectionTitle } from '../../components/ui';
import { useToken, useHolders, usePlaceAccount, usePlaceTx } from '../../../../place/hooks';
import { placeApi } from '../../../../place/api';
import { PLACE_CHAIN, PLACE_CHAIN_ID, placeClient, placeDeployment, placeActiveHub, explorerTx } from '../../../../place/chain';
import { PLACE_HUB_ABI, PLACE_CONFIG_ABI, NFT_FACTORY_ABI } from '../../../../place/abi';
import { planCampaign, planCollection, cappedLeftover, toUtcInput } from '../../../../place/create';
import { formatToken, formatAmount, formatUtc, parseAmount, assetLabel, shortAddress, days as daysText } from '../../../../place/format';
import { TxButton, TxResult, ConnectButton, AddressLink } from './parts';

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE = 600 * 1024;

const KINDS = [
  { id: 'token-holders', title: 'Holder Rewards', desc: 'Reward the holders of any ERC-20 token on Base', Icon: Coins },
  { id: 'nft-holders', title: 'NFT Holder Rewards', desc: 'Reward the holders of any NFT collection on Base', Icon: Users },
  { id: 'collection', title: 'NFT Collection', desc: 'Launch your own collection with a mint page and royalties', Icon: Sparkles },
];

const validAddr = (v) => (isAddress(String(v || '').trim(), { strict: false }) ? String(v).trim().toLowerCase() : null);

function Field({ label, error, hint, children }) {
  return (
    <label className="pl-place-field">
      <span>{label}</span>
      {children}
      {error ? <span className="pl-place-hint error">{error}</span> : hint ? <span className="pl-place-hint">{hint}</span> : null}
    </label>
  );
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(file);
  });
}

function ImageField({ file, setFile }) {
  const [error, setError] = useState(null);
  return (
    <Field label="Banner image (optional)" error={error} hint="PNG, JPEG, WebP or GIF up to 600 KB, 16:9 looks best">
      <input
        type="file"
        accept={IMAGE_TYPES.join(',')}
        onChange={(e) => {
          const f = e.target.files?.[0] || null;
          if (f && (!IMAGE_TYPES.includes(f.type) || f.size > MAX_IMAGE)) {
            setError('Use a PNG, JPEG, WebP or GIF up to 600 KB');
            setFile(null);
            return;
          }
          setError(null);
          setFile(f);
        }}
      />
    </Field>
  );
}

/** Pins name, description and the optional image; returns the metadata ipfs:// URI. */
async function pinDetails({ name, description, file }) {
  let image = null;
  if (file) image = (await placeApi.pinImage({ data: await readFileBase64(file), contentType: file.type })).uri;
  const { uri } = await placeApi.pinMetadata({ name: name.trim(), description: description?.trim() || null, image });
  return uri;
}

/* ── Holder Rewards ─────────────────────────────────────────────────────────────────────────────── */

function useConfigReads(target, account) {
  const config = placeDeployment().config;
  return useQuery({
    queryKey: ['place-config', PLACE_CHAIN_ID, target, account],
    staleTime: 60_000,
    queryFn: async () => {
      const client = placeClient();
      const [feeBps, paused, deployFee] = await Promise.all([
        target
          ? client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'campaignFeeBps', args: [target] })
          : client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'feeBps' }),
        client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'newCampaignsPaused' }),
        account
          ? client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'nftDeployFeeFor', args: [account] })
          : client.readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'nftDeployFee' }),
      ]);
      return { feeBps: Number(feeBps), paused, deployFee };
    },
  });
}

/** What the wallet holds of the reward (ETH or ERC-20) and what it already allows the hub to take. */
function useFunds(account, rewardToken, hub) {
  return useQuery({
    queryKey: ['place-funds', PLACE_CHAIN_ID, account, rewardToken, hub],
    enabled: Boolean(account && rewardToken),
    staleTime: 10_000,
    queryFn: async () => {
      const client = placeClient();
      if (rewardToken === 'eth') return { balance: await client.getBalance({ address: account }), allowance: null };
      const [balance, allowance] = await Promise.all([
        client.readContract({ address: rewardToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
        client.readContract({ address: rewardToken, abi: ERC20_ABI, functionName: 'allowance', args: [account, hub] }),
      ]);
      return { balance, allowance };
    },
  });
}

const holderTypeLabel = { wallet: null, 'smart-account': 'Smart wallet', contract: 'Contract' };

function HolderPreview({ f, set, targetMeta, minRaw, onCount }) {
  const [asked, setAsked] = useState(false);
  const target = validAddr(f.target);
  const params = { target, kind: f.kind, min: minRaw != null ? minRaw.toString() : undefined, limit: 100 };
  const q = useHolders(params, asked && Boolean(target));
  const checked = new Set(f.excludeChecked);
  const toggle = (a) => {
    const next = new Set(checked);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    set({ excludeChecked: [...next] });
  };
  const data = q.data;
  const nft = f.kind === 'nft-holders';
  useEffect(() => {
    if (!data) return;
    const auto = data.top.filter((h) => h.autoExcluded).length;
    onCount(Math.max(0, data.holders - auto - checked.size));
  }, [data, checked.size, onCount]);

  return (
    <Card>
      <SectionTitle
        title="Holders right now"
        count={data ? data.holders : undefined}
        right={
          <Button size="sm" onClick={() => (asked ? q.refetch() : setAsked(true))} disabled={!target || q.isFetching}>
            {q.isFetching ? 'Reading Base...' : data ? 'Refresh' : 'Preview holders'}
          </Button>
        }
      />
      <p className="pl-place-hint" style={{ marginBottom: 12 }}>
        Who would qualify if the snapshot were now. Place always leaves out LP pools, the zero and dead addresses and the hub
        (marked Auto). Contracts such as vesting, staking or bridges are up to you: tick them to exclude them.
      </p>
      {q.isError && <Alert tone="danger" icon={<AlertTriangle size={16} />}>{q.error.message}</Alert>}
      {data && (
        <>
          {data.partial && (
            <Alert tone="warn" icon={<Info size={16} />} style={{ marginBottom: 12 }}>
              A big holder list: this preview read only part of the transfers. The snapshot itself reads all of them.
            </Alert>
          )}
          {data.top.length ? (
            <div className="pl-schedule-card pl-place-holders">
              <div className="pl-schedule-head">
                <span>Exclude</span>
                <span>Holder</span>
                <span>Type</span>
                <span>{nft ? 'NFTs' : 'Balance'}</span>
              </div>
              <div className="pl-schedule-scroll">
                {data.top.map((h) => (
                  <div className="pl-schedule-row" key={h.account}>
                    <span className="pl-place-table-cell">
                      {h.autoExcluded ? (
                        <Badge tone="neutral">Auto</Badge>
                      ) : (
                        <input type="checkbox" aria-label={`Exclude ${h.account}`} checked={checked.has(h.account)} onChange={() => toggle(h.account)} />
                      )}
                    </span>
                    <span className="pl-place-table-cell">
                      <AddressLink address={h.account} />
                    </span>
                    <span className="pl-place-table-cell">
                      {holderTypeLabel[h.type] ? <Badge tone={h.type === 'contract' ? 'warn' : 'accent'}>{holderTypeLabel[h.type]}</Badge> : <span className="pl-place-muted">Wallet</span>}
                    </span>
                    <span className="pl-place-table-cell num">
                      {nft ? h.balance : formatAmount(h.balance, targetMeta?.decimals ?? 18, { compact: true })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="pl-place-hint">Nobody holds the minimum right now.</p>
          )}
          <p className="pl-place-hint" style={{ marginTop: 8 }}>
            Read at block <span className="mono">{data.block}</span>. The top {data.top.length} of {data.holders} holders are shown.
          </p>
        </>
      )}
    </Card>
  );
}

function defaultSnapshot() {
  const t = Math.ceil(Date.now() / 1000 / 3600) * 3600 + 3600;
  return toUtcInput(t);
}

function CampaignForm({ kind }) {
  const [params] = useSearchParams();
  const { address: account, isDemo } = usePlaceAccount();
  const hub = placeActiveHub();
  const [f, setF] = useState(() => ({
    kind,
    target: params.get('target') || '',
    rewardToken: 'eth',
    pool: '',
    minBalance: kind === 'nft-holders' ? '1' : '',
    distribution: 'proportional',
    maxPerWallet: '',
    snapshotAt: defaultSnapshot(),
    claimDays: '30',
    leftover: 'return',
    exclude: '',
    excludeChecked: [],
    name: '',
    description: '',
  }));
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));
  const [file, setFile] = useState(null);
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState(null); // null | 'pin' | 'tx'
  const [pinError, setPinError] = useState(null);
  const [created, setCreated] = useState(null);
  const [eligible, setEligible] = useState(null);
  const tx = usePlaceTx();

  const target = validAddr(f.target);
  const reward = f.rewardToken === 'eth' ? 'eth' : validAddr(f.rewardToken);
  const targetQ = useToken(target);
  const rewardQ = useToken(reward && reward !== 'eth' ? reward : null);
  const cfg = useConfigReads(target, account);
  const funds = useFunds(account, reward, hub);

  const targetMeta = targetQ.data;
  const rewardMeta = reward === 'eth' ? { symbol: 'ETH', decimals: 18 } : rewardQ.data;
  const ctx = {
    chainId: PLACE_CHAIN_ID,
    hub,
    now: Math.floor(Date.now() / 1000),
    feeBps: cfg.data?.feeBps ?? null,
    targetDecimals: targetMeta?.decimals ?? (targetMeta ? 0 : null),
    rewardDecimals: reward === 'eth' ? 18 : rewardMeta?.decimals ?? null,
    isNftTarget: targetMeta ? targetMeta.kind === 'nft' : undefined,
  };
  const plan = planCampaign({ ...f, kind }, ctx);
  const err = (k) => (touched ? plan.errors[k] : null);
  const minRaw =
    kind === 'nft-holders'
      ? /^\d+$/.test(f.minBalance) ? BigInt(f.minBalance) : null
      : targetMeta?.decimals != null ? parseAmount(f.minBalance, targetMeta.decimals) : null;
  const leftover = plan.rules ? cappedLeftover({ pool: plan.pool, maxPerWallet: plan.rules.maxPerWallet, wallets: eligible }) : 0n;
  const shortOfFunds = plan.due != null && funds.data && funds.data.balance < plan.due;
  const needsApprove = plan.due != null && !plan.eth && funds.data?.allowance != null && funds.data.allowance < plan.due;
  const working = phase !== null || tx.busy;

  const submit = async () => {
    setTouched(true);
    setPinError(null);
    if (Object.keys(plan.errors).length || !account) return;
    const createCall = (rulesURI, metadataURI) => ({
      to: hub,
      abi: PLACE_HUB_ABI,
      functionName: 'createCampaign',
      args: [{ ...plan.params, rulesURI, metadataURI }],
      value: plan.eth ? plan.due : 0n,
      label: 'Create campaign',
      preview: {
        action: 'Create and fund campaign',
        amount: formatToken(plan.due, rewardMeta),
        contract: hub,
        contractLabel: 'PlaceHub',
        method: 'createCampaign(params)',
        note: 'Rules and details are uploaded to IPFS first.',
      },
    });
    // Read-only demo: show the transaction without uploading anything.
    if (isDemo) {
      await tx.send(createCall('ipfs://…', 'ipfs://…'));
      return;
    }
    try {
      setPhase('pin');
      const pinned = await placeApi.pinRules(plan.rules);
      if (pinned.rulesHash !== plan.rulesHash) throw new Error('The uploaded rules do not match the rules built here. Nothing was sent.');
      const metadataURI = await pinDetails({ name: f.name, description: f.description, file });
      setPhase('tx');
      const calls = [];
      if (needsApprove || (!plan.eth && funds.data?.allowance == null)) {
        calls.push({ to: plan.params.rewardToken, abi: ERC20_ABI, functionName: 'approve', args: [hub, plan.due], label: 'Approve' });
      }
      calls.push(createCall(pinned.uri, metadataURI));
      const receipt = await tx.send(calls);
      if (receipt) {
        let id = null;
        for (const l of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: PLACE_HUB_ABI, data: l.data, topics: l.topics });
            if (ev.eventName === 'CampaignCreated') id = ev.args.id.toString();
          } catch (e) {
            /* other contracts' logs */
          }
        }
        setCreated({ id, hash: receipt.transactionHash });
      }
    } catch (e) {
      setPinError(e.message);
    } finally {
      setPhase(null);
    }
  };

  if (created) {
    return (
      <Card>
        <Alert tone="success" icon={<CheckCircle2 size={16} />}>
          Campaign created and funded. Place takes the snapshot at {formatUtc(plan.rules?.snapshotAt * 1000)}.
        </Alert>
        <div className="pl-place-actions" style={{ marginTop: 16, justifyContent: 'flex-start' }}>
          {created.id != null && (
            <Button as={Link} to={`/campaign/${hub}/${created.id}`} variant="primary">
              Open campaign #{created.id}
            </Button>
          )}
          <Button as={Link} to="/my">
            My campaigns
          </Button>
          <Button as="a" variant="ghost" href={explorerTx(created.hash)} target="_blank" rel="noopener noreferrer">
            Transaction <ExternalLink size={14} />
          </Button>
        </div>
        <p className="pl-place-hint" style={{ marginTop: 12 }}>
          A new campaign shows up in Explore within a minute or two, once Place has indexed it.
        </p>
      </Card>
    );
  }

  const nft = kind === 'nft-holders';
  const rewardSymbol = rewardMeta?.symbol || 'tokens';
  return (
    <form
      className="pl-place-form pl-place-create"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      {cfg.data?.paused && (
        <Alert tone="warn" icon={<AlertTriangle size={16} />}>
          New campaigns are paused on Place right now. Existing campaigns and claims are not affected.
        </Alert>
      )}
      <Card>
        <fieldset disabled={working}>
          <legend>{nft ? 'Collection' : 'Token'}</legend>
          <Field
            label={nft ? 'NFT collection address' : 'Token address'}
            error={err('target')}
            hint={
              targetMeta ? (
                <>
                  {targetMeta.name || 'Unnamed'} {targetMeta.symbol && `(${targetMeta.symbol})`} · {targetMeta.kind === 'nft' ? 'NFT collection' : 'Token'}
                </>
              ) : target && targetQ.isLoading ? (
                'Reading the contract...'
              ) : (
                'Anyone can reward the holders of any asset, not only its team'
              )
            }
          >
            <input className="mono" value={f.target} onChange={(e) => set({ target: e.target.value, excludeChecked: [] })} placeholder="0x..." spellCheck={false} />
          </Field>
          <Field
            label={nft ? 'Minimum NFTs to qualify' : 'Minimum balance to qualify'}
            error={err('minBalance')}
            hint={nft ? 'Wallets holding fewer NFTs at the snapshot get nothing' : `In ${assetLabel(targetMeta, target) || 'tokens'}, at the snapshot`}
          >
            <input className="mono" inputMode="decimal" value={f.minBalance} onChange={(e) => set({ minBalance: e.target.value })} placeholder={nft ? '1' : '1,000'} />
          </Field>
        </fieldset>
      </Card>

      <Card>
        <fieldset disabled={working}>
          <legend>Reward</legend>
          <div className="pl-place-row2">
            <Field label="Pay rewards in" error={err('rewardToken')} hint={reward && reward !== 'eth' && rewardMeta ? `${rewardMeta.name || ''} (${rewardMeta.symbol})` : null}>
              <select value={f.rewardToken === 'eth' ? 'eth' : 'token'} onChange={(e) => set({ rewardToken: e.target.value === 'eth' ? 'eth' : '' })}>
                <option value="eth">ETH</option>
                <option value="token">An ERC-20 token</option>
              </select>
            </Field>
            {f.rewardToken !== 'eth' && (
              <Field label="Reward token address" error={err('rewardToken')}>
                <input className="mono" value={f.rewardToken} onChange={(e) => set({ rewardToken: e.target.value })} placeholder="0x..." spellCheck={false} />
              </Field>
            )}
          </div>
          <div className="pl-place-row2">
            <Field label={`Pool, ${rewardSymbol}`} error={err('pool')} hint="Shared by every eligible wallet">
              <input className="mono" inputMode="decimal" value={f.pool} onChange={(e) => set({ pool: e.target.value })} placeholder="0.0" />
            </Field>
            <Field label={`Max per wallet, ${rewardSymbol} (optional)`} error={err('maxPerWallet')} hint="What a capped wallet leaves goes to the others">
              <input className="mono" inputMode="decimal" value={f.maxPerWallet} onChange={(e) => set({ maxPerWallet: e.target.value })} placeholder="No limit" />
            </Field>
          </div>
          <div className="pl-place-row2">
            <Field label="Split">
              <select value={f.distribution} onChange={(e) => set({ distribution: e.target.value })}>
                <option value="proportional">{nft ? 'In proportion to NFTs held' : 'In proportion to balance'}</option>
                <option value="equal">Equal for every wallet</option>
              </select>
            </Field>
            <Field label="What nobody claims">
              <select value={f.leftover} onChange={(e) => set({ leftover: e.target.value })}>
                <option value="return">Returns to me</option>
                <option value="burn">Is burned</option>
              </select>
            </Field>
          </div>
        </fieldset>
      </Card>

      <Card>
        <fieldset disabled={working}>
          <legend>Timing</legend>
          <div className="pl-place-row2">
            <Field label="Snapshot, UTC" error={err('snapshotAt')} hint="Balances at this moment decide who gets what">
              <input type="datetime-local" className="mono" value={f.snapshotAt} onChange={(e) => set({ snapshotAt: e.target.value })} />
            </Field>
            <Field label="Claim window, days" error={err('claimDays')} hint="Counted from when Place publishes the table; you can extend it later">
              <input className="mono" inputMode="numeric" value={f.claimDays} onChange={(e) => set({ claimDays: e.target.value })} />
            </Field>
          </div>
        </fieldset>
      </Card>

      <HolderPreview f={{ ...f, kind }} set={set} targetMeta={targetMeta} minRaw={minRaw} onCount={setEligible} />

      <Card>
        <fieldset disabled={working}>
          <legend>Exclusions</legend>
          <Field label="More addresses to exclude (optional)" error={err('exclude')} hint={`One per line or separated by commas. ${f.excludeChecked.length} ticked in the preview.`}>
            <textarea className="mono" value={f.exclude} onChange={(e) => set({ exclude: e.target.value })} placeholder="0x..." spellCheck={false} />
          </Field>
        </fieldset>
      </Card>

      <Card>
        <fieldset disabled={working}>
          <legend>Details</legend>
          <Field label="Name" error={err('name')}>
            <input value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder={nft ? 'Holder rewards for my collection' : 'November holder rewards'} />
          </Field>
          <Field label="Description (optional)" error={err('description')}>
            <textarea value={f.description} maxLength={2000} onChange={(e) => set({ description: e.target.value })} placeholder="Why holders get this reward" />
          </Field>
          <ImageField file={file} setFile={setFile} />
        </fieldset>
      </Card>

      <Card>
        <h2 className="pl-place-card-title">Summary</h2>
        <dl className="pl-place-kv pl-place-summary">
          <div>
            <dt>Pool</dt>
            <dd className="mono">{plan.pool != null ? formatToken(plan.pool, rewardMeta) : '—'}</dd>
          </div>
          <div>
            <dt>Place fee ({cfg.data ? `${cfg.data.feeBps / 100}%` : '...'})</dt>
            <dd className="mono">{plan.fee != null ? formatToken(plan.fee, rewardMeta) : '—'}</dd>
          </div>
          <div>
            <dt>You send</dt>
            <dd className="mono pl-place-strong">{plan.due != null ? formatToken(plan.due, rewardMeta) : '—'}</dd>
          </div>
          <div>
            <dt>Snapshot</dt>
            <dd>{plan.rules ? formatUtc(plan.rules.snapshotAt * 1000) : '—'}</dd>
          </div>
          <div>
            <dt>Claim window</dt>
            <dd>{plan.rules ? daysText(plan.rules.claimDuration) : '—'}</dd>
          </div>
          <div>
            <dt>Excluded by you</dt>
            <dd className="mono">{plan.rules ? plan.rules.exclude.length : '—'}</dd>
          </div>
        </dl>
        <div className="pl-place-stack" style={{ marginTop: 14, gap: 10 }}>
          {leftover > 0n && (
            <Alert tone="warn" icon={<AlertTriangle size={16} />}>
              With {eligible} eligible wallets and this limit per wallet, {formatToken(leftover, rewardMeta)} cannot be handed out. It will be{' '}
              {f.leftover === 'burn' ? 'burned' : 'returned to you'} at the end.
            </Alert>
          )}
          {shortOfFunds && (
            <Alert tone="danger" icon={<AlertTriangle size={16} />}>
              This wallet holds {formatToken(funds.data.balance, rewardMeta)}, less than {formatToken(plan.due, rewardMeta)}.
            </Alert>
          )}
          <Alert tone="info" icon={<Info size={16} />}>
            You can cancel before the snapshot (the pool comes back, the fee does not). If Place publishes no table within 72 hours of
            the snapshot, you take back the pool and the fee. Rules can not change after creation.
          </Alert>
          {touched && plan.errors.form && <p className="pl-place-hint">{plan.errors.form}</p>}
          {touched && Object.keys(plan.errors).length > 0 && !plan.errors.form && <p className="pl-place-hint error">Fix the fields marked above.</p>}
          {pinError && <Alert tone="danger" icon={<AlertTriangle size={16} />}>{pinError}</Alert>}
          <TxResult tx={tx} success="Campaign created" />
          {working && (
            <ol className="pl-place-steps">
              <li className={phase === 'tx' ? 'done' : ''}>Upload rules and details to IPFS</li>
              {!plan.eth && <li className={needsApprove ? '' : 'done'}>Allow PlaceHub to take {formatToken(plan.due, rewardMeta)}</li>}
              <li>Create and fund the campaign</li>
            </ol>
          )}
        </div>
        <div className="pl-place-actions" style={{ marginTop: 16 }}>
          {account ? (
            <TxButton
              tx={{ ...tx, busy: working, status: phase === 'pin' ? 'pending' : tx.status }}
              size="lg"
              onClick={submit}
              disabled={cfg.data?.paused || shortOfFunds}
              busyLabel={phase === 'pin' ? 'Uploading to IPFS...' : tx.step === 'Approve' ? 'Approving...' : 'Creating on Base...'}
            >
              {needsApprove ? 'Approve and create' : 'Create campaign'}
            </TxButton>
          ) : (
            <ConnectButton size="lg">Connect wallet to create</ConnectButton>
          )}
        </div>
      </Card>
    </form>
  );
}

/* ── NFT Collection ─────────────────────────────────────────────────────────────────────────────── */

function CollectionForm() {
  const { address: account, isDemo } = usePlaceAccount();
  const factory = placeDeployment().nftFactory.address;
  const [f, setF] = useState({
    name: '',
    symbol: '',
    maxSupply: '1000',
    maxPerWallet: '',
    paymentToken: 'eth',
    price: '0',
    mintStart: '',
    payout: '',
    burnPct: '',
    burnToken: '',
    swapPoolFee: '3000',
    royaltyPct: '5',
    royaltyReceiver: '',
    baseURI: '',
    description: '',
  });
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));
  const [file, setFile] = useState(null);
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState(null);
  const [pinError, setPinError] = useState(null);
  const [created, setCreated] = useState(null);
  const tx = usePlaceTx();
  const cfg = useConfigReads(null, account);
  const payToken = f.paymentToken === 'eth' ? null : validAddr(f.paymentToken);
  const payQ = useToken(payToken);
  const payMeta = f.paymentToken === 'eth' ? { symbol: 'ETH', decimals: 18 } : payQ.data;

  const form = { ...f, payout: f.payout || account || '' };
  const plan = planCollection(form, { chainId: PLACE_CHAIN_ID, now: Math.floor(Date.now() / 1000), deployFee: cfg.data?.deployFee ?? null, paymentDecimals: payMeta?.decimals ?? null });
  const err = (k) => (touched ? plan.errors[k] : null);
  const working = phase !== null || tx.busy;

  const submit = async () => {
    setTouched(true);
    setPinError(null);
    if (Object.keys(plan.errors).length || !account) return;
    const call = (contractURI) => ({
      to: factory,
      abi: NFT_FACTORY_ABI,
      functionName: 'createCollection',
      args: [{ ...plan.params, contractURI }],
      value: plan.fee,
      label: 'Create collection',
      preview: { action: 'Deploy NFT collection', amount: formatToken(plan.fee, { symbol: 'ETH', decimals: 18 }), contract: factory, contractLabel: 'NftFactory', method: 'createCollection(params)' },
    });
    if (isDemo) {
      await tx.send(call(''));
      return;
    }
    try {
      let contractURI = '';
      if (f.description.trim() || file) {
        setPhase('pin');
        contractURI = await pinDetails({ name: plan.params.name, description: f.description, file });
      }
      setPhase('tx');
      const receipt = await tx.send(call(contractURI));
      if (receipt) {
        let collection = null;
        for (const l of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: NFT_FACTORY_ABI, data: l.data, topics: l.topics });
            if (ev.eventName === 'CollectionCreated') collection = ev.args.collection.toLowerCase();
          } catch (e) {
            /* other logs */
          }
        }
        setCreated({ collection, hash: receipt.transactionHash });
      }
    } catch (e) {
      setPinError(e.message);
    } finally {
      setPhase(null);
    }
  };

  if (created) {
    return (
      <Card>
        <Alert tone="success" icon={<CheckCircle2 size={16} />}>
          Collection deployed{created.collection ? ` at ${shortAddress(created.collection)}` : ''}. You own it: set prices, the mint start and
          royalties from your wallet.
        </Alert>
        <div className="pl-place-actions" style={{ marginTop: 16, justifyContent: 'flex-start' }}>
          {created.collection && (
            <Button as={Link} to={`/token/${created.collection}`} variant="primary">
              Open collection
            </Button>
          )}
          <Button as="a" variant="ghost" href={explorerTx(created.hash)} target="_blank" rel="noopener noreferrer">
            Transaction <ExternalLink size={14} />
          </Button>
        </div>
      </Card>
    );
  }

  const sym = payMeta?.symbol || 'tokens';
  return (
    <form
      className="pl-place-form pl-place-create"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <Card>
        <fieldset disabled={working}>
          <legend>Collection</legend>
          <div className="pl-place-row2">
            <Field label="Name" error={err('name')}>
              <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Club" />
            </Field>
            <Field label="Symbol" error={err('symbol')}>
              <input value={f.symbol} onChange={(e) => set({ symbol: e.target.value.toUpperCase() })} placeholder="CLUB" />
            </Field>
          </div>
          <div className="pl-place-row2">
            <Field label="Supply" error={err('maxSupply')} hint="Fixed for good">
              <input className="mono" inputMode="numeric" value={f.maxSupply} onChange={(e) => set({ maxSupply: e.target.value })} />
            </Field>
            <Field label="Max per wallet (optional)" error={err('maxPerWallet')} hint="Empty for no limit">
              <input className="mono" inputMode="numeric" value={f.maxPerWallet} onChange={(e) => set({ maxPerWallet: e.target.value })} placeholder="No limit" />
            </Field>
          </div>
          <Field label="Description (optional)">
            <textarea value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What holders get" />
          </Field>
          <ImageField file={file} setFile={setFile} />
          <Field label="Token metadata base URI (optional)" error={err('baseURI')} hint="ipfs://.../ with one JSON per token ID; you can set it later until you freeze it">
            <input className="mono" value={f.baseURI} onChange={(e) => set({ baseURI: e.target.value })} placeholder="ipfs://" spellCheck={false} />
          </Field>
        </fieldset>
      </Card>

      <Card>
        <fieldset disabled={working}>
          <legend>Mint</legend>
          <div className="pl-place-row2">
            <Field label="Pay with" error={err('paymentToken')}>
              <select value={f.paymentToken === 'eth' ? 'eth' : 'token'} onChange={(e) => set({ paymentToken: e.target.value === 'eth' ? 'eth' : '' })}>
                <option value="eth">ETH</option>
                <option value="token">An ERC-20 token</option>
              </select>
            </Field>
            {f.paymentToken !== 'eth' && (
              <Field label="Payment token address" error={err('paymentToken')} hint={payMeta ? `${payMeta.name || ''} (${payMeta.symbol})` : null}>
                <input className="mono" value={f.paymentToken} onChange={(e) => set({ paymentToken: e.target.value })} placeholder="0x..." spellCheck={false} />
              </Field>
            )}
          </div>
          <div className="pl-place-row2">
            <Field label={`Price per NFT, ${sym}`} error={err('price')} hint="0 for a free mint; you can change it until the first mint">
              <input className="mono" inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} />
            </Field>
            <Field label="Mint opens, UTC (optional)" error={err('mintStart')} hint="Empty to open right away">
              <input type="datetime-local" className="mono" value={f.mintStart} onChange={(e) => set({ mintStart: e.target.value })} />
            </Field>
          </div>
          <Field label="Revenue goes to" error={err('payout')} hint="Fixed at creation; defaults to your wallet">
            <input className="mono" value={f.payout} onChange={(e) => set({ payout: e.target.value })} placeholder={account || '0x...'} spellCheck={false} />
          </Field>
        </fieldset>
      </Card>

      <Card>
        <fieldset disabled={working}>
          <legend>Buyback and royalties</legend>
          <div className="pl-place-row2">
            <Field label="Buy back and burn, % of each mint (optional)" error={err('burnPct')} hint="Bought through Uniswap and burned">
              <input className="mono" inputMode="decimal" value={f.burnPct} onChange={(e) => set({ burnPct: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Token to burn" error={err('burnToken')}>
              <input className="mono" value={f.burnToken} onChange={(e) => set({ burnToken: e.target.value })} placeholder="0x..." disabled={!Number(f.burnPct)} spellCheck={false} />
            </Field>
          </div>
          {Number(f.burnPct) > 0 && f.paymentToken !== f.burnToken && (
            <Field label="Uniswap pool fee tier">
              <select value={f.swapPoolFee} onChange={(e) => set({ swapPoolFee: e.target.value })}>
                <option value="500">0.05%</option>
                <option value="3000">0.3%</option>
                <option value="10000">1%</option>
              </select>
            </Field>
          )}
          <div className="pl-place-row2">
            <Field label="Royalty, %" error={err('royaltyPct')} hint="Up to 10%, changeable later">
              <input className="mono" inputMode="decimal" value={f.royaltyPct} onChange={(e) => set({ royaltyPct: e.target.value })} />
            </Field>
            <Field label="Royalty receiver" error={err('royaltyReceiver')}>
              <input className="mono" value={f.royaltyReceiver} onChange={(e) => set({ royaltyReceiver: e.target.value })} placeholder={form.payout || '0x...'} spellCheck={false} />
            </Field>
          </div>
        </fieldset>
      </Card>

      <Card>
        <h2 className="pl-place-card-title">Summary</h2>
        <dl className="pl-place-kv pl-place-summary">
          <div>
            <dt>Collection</dt>
            <dd>{plan.params ? `${plan.params.name} (${plan.params.symbol})` : '—'}</dd>
          </div>
          <div>
            <dt>Mint</dt>
            <dd className="mono">{plan.params ? `${plan.params.maxSupply} × ${formatToken(plan.params.price, payMeta)}` : '—'}</dd>
          </div>
          <div>
            <dt>Deploy fee</dt>
            <dd className="mono">{cfg.data ? formatToken(cfg.data.deployFee, { symbol: 'ETH', decimals: 18 }) : '...'}</dd>
          </div>
        </dl>
        <div className="pl-place-stack" style={{ marginTop: 14, gap: 10 }}>
          {touched && Object.keys(plan.errors).length > 0 && !plan.errors.form && <p className="pl-place-hint error">Fix the fields marked above.</p>}
          {pinError && <Alert tone="danger" icon={<AlertTriangle size={16} />}>{pinError}</Alert>}
          <TxResult tx={tx} success="Collection deployed" />
        </div>
        <div className="pl-place-actions" style={{ marginTop: 16 }}>
          {account ? (
            <TxButton tx={{ ...tx, busy: working, status: phase === 'pin' ? 'pending' : tx.status }} size="lg" onClick={submit} busyLabel={phase === 'pin' ? 'Uploading to IPFS...' : 'Deploying on Base...'}>
              Create collection
            </TxButton>
          ) : (
            <ConnectButton size="lg">Connect wallet to create</ConnectButton>
          )}
        </div>
      </Card>
    </form>
  );
}

export default function CreatePage() {
  const { kind: routeKind } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const kind = KINDS.some((k) => k.id === routeKind) ? routeKind : KINDS.some((k) => k.id === params.get('kind')) ? params.get('kind') : null;
  const choose = (id) => navigate(`/create/${id}${params.get('target') && id !== 'collection' ? `?target=${params.get('target')}` : ''}`);

  return (
    <div className="pl-place-create-page">
      <PageHeader title="Create" description={`Reward the holders of any token or NFT on ${PLACE_CHAIN.name}, or launch an NFT collection`} />
      <div className="pl-place-create-kinds" role="group" aria-label="What to create">
        {KINDS.map(({ id, title, desc, Icon }) => (
          <button key={id} type="button" className="card card-hover pl-place-kind" aria-pressed={kind === id} onClick={() => choose(id)}>
            <span className="pl-place-kind-title">
              <Icon size={16} color="var(--accent)" />
              {title}
            </span>
            <span className="pl-place-kind-desc">{desc}</span>
          </button>
        ))}
      </div>
      {kind === 'collection' ? (
        <CollectionForm key="collection" />
      ) : kind ? (
        <CampaignForm key={kind} kind={kind} />
      ) : (
        <Card>
          <p className="pl-place-hint">
            <ImageIcon size={14} /> Pick what to create. Campaigns are funded in one transaction (plus an approval for ERC-20 rewards), and
            Place computes the snapshot and publishes the table for you.
          </p>
        </Card>
      )}
    </div>
  );
}

