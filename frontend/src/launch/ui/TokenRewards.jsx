// Token page tabs about rewards: Rewards (the daily holder and trader streams of an Economy token, what this
// wallet can claim, the last days), Staking / Campaigns (official programs from the economy or the community pool,
// and programs from anyone else) and Updates (the creator's on-chain announcements).
import { Link } from 'react-router-dom';
import { Gift, BarChart3, Coins, ArrowUpRight, ExternalLink, Megaphone, Clock } from 'lucide-react';
import { Badge, Button, EmptyState, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, StatusBadge, Skeleton, campaignPath } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, countdown, shortAddress, ipfsUrl } from '../../place/format';
import { useRewards } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { STREAM_LABEL } from '../economy.js';
import { compact } from '../format.js';
import { units, quoteText } from './TokenEconomy.jsx';

const STREAM_ICON = { holders: Gift, traders: BarChart3 };
const STATUS = { live: 'Live', upcoming: 'Upcoming', ended: 'Ended' };
const TABLE_STATUS = {
  published: ['Published', 'success'],
  sent: ['Publishing', 'accent'],
  built: ['Publishing', 'accent'],
  empty: ['No one eligible, rolls over', 'neutral'],
  failed: ['Retrying', 'warn'],
};

/** "1,234.5 USDC" for a raw amount of a reward token ({ symbol, decimals }). */
export const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

