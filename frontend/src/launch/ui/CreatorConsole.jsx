// Profile (/profile/:section): Launches (tokens this wallet launched, then the snapshot campaigns it created),
// NFT launches (its collections and the token each is paired with), Fees, Rewards (staking it takes part in and
// what it can claim, with the hub's filters: Staking / Holders / Traders / NFT holders) and Profile settings
// (signed by the wallet, stored by the API). Old sections redirect: campaigns → launches, nfts → nft-launches.
// Fees per release: 0.3.0 → VaultPanelV3 (creator revenue, Community Pool campaigns, automatic campaign);
// 0.2.0 → VaultPanel (fees, daily burn, community fund, raising the shares); 0.1.0 → FeeRow (buyback, rewards pool).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useWallets } from '@privy-io/react-auth';
import { connectedWallet } from '../../config/walletTx';
import { toHex, isAddress } from 'viem';
import { ArrowLeft, ImagePlus, Save, Loader2, Wallet, Search, ArrowUpRight, Rocket, Coins, UserRound, Flame, Gift, CheckCircle2, AlertTriangle, Clock, Image as ImageIcon } from 'lucide-react';
import { Button, Card, Badge, EmptyState, Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, CopyAddress, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { explorerAddress } from '../../place/chain';
import { formatAmount, formatUtc, shortAddress } from '../../place/format';
import { launchApi } from '../client.js';
import { useLaunchTokens, useCreator, useProfile, launchKeys } from '../hooks.js';
import { CREATOR_VAULT_ABI } from '../abi.js';
import { cleanProfile, profileMessage, PROFILE_LIMITS } from '../profile.js';
import { uploadImage, imageProblem } from '../image.js';
import { ipfsUrl } from '../../place/format';
import { TokenLogo, launchTokenPath, launchNewPath, consolePath } from './parts.jsx';
import { VaultPanel } from './VaultPanel.jsx';
import { VaultPanelV3 } from './VaultPanelV3.jsx';
import { ProfileRewards } from './ProfileRewards.jsx';
import { ProfileNfts } from './ProfileNfts.jsx';
import MyCampaigns from '../../themes/place/pages/place/MyCampaignsPage.jsx';
import { LEGACY_SECTIONS } from '../profileRewards.js';
import { money } from './TokenCard.jsx';
import { age } from '../format.js';
import { tokenEconomy } from '../economy.js';
import { useLaunchLive, useLiveTokens } from '../live.js';

const SECTIONS = [
  { id: 'launches', label: 'Launches', Icon: Rocket },
  { id: 'nft-launches', label: 'NFT launches', Icon: ImageIcon },
  { id: 'fees', label: 'Fees', Icon: Coins },
  { id: 'rewards', label: 'Rewards', Icon: Gift },
  { id: 'settings', label: 'Profile settings', Icon: UserRound },
];

function Avatar({ profile, address, size = 56 }) {
  const [broken, setBroken] = useState(false);
  const url = profile?.avatar ? ipfsUrl(profile.avatar) : null;
  if (url && !broken) return <img className="pl-launch-avatar" src={url} alt="" style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  return (
    <span className="pl-launch-avatar empty" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {(profile?.name || address || '?').replace(/^0x/, '').slice(0, 1).toUpperCase()}
    </span>
  );
}

// ─────────────────────────────── profile settings ───────────────────────────────

function ProfileSettings({ address, profile }) {
  const { wallets } = useWallets();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', avatar: '', website: '', x: '', telegram: '', bio: '' });
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [state, setState] = useState({ status: 'idle', error: null });
  const fileInput = useRef(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current || profile === undefined) return;
    loaded.current = true;
    if (profile) {
      setForm({
        name: profile.name || '',
        avatar: profile.avatar || '',
        website: profile.website || '',
        x: profile.x ? `x.com/${profile.x}` : '',
        telegram: profile.telegram ? `t.me/${profile.telegram}` : '',
        bio: profile.bio || '',
      });
    }
  }, [profile]);

  let problem = null;
  try {
    cleanProfile(form);
  } catch (e) {
    problem = e.message;
  }
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    if (state.status !== 'busy') setState({ status: 'idle', error: null });
  };

  const pickAvatar = async (file) => {
    if (!file) return;
    const bad = imageProblem(file);
    if (bad) return setState({ status: 'error', error: bad });
    setAvatarPreview(URL.createObjectURL(file));
    setState({ status: 'uploading', error: null });
    try {
      const uri = await uploadImage(file);
      setForm((f) => ({ ...f, avatar: uri }));
      setState({ status: 'idle', error: null });
    } catch (e) {
      setAvatarPreview(null);
      setState({ status: 'error', error: `Upload failed: ${e.message}` });
    }
  };

  const save = async () => {
    setState({ status: 'busy', error: null });
    try {
      const clean = cleanProfile(form);
      const wallet = connectedWallet(wallets, address);
      const issuedAt = new Date().toISOString();
      const message = profileMessage({ address, profile: clean, issuedAt });
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
      const r = await launchApi.saveProfile({ address, profile: clean, issuedAt, signature });
      queryClient.setQueryData(launchKeys.profile(address), r);
      setState({ status: 'saved', error: null });
    } catch (e) {
      const rejected = e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '');
      setState(rejected ? { status: 'idle', error: null } : { status: 'error', error: e?.message || 'Could not save the profile' });
    }
  };

  const avatarSrc = avatarPreview || (form.avatar ? ipfsUrl(form.avatar) : null);
  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head">
        <h2 className="pl-launch-console-title">Profile settings</h2>
        <p className="pl-launch-section-desc">Shown on your tokens and your public creator profile. Saving asks your wallet to sign a message: no transaction, no gas.</p>
      </div>
      <Card className="pl-launch-avatar-card">
        <button type="button" className="pl-launch-avatar-btn" onClick={() => fileInput.current?.click()} aria-label="Change avatar">
          {avatarSrc ? <img src={avatarSrc} alt="" /> : <Avatar profile={null} address={address} size={64} />}
          {state.status === 'uploading' && (
            <span className="pl-launch-logo-busy">
              <Loader2 size={18} className="spin" />
            </span>
          )}
        </button>
        <div className="pl-launch-logo-text">
          <Button size="sm" type="button" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={15} />
            Change avatar
          </Button>
          <span className="pl-place-hint">PNG, JPG, WEBP or GIF. We crop it to a square.</span>
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => pickAvatar(e.target.files?.[0])} />
      </Card>
      <form className="pl-place-form pl-launch-profile-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="pl-launch-two even">
          <label className="pl-place-field">
            <span className="pl-launch-field-label">
              Name <span className="pl-launch-counter">{form.name.length}/{PROFILE_LIMITS.name}</span>
            </span>
            <input value={form.name} onChange={set('name')} maxLength={PROFILE_LIMITS.name} placeholder="Launch creator" />
          </label>
          <label className="pl-place-field">
            <span className="pl-launch-field-label">Website</span>
            <input value={form.website} onChange={set('website')} placeholder="yourproject.xyz" />
          </label>
          <label className="pl-place-field">
            <span className="pl-launch-field-label">X</span>
            <input value={form.x} onChange={set('x')} placeholder="x.com/yourprofile" />
          </label>
          <label className="pl-place-field">
            <span className="pl-launch-field-label">Telegram</span>
            <input value={form.telegram} onChange={set('telegram')} placeholder="t.me/yourprofile" />
          </label>
        </div>
        <label className="pl-place-field">
          <span className="pl-launch-field-label">
            Bio <span className="pl-launch-counter">{form.bio.length}/{PROFILE_LIMITS.bio}</span>
          </span>
          <textarea value={form.bio} onChange={set('bio')} maxLength={PROFILE_LIMITS.bio} placeholder="A short intro shown on your public creator profile" />
        </label>
        {problem && <span className="pl-place-hint error">{problem}</span>}
        <div className="pl-launch-profile-actions">
          <Button type="submit" variant="primary" disabled={Boolean(problem) || state.status === 'busy' || state.status === 'uploading'}>
            {state.status === 'busy' ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {state.status === 'busy' ? 'Sign in your wallet...' : 'Save profile'}
          </Button>
          {profile?.updatedAt && <span className="pl-place-hint">Last saved {formatUtc(profile.updatedAt)}</span>}
        </div>
        {state.status === 'saved' && (
          <Alert tone="success" icon={<CheckCircle2 size={16} />}>
            Profile saved.
          </Alert>
        )}
        {state.status === 'error' && (
          <Alert tone="danger" icon={<AlertTriangle size={16} />}>
            {state.error}
          </Alert>
        )}
      </form>
    </div>
  );
}

// ─────────────────────────────── launches ───────────────────────────────

function Launches({ address, now }) {
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const { data, isLoading, error, refetch } = useLaunchTokens({ creator: address, sort: 'new', limit: 100, includeHidden: '1' });
  const live = useLiveTokens(data?.tokens, data?.indexedBlock);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return live.filter(
      (t) => (tab === 'all' || t.quote.category === tab) && (!s || t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s) || t.address.includes(s))
    );
  }, [live, tab, q]);
  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Launches</h2>
          <p className="pl-launch-section-desc">Tokens you launched. Claim their earnings in Fees.</p>
        </div>
        <div className="seg soft" role="tablist">
          {['all', 'crypto', 'stocks'].map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'all' ? 'All' : id === 'crypto' ? 'Crypto' : 'Stocks'}
            </button>
          ))}
        </div>
      </div>
      <label className="pl-launch-search wide">
        <Search size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search launches" aria-label="Search launches" />
      </label>
      {error ? (
        <QueryError error={error} retry={refetch} />
      ) : isLoading ? (
        <Skeleton height={120} count={2} />
      ) : list.length ? (
        <div className="pl-launch-launches">
          {list.map((t) => (
            <Link key={t.address} to={launchTokenPath(t.address)} className="card card-hover pl-launch-launch">
              <div className="pl-launch-launch-head">
                <TokenLogo token={t} size={40} />
                <div className="pl-launch-launch-title">
                  <span className="pl-launch-strong">{t.name}</span>
                  <span className="pl-launch-muted">
                    {t.symbol}/{t.quote.symbol}
                  </span>
                </div>
                <ArrowUpRight size={16} className="pl-launch-muted" />
              </div>
              <div className="pl-launch-launch-nums">
                <span>
                  <span className="pl-launch-muted">MC </span>
                  <span className="mono pl-launch-strong">{money(t.marketCapUsd, t.marketCap, t.quote.symbol)}</span>
                </span>
                <span>
                  <span className="pl-launch-muted">Vol 24h </span>
                  <span className="mono">{money(t.volume24hUsd, t.volume24h, t.quote.symbol)}</span>
                </span>
                <span>
                  <span className="pl-launch-muted">Holders </span>
                  <span className="mono">{t.holders}</span>
                </span>
              </div>
              <div className="pl-launch-launch-foot">
                <span className="pl-launch-inline">
                  <Badge tone="accent">Launched by you</Badge>
                  <ReleaseBadge t={t} />
                </span>
                <span className="pl-launch-muted pl-launch-age">
                  <Clock size={12} />
                  Created {age(t.createdAt, now)} ago
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Rocket size={28} />}
            title={data?.tokens?.length ? 'No launches match' : 'No launches yet'}
            description={data?.tokens?.length ? 'Try another name or tab.' : 'Tokens you launch from this wallet show up here, with their fees in Fees.'}
            action={
              !data?.tokens?.length && (
                <Button as={Link} to={launchNewPath()} variant="primary">
                  Launch token
                </Button>
              )
            }
          />
        </Card>
      )}
    </div>
  );
}