/** What the stream asks of a wallet, in words. */
function criterionText(s, t) {
  if (s.kind === 'holders') return `Hold at least ${compact(units(s.criterion, 18, 0))} ${t.symbol} at the end of the UTC day`;
  if (s.kind === 'traders') return BigInt(s.criterion || 0) > 0n ? `Buy and sell at least ${quoteText(s.criterion, t.quote)} in a UTC day` : 'Any buy or sell in the UTC day';
  return null;
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

function YourReward({ stream, mine, pending, account, loading }) {
  const tx = usePlaceTx();
  const r = stream.rewardToken;
  if (!account) {
    return (
      <div className="pl-launch-your-reward">
        <span className="pl-launch-muted pl-launch-small">Connect wallet to see what you can claim.</span>
        <ConnectButton size="sm" />
      </div>
    );
  }
  if (loading) return <Skeleton height={56} />;
  const claimable = BigInt(mine?.claimable || 0);
  return (
    <div className="pl-launch-your-reward">
      <div className="pl-launch-your-reward-num">
        <span className="pl-launch-muted pl-launch-small">You can claim</span>
        <span className="mono pl-launch-strong">{rewardText(mine?.claimable, r)}</span>
        {pending && <span className="pl-launch-muted pl-launch-small mono">+{rewardText(pending.amount, r)} being published</span>}
        {mine && BigInt(mine.claimed || 0) > 0n && <span className="pl-launch-muted pl-launch-small mono">Claimed so far {rewardText(mine.claimed, r)}</span>}
      </div>
      <TxButton tx={tx} size="sm" disabled={claimable === 0n} busyLabel="Claiming on Base..." onClick={() => tx.send(claimCall(mine, account))}>
        {claimable === 0n ? 'Nothing to claim yet' : 'Claim'}
      </TxButton>
      <TxResult tx={tx} success="Rewards claimed" />
    </div>
  );
}

function StreamCard({ stream, t, mine, pending, account, loading, now }) {
  const Icon = STREAM_ICON[stream.kind] || Gift;
  const r = stream.rewardToken;
  const converting = BigInt(stream.pendingConversion || 0) > 0n;
  return (
    <div className="pl-launch-stream">
      <div className="pl-launch-stream-head">
        <span className={`pl-launch-stream-icon ${stream.kind}`}>
          <Icon size={16} />
        </span>
        <div className="pl-launch-stream-title">
          <span className="pl-launch-strong">{STREAM_LABEL[stream.kind] || stream.kind}</span>
          <span className="pl-launch-muted pl-launch-small">{criterionText(stream, t)}</span>
        </div>
        <StatusBadge status={STATUS[stream.status] || stream.status} />
      </div>
      <div className="pl-launch-tab-tiles">
        <Tile label="Shared so far" value={compact(units(stream.allocated, r.decimals, 6))} sub={r.symbol} />
        <Tile label="Claimed" value={compact(units(stream.claimed, r.decimals, 6))} sub={r.symbol} />
        <Tile label="Waiting for the next day" value={compact(units(stream.unallocated, r.decimals, 6))} sub={converting ? `+${quoteText(stream.pendingConversion, t.quote)} to swap` : r.symbol} />
        <Tile label="Next day closes in" value={countdown(stream.nextCloseAt, now).replace(/ \d+s$/, '')} sub={formatUtc(stream.nextCloseAt)} />
      </div>
      <YourReward stream={stream} mine={mine} pending={pending} account={account} loading={loading} />
      {stream.epochs?.length > 0 && (
        <div className="pl-launch-table pl-launch-days">
          <div className="pl-launch-table-head pl-launch-days-grid">
            <span>Day (UTC)</span>
            <span className="num">Collected</span>
            <span className="num">Shared</span>
            <span className="num">Wallets</span>
            <span>Table</span>
          </div>
          {stream.epochs.map((e) => {
            const [label, tone] = e.table ? TABLE_STATUS[e.table.status] || [e.table.status, 'neutral'] : ['Waiting', 'neutral'];
            return (
              <div key={e.epoch} className="pl-launch-table-row pl-launch-days-grid">
                <span className="mono">{e.day}</span>
                <span className="num mono">{compact(units(e.collected, t.quote.decimals), { decimals: 6 })} {t.quote.symbol}</span>
                <span className="num mono">{e.table?.budget && e.table.status !== 'empty' ? `${compact(units(e.table.budget, r.decimals, 6))} ${r.symbol || ''}` : '—'}</span>
                <span className="num mono">{e.table?.eligible ?? '—'}</span>
                <span className="pl-launch-inline">
                  <Badge tone={tone}>{label}</Badge>
                  {e.table?.uri && (
                    <a className="pl-place-link" href={ipfsUrl(e.table.uri)} target="_blank" rel="noopener noreferrer" aria-label={`Table of ${e.day}`}>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RewardsTab({ data, econ, now }) {
  const t = data.token;
  const { address } = usePlaceAccount();
  const mine = useRewards(address, t.address);
  const allTx = usePlaceTx();
  const streams = (data.rewards || []).filter((s) => s.economy);
  if (!streams.length) {
    const has = econ && (econ.shares.holders > 0 || econ.shares.traders > 0);
    return (
      <EmptyState
        icon={<Gift size={26} />}
        title={has ? 'Rewards start with the first day' : 'No daily rewards'}
        description={
          has
            ? 'The holder and trader rewards of this token open after its first UTC day of trading closes.'
            : 'This token sends no part of its tax to holders or traders. Campaigns and staking for it show on Staking / Campaigns.'
        }
      />
    );
  }
  const items = new Map((mine.data?.rewards || []).map((r) => [r.streamId, r]));
  const pending = new Map((mine.data?.pending || []).map((p) => [p.streamId, p]));
  const due = (mine.data?.rewards || []).filter((r) => r.claimable !== '0');
  return (
    <div className="pl-launch-tab-body">
      <div className="pl-launch-section-head">
        <p className="pl-launch-section-desc">
          Every UTC day the tax of the holder and trader buckets is shared between eligible wallets, in proportion to their balance or volume. Claim any time: rewards add up and never expire.
        </p>
        {due.length > 1 && mine.data?.claimMany?.length > 0 && (
          <TxButton
            tx={allTx}
            size="sm"
            busyLabel="Claiming on Base..."
            onClick={() => allTx.send(mine.data.claimMany.map((c) => ({ label: 'Claim all rewards', to: c.to, data: c.data, value: 0n })))}
          >
            Claim all
          </TxButton>
        )}
      </div>
      <TxResult tx={allTx} success="Rewards claimed" />
      {streams.map((s) => (
        <StreamCard key={s.id} stream={s} t={t} mine={items.get(s.id)} pending={pending.get(s.id)} account={address} loading={mine.isLoading} now={now} />
      ))}
    </div>
  );
}

// ─────────────────────────────── Staking / Campaigns ───────────────────────────────

function StreamRow({ s }) {
  const r = s.rewardToken;
  const Icon = STREAM_ICON[s.kind] || Gift;
  return (
    <Link to={`/hub?stream=${s.id}`} className="pl-launch-hub-row">
      <span className="pl-launch-inline">
        <Icon size={13} />
        {s.economy ? `Daily ${s.kind === 'traders' ? 'trader' : 'holder'} rewards from the tax` : `${STREAM_LABEL[s.kind] || s.kind}${s.official ? ' from the community pool' : ''}`}
      </span>
      <span className="pl-launch-hub-row-right">
        <span className="mono">{s.economy ? `${compact(units(s.allocated, r.decimals, 6))} ${r.symbol || ''} shared` : `${compact(units(s.rewardPerEpoch, r.decimals, 6))} ${r.symbol || ''} a day × ${s.epochCount}`}</span>
        {!s.official && s.funder && <span className="mono pl-launch-muted">by {shortAddress(s.funder)}</span>}
        <StatusBadge status={STATUS[s.status] || s.status} />
      </span>
    </Link>
  );
}

function CampaignRow({ c, t }) {
  const q = t.quote;
  const pool =
    c.rewardToken === q.address
      ? `${formatAmount(c.pool, q.decimals)} ${q.symbol}`
      : c.rewardToken === t.address
        ? `${compact(units(c.pool, 18, 0))} ${t.symbol}`
        : c.rewardSymbol
          ? `${compact(units(c.pool, c.rewardDecimals ?? 18, 6), { decimals: 6 })} ${c.rewardSymbol}`
          : shortAddress(c.rewardToken);
  return (
    <Link to={campaignPath(c)} className="pl-launch-hub-row">
      <span>
        Holder campaign #{c.id}
        {c.fromVault && <span className="pl-launch-muted"> · community fund</span>}
      </span>
      <span className="pl-launch-hub-row-right">
        <span className="mono">{pool}</span>
        <StatusBadge status={c.status} />
      </span>
    </Link>
  );
}

function StakingRow({ p }) {
  return (
    <Link to={`/staking?program=${p.id}`} className="pl-launch-hub-row">
      <span className="pl-launch-inline">
        <Coins size={13} />
        Staking: {compact(units(p.rewardPerEpoch, p.rewardToken.decimals, 4))} {p.rewardToken.symbol} per epoch
      </span>
      <span className="pl-launch-hub-row-right">
        <span className="mono pl-launch-muted">
          {p.epochCount} × {Math.round(p.epochDuration / 3600)}h
        </span>
        <StatusBadge status={p.status === 'live' ? 'Live' : p.status === 'ended' ? 'Ended' : 'Upcoming'} />
      </span>
    </Link>
  );
}

export function CampaignsTab({ data, econ }) {
  const t = data.token;
  const streams = data.rewards || [];
  const campaigns = data.campaigns || [];
  const staking = data.staking || [];
  const vaults = new Set([t.vault, data.communityVault, t.creator, t.originalCreator].filter(Boolean));
  const officialStaking = (p) => p.fromLaunchVault || vaults.has(p.creator);
  const official = [
    ...streams.filter((s) => s.official).map((s) => <StreamRow key={s.id} s={s} />),
    ...campaigns.filter((c) => c.section !== 'community').map((c) => <CampaignRow key={`${c.hub}-${c.id}`} c={c} t={t} />),
    ...staking.filter(officialStaking).map((p) => <StakingRow key={p.id} p={p} />),
  ];
  const community = [
    ...streams.filter((s) => !s.official).map((s) => <StreamRow key={s.id} s={s} />),
    ...campaigns.filter((c) => c.section === 'community').map((c) => <CampaignRow key={`${c.hub}-${c.id}`} c={c} t={t} />),
    ...staking.filter((p) => !officialStaking(p)).map((p) => <StakingRow key={p.id} p={p} />),
  ];
  const pool = econ?.shares.community > 0;
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">
        {pool
          ? `Part of every trade fills a community ${econ.generation === 2 ? 'fund' : 'pool'}. The creator turns it into reward campaigns and staking programs for this token, never into their own wallet. Anyone can also start one.`
          : 'Reward campaigns and staking programs for this token. Anyone can start one in the Rewards hub.'}
      </p>
      <span className="pl-launch-field-label">Official</span>
      {official.length ? <div className="pl-launch-hub-list">{official}</div> : <p className="pl-launch-muted pl-launch-small">Nothing from the token&apos;s economy or its creator yet.</p>}
      <span className="pl-launch-field-label">From the community</span>
      {community.length ? <div className="pl-launch-hub-list">{community}</div> : <p className="pl-launch-muted pl-launch-small">No campaigns or staking from other wallets yet.</p>}
      <div className="pl-launch-tab-actions">
        <Button as={Link} to={`/create?token=${t.address}`}>Create vault / campaign</Button>
        <Button as={Link} to={`/hub?token=${t.address}`}>
          Open in Rewards hub
          <ArrowUpRight size={15} />
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────── Updates ───────────────────────────────

/** A link from an announcement, only when it is http(s) or IPFS (it comes from the chain, so anyone could write it). */
const safeLink = (uri) => (/^ipfs:\/\//.test(uri || '') ? ipfsUrl(uri) : /^https?:\/\//i.test(uri || '') ? uri : null);

export function UpdatesTab({ data, now }) {
  const list = data.announcements || [];
  if (!list.length) {
    return <EmptyState icon={<Megaphone size={26} />} title="No updates yet" description="The creator posts updates on-chain from the creator console. They show up here." />;
  }
  return (
    <div className="pl-launch-updates">
      {list.map((a) => (
        <article key={a.id || a.tx} className="pl-launch-update">
          <span className="pl-launch-muted pl-launch-small pl-launch-inline">
            <Clock size={12} /> {formatUtc(a.at, { now: new Date(now) })}
          </span>
          <p>{a.description}</p>
          <span className="pl-launch-inline">
            {safeLink(a.uri) && (
              <a className="pl-place-link pl-launch-small" href={safeLink(a.uri)} target="_blank" rel="noopener noreferrer nofollow">
                Read more <ExternalLink size={12} />
              </a>
            )}
            {a.tx && (
              <a className="pl-place-link pl-launch-small" href={explorerTx(a.tx)} target="_blank" rel="noopener noreferrer">
                Transaction <ExternalLink size={12} />
              </a>
            )}
          </span>
        </article>
      ))}
    </div>
  );
}