/** Standard / Economy for 0.3.0, the release for older tokens. */
function ReleaseBadge({ t }) {
  if (t.generation >= 3) {
    const e = tokenEconomy(t);
    return <Badge tone="neutral">{e?.type === 'economy' ? `Economy ${e.buyTax}/${e.sellTax}%` : 'Standard'}</Badge>;
  }
  return <Badge tone="neutral">{t.version || (t.generation === 2 ? '0.2.0' : '0.1.0')}</Badge>;
}

// ─────────────────────────────── fees ───────────────────────────────

/** "CampaignTooSoon(1795183733)" → a sentence for people. */
function campaignReason(reason, rewards, quote) {
  if (!reason) return null;
  const soon = reason.match(/CampaignTooSoon\((\d+)\)/);
  if (soon) return `Next campaign from ${formatUtc(Number(soon[1]) * 1000)}`;
  if (/RewardsBelowMinimum/.test(reason)) return `The pool needs at least ${formatAmount(rewards.minimum, quote.decimals)} ${quote.symbol}`;
  if (/rewards disabled/.test(reason)) return 'Holder rewards are off for this token';
  return reason.length > 80 ? 'Not possible right now' : reason;
}

function PayoutForm({ vault, current }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const tx = usePlaceTx({ onSuccess: () => setOpen(false) });
  const valid = isAddress(value.trim());
  return (
    <div className="pl-launch-payout">
      <span className="pl-launch-muted">
        Paid to <a className="pl-place-link mono" href={explorerAddress(current)} target="_blank" rel="noopener noreferrer">{shortAddress(current)}</a>
      </span>
      {open ? (
        <div className="pl-launch-payout-form">
          <input className="pl-place-input mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="New payout wallet, 0x..." spellCheck={false} aria-label="Payout wallet" />
          <TxButton tx={tx} size="sm" variant="secondary" disabled={!valid} onClick={() => tx.send({ label: 'Change payout wallet', to: vault, abi: CREATOR_VAULT_ABI, functionName: 'setPayoutAddress', args: [value.trim()] })}>
            Save
          </TxButton>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Change
        </Button>
      )}
      <TxResult tx={tx} success="Payout wallet changed" />
    </div>
  );
}

function FeeRow({ item }) {
  const t = item.token;
  const v = item.vault;
  const q = t.quote;
  const claimTx = usePlaceTx();
  const campaignTx = usePlaceTx();
  const fmtQ = (raw) => `${formatAmount(raw, q.decimals, { maxDecimals: 6 })} ${q.symbol}`;
  const fmtT = (raw) => `${formatAmount(raw, 18, { maxDecimals: 2 })} ${t.symbol}`;
  const c = v.claim;
  const nothing = !c.error && BigInt(c.paid || 0) === 0n && BigInt(c.boughtBack || 0) === 0n;
  const r = v.rewards;
  const reason = r.canStartAsCreator ? null : campaignReason(r.reason, r, q);
  const progress = Math.min(100, (Number(r.available) / Math.max(1, Number(r.minimum))) * 100);
  return (
    <Card className="pl-launch-fee">
      <div className="pl-launch-fee-head">
        <TokenLogo token={t} size={40} />
        <div className="pl-launch-launch-title">
          <Link to={launchTokenPath(t.address)} className="pl-launch-strong pl-launch-fee-name">
            {t.name}
          </Link>
          <span className="pl-launch-muted">
            {t.symbol}/{q.symbol}
          </span>
        </div>
        <PayoutForm vault={v.address} current={v.payout} />
      </div>

      <div className="pl-launch-fee-grid">
        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Wallet size={14} /> Your fees
          </span>
          {c.error ? (
            <span className="pl-place-hint error">Claim check failed: {c.error}</span>
          ) : (
            <>
              <span className="pl-launch-fee-value mono">{fmtQ(c.paid)}</span>
              <span className="pl-launch-fee-sub">
                {BigInt(c.boughtBack || 0) > 0n ? (
                  <>
                    <Flame size={12} /> plus a buyback of <span className="mono">{fmtQ(c.buybackQuoteIn)}</span> → about <span className="mono">{fmtT(c.boughtBack)}</span>, {c.buybackTo === 'burn' ? 'burned' : 'sent to you'}. At least{' '}
                    <span className="mono">{fmtT(c.minOut)}</span> with {c.slippageBps / 100}% slippage.
                  </>
                ) : (
                  'No buyback in this claim'
                )}
              </span>
            </>
          )}
          <TxButton
            tx={claimTx}
            size="sm"
            disabled={Boolean(c.error) || nothing}
            busyLabel="Claiming on Base..."
            onClick={() => claimTx.send({ label: 'Claim fees', to: c.tx.to, data: c.tx.data, value: 0n })}
          >
            {nothing ? 'Nothing to claim yet' : 'Claim'}
          </TxButton>
          <TxResult tx={claimTx} success="Claimed" />
        </div>

        <div className="pl-launch-fee-block">
          <span className="pl-launch-fee-label">
            <Gift size={14} /> Holder rewards pool (0.1.0)
          </span>
          <span className="pl-launch-fee-value mono">{fmtQ(r.available)}</span>
          <div className="pl-launch-fee-progress" aria-label="Pool toward the campaign minimum">
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className="pl-launch-fee-sub">
            Minimum <span className="mono">{fmtQ(r.minimum)}</span>
            {r.lastCampaignAt ? ` · last campaign ${formatUtc(r.lastCampaignAt)}` : ''}
          </span>
          <TxButton
            tx={campaignTx}
            size="sm"
            variant="secondary"
            disabled={!r.canStartAsCreator}
            busyLabel="Starting on Base..."
            onClick={() => campaignTx.send({ label: 'Start rewards campaign', to: r.tx.to, data: r.tx.data, value: 0n })}
          >
            Start rewards campaign
          </TxButton>
          {reason && <span className="pl-place-hint">{reason}</span>}
          <TxResult tx={campaignTx} success="Campaign created in the Place hub" />
        </div>
      </div>

      {item.totals && (
        <div className="pl-launch-fee-totals">
          <span>
            Collected <span className="mono">{fmtQ(item.totals.collected)}</span>
          </span>
          <span>
            Paid to you <span className="mono">{fmtQ(item.totals.creatorPaid)}</span>
          </span>
          <span>
            Bought back <span className="mono">{fmtT(item.totals.boughtBackTokens)}</span>
          </span>
          <span>
            To holders <span className="mono">{fmtQ(item.totals.toCampaigns)}</span> in {item.totals.campaigns} campaigns
          </span>
        </div>
      )}
    </Card>
  );
}

function Fees({ address }) {
  const [slippage, setSlippage] = useState(300);
  const { data, isLoading, error, refetch, isFetching } = useCreator(address, slippage);
  const mine = (data?.tokens || []).filter((x) => x.vault);
  const anyLegacy = mine.some((x) => x.vault.version === 'legacy');
  const former = (data?.tokens || []).filter((x) => !x.vault);
  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Fees</h2>
          <p className="pl-launch-section-desc">
            Your share of every trade waits in each token&apos;s vault. Claim it here, and turn the Community Pool into rewards for your holders and traders.
          </p>
        </div>
        {anyLegacy && <div className="pl-launch-slippage">
          <span className="pl-launch-field-label">Buyback slippage, 0.1.0 tokens {isFetching && <Loader2 size={12} className="spin" />}</span>
          <div className="seg soft">
            {[100, 300, 500].map((s) => (
              <button key={s} type="button" aria-selected={slippage === s} onClick={() => setSlippage(s)}>
                {s / 100}%
              </button>
            ))}
          </div>
        </div>}
      </div>
      {error ? (
        <QueryError error={error} retry={refetch} />
      ) : isLoading ? (
        <Skeleton height={220} count={2} />
      ) : mine.length ? (
        <div className="pl-launch-fees">
          {mine.map((item) =>
            item.vault.version === 'legacy' ? (
              <FeeRow key={item.token.address} item={item} />
            ) : item.vault.version === 'v3' ? (
              <VaultPanelV3 key={item.token.address} item={item} PayoutForm={PayoutForm} />
            ) : (
              <VaultPanel key={item.token.address} item={item} PayoutForm={PayoutForm} />
            )
          )}
        </div>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Coins size={28} />}
            title="No fees to claim"
            description="Fees build up from trades on tokens you launched. Launch one and its earnings show up here."
            action={
              <Button as={Link} to={launchNewPath()} variant="primary">
                Launch token
              </Button>
            }
          />
        </Card>
      )}
      {former.length > 0 && <p className="pl-place-hint">{former.length} token(s) you launched now belong to another creator, so their fees go to them.</p>}
    </div>
  );
}

// ─────────────────────────────── page ───────────────────────────────

export default function CreatorConsole() {
  useLaunchLive();
  const { section } = useParams();
  const active = SECTIONS.some((s) => s.id === section) ? section : 'rewards';
  const { address } = usePlaceAccount();
  const now = useNow(60_000);
  const profileQ = useProfile(address);
  const profile = profileQ.isSuccess ? profileQ.data?.profile || null : undefined;

  if (LEGACY_SECTIONS[section]) return <Navigate to={`${consolePath(LEGACY_SECTIONS[section])}${window.location.search}`} replace />;

  if (!address) {
    return (
      <div className="pl-launch">
        <header className="page-header">
          <h1 className="page-title">Profile</h1>
          <p className="page-desc">Your rewards, your launches, their fees and your public profile</p>
        </header>
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<UserRound size={28} />}
            title="Connect your wallet"
            description="Your profile shows the rewards this wallet can claim, the tokens it launched and their fees, and lets you edit your public profile."
            action={<ConnectButton />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="pl-launch pl-launch-console">
      <Link to="/" className="pl-place-back">
        <ArrowLeft size={14} />
        Launchpad
      </Link>
      <header className="pl-launch-console-top">
        <Avatar profile={profile} address={address} />
        <div className="pl-launch-console-id">
          <h1 className="page-title">{profile?.name || 'Profile'}</h1>
          <span className="pl-launch-inline start">
            <a className="pl-place-link mono" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer">
              {shortAddress(address)}
            </a>
            <CopyAddress address={address} />
          </span>
        </div>
        <Button as={Link} to="/wallet" size="sm">
          <Wallet size={15} />
          Wallet assets
        </Button>
      </header>

      <div className="pl-launch-console-cols">
        <div className="pl-launch-console-nav" role="navigation" aria-label="Profile">
          {SECTIONS.map(({ id, label, Icon }) => (
            <NavLink key={id} to={consolePath(id)} className={() => `pl-launch-console-link-item ${active === id ? 'active' : ''}`.trim()}>
              <Icon size={16} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </div>
        <div className="pl-launch-console-main">
          {active === 'settings' ? (
            <ProfileSettings key={address} address={address} profile={profile} />
          ) : active === 'fees' ? (
            <Fees address={address} />
          ) : active === 'rewards' ? (
            <ProfileRewards address={address} />
          ) : active === 'nft-launches' ? (
            <ProfileNfts address={address} />
          ) : (
            <>
              <Launches address={address} now={now} />
              <MyCampaigns embedded />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
