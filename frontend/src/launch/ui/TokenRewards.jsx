// Token page tabs about rewards: Holder rewards and Trader rewards (one status sentence, four
// figures, the countdown to the next 00:00 UTC payout and Claim rewards), Staking (the token's staking vaults), NFT
// (collections paired with the token) and Campaigns (rewards beyond the token's own economy: Community Pool and
// wallet-funded streams, snapshot campaigns). Staking, NFT and Campaigns use the hub's cards.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Coins, ArrowUpRight, BadgeCheck, Image as ImageIcon } from 'lucide-react';
import { Badge, Button, EmptyState } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useCampaigns } from '../../place/hooks';
import { formatAmount } from '../../place/format';
import { useRewards, useHubStreams, useCollection } from '../hooks.js';
import { NFT_COLLECTION_ABI } from '../nftAbi.js';
import { MINT_STATUS, POOL_DAYS, poolNumbers, collectionPath } from '../nft.js';
import { TokenLogo } from './parts.jsx';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { STREAM_LABEL } from '../economy.js';
import { compact, amount } from '../format.js';
import { units } from './TokenEconomy.jsx';
import { HubCard, hubItems } from './HubPage.jsx';
import { PHASE_ORDER, amountText } from './vaults.jsx';

/** "1,234.5 USDC" for a raw amount of a reward token ({ symbol, decimals }). */
export const rewardText = (raw, r) => `${formatAmount(raw || 0, r?.decimals ?? 18, { maxDecimals: 6 })} ${r?.symbol || ''}`.trim();

/** "05h 12m 03s" until the next 00:00 UTC. */
export function untilMidnight(now) {
  const day = 86_400_000;
  const left = Math.max(0, day - (now % day));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(left / 3_600_000))}h ${pad(Math.floor((left % 3_600_000) / 60_000))}m ${pad(Math.floor((left % 60_000) / 1000))}s`;
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

/** One sentence: whether the wallet meets the stream's rule right now, and what is missing. */
function statusText(kind, stream, today, t, address) {
  if (!address) return 'Connect your wallet to see your rewards. Rewards for each UTC day are shared after 00:00 UTC.';
  if (!today) return 'Checking your wallet…';
  const need = BigInt(stream.criterion || 0);
  if (kind === 'holders') {
    const have = BigInt(today.balance || 0);
    if (have >= need && have > 0n) return `You qualify for today's holder rewards with ${compact(units(have, 18, 2))} ${t.symbol}.`;
    return `Hold ${compact(units(need - have, 18, 2))} ${t.symbol} more at 00:00 UTC to qualify for today's rewards.`;
  }
  const have = BigInt(today.volume || 0);
  const q = t.quote;
  if (need === 0n) return have > 0n ? "You qualify for today's trader rewards." : 'Buy or sell any amount today to qualify for trader rewards.';
  if (have >= need) return `You qualify for today's trader rewards with ${amount(units(have, q.decimals), q.symbol)} traded.`;
  return `You traded ${amount(units(have, q.decimals), q.symbol)} today. Trade ${amount(units(need - have, q.decimals), q.symbol)} more to qualify.`;
}

/** Holder rewards or Trader rewards of an Economy token. */
export function RewardsTab({ data, kind, now }) {
  const t = data.token;
  const q = t.quote;
  const { address } = usePlaceAccount();
  const mine = useRewards(address, t.address);
  const tx = usePlaceTx();
  const stream = (data.rewards || []).find((s) => s.economy && s.kind === kind);
  const holders = kind === 'holders';
  if (!stream) {
    return <EmptyState title="Rewards start with the first day" description="The first payout opens after the first UTC day of trading closes at 00:00 UTC." />;
  }
  const r = stream.rewardToken;
  const item = (mine.data?.rewards || []).find((x) => x.streamId === stream.id);
  const pending = (mine.data?.pending || []).find((p) => p.streamId === stream.id);
  const claimable = BigInt(item?.claimable || 0);
  const earned = BigInt(item?.cumulative || 0) + BigInt(pending?.amount || 0);
  const short = (raw) => `${amountText(raw || 0, r.decimals)} ${r.symbol || ''}`.trim();
  const value = (raw) => (address ? (mine.isLoading ? '…' : short(raw)) : short(0));
  const figures = [
    ['Claimable rewards', value(String(claimable))],
    ['Total earned', value(String(earned))],
    holders
      ? ['Minimum holding', `${compact(units(stream.criterion, 18, 0))} ${t.symbol}`]
      : ['Minimum daily volume', BigInt(stream.criterion || 0) > 0n ? amount(units(stream.criterion, q.decimals), q.symbol) : 'Any trade'],
    ['Rewards claimed', value(item?.claimed)],
  ];
  return (
    <div className="pl-launch-tab-body">
      <p className="pl-launch-section-desc">{statusText(kind, stream, mine.data?.today, t, address)}</p>
      <dl className="pl-launch-plain-grid">
        {figures.map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="pl-launch-next-payout">
        Next payout in <span className="mono pl-launch-strong">{untilMidnight(now)}</span> <span className="pl-launch-muted">at 00:00 UTC</span>
      </p>
      <div className="pl-launch-tab-actions">
        {address ? (
          <TxButton tx={tx} disabled={claimable === 0n} busyLabel="Claiming on Base..." onClick={() => tx.send(claimCall(item, address))}>
            Claim rewards
          </TxButton>
        ) : (
          <ConnectButton>Connect wallet</ConnectButton>
        )}
      </div>
      <TxResult tx={tx} success="Rewards claimed" />
    </div>
  );
}

// ─────────────────────────────── Staking / NFT / Campaigns ───────────────────────────────

/** Who counts as official for this token: its fee vault, Community Pool and creators. */
const officialSet = (data) => new Set([data.token.vault, data.communityVault, data.token.creator, data.token.originalCreator].filter(Boolean));

/** Staking vaults of this token that have not ended: the number on the Staking tab. */
export const activeStaking = (data) => (data.staking || []).filter((p) => p.status !== 'ended').length;

const byPhase = (a, b) => (PHASE_ORDER[a.status] ?? 9) - (PHASE_ORDER[b.status] ?? 9);

function CardGrid({ items }) {
  return (
    <div className="pl-vaults-grid pl-launch-staking-grid">
      {items.map((it) => (
        <HubCard key={it.key} it={it} />
      ))}
    </div>
  );
}

function HubLinks({ create, createLabel, hub }) {
  return (
    <div className="pl-launch-tab-actions">
      <Button as={Link} to={create}>
        {createLabel}
      </Button>
      <Button as={Link} to={hub} variant="ghost">
        Open in Rewards hub
        <ArrowUpRight size={15} />
      </Button>
    </div>
  );
}

export function StakingTab({ data }) {
  const t = data.token;
  const staking = data.staking || [];
  const vaults = officialSet(data);
  // A vault funded by the token's creator is marked as theirs.
  const items = hubItems([], staking)
    .map((it, i) => (it.source === 'community' && vaults.has(staking[i].creator) ? { ...it, source: 'creator' } : it))
    .sort(byPhase);
  return (
    <div className="pl-launch-tab-body">
      {items.length ? (
        <CardGrid items={items} />
      ) : (
        <EmptyState icon={<Coins size={28} />} title="No staking vaults yet" description={`Anyone can fund a staking vault for ${t.symbol}: stakers share a fixed reward every epoch.`} />
      )}
      <HubLinks create={`/create?type=staking&token=${t.address}`} createLabel="Create staking vault" hub={`/hub?type=staking&token=${t.address}`} />
    </div>
  );
}

/** The NFT tab: a dashboard of the paired collection's 30-day holders pool, the wallet's NFTs and Claim. */
export function NftTab({ token, collections, now }) {
  const sorted = [...collections].sort((a, b) => Number(b.official) - Number(a.official));
  const [pick, setPick] = useState(null);
  const current = sorted.find((c) => c.address === pick) || sorted[0];
  if (!current) {
    return (
      <div className="pl-launch-tab-body">
        <EmptyState
          icon={<ImageIcon size={28} />}
          title="No NFT collection yet"
          description={`Anyone can launch a collection paired with ${token.symbol}. Its holders share a ${POOL_DAYS}-day rewards pool.`}
        />
        <div className="pl-launch-tab-actions">
          <Button as={Link} to="/launch/nft">
            <ImageIcon size={15} />
            Launch NFT
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="pl-launch-tab-body">
      {sorted.length > 1 && (
        <div className="seg soft pl-launch-nft-pick" role="tablist" aria-label="Collection">
          {sorted.map((c) => (
            <button key={c.address} type="button" role="tab" aria-selected={c.address === current.address} onClick={() => setPick(c.address)}>
              {c.symbol || c.name}
            </button>
          ))}
        </div>
      )}
      <NftDashboard key={current.address} base={current} now={now} />
    </div>
  );
}

function NftDashboard({ base, now }) {
  const { address } = usePlaceAccount();
  const q = useCollection(base.address, address);
  const tx = usePlaceTx();
  const c = q.data?.collection || base;
  const live = q.data?.live;
  const you = q.data?.you;
  const r = c.rewardToken || { symbol: 'ETH', decimals: 18 };
  const pool = poolNumbers(live?.perDay != null ? { ...c.pool, ...live } : c.pool, r.decimals);
  const st = MINT_STATUS[c.status] || MINT_STATUS.live;
  const ids = you?.ids || [];
  const claimable = you?.claimable != null ? BigInt(you.claimable) : null;
  const claimIds = ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id));
  const sym = r.symbol || '';
  const mine = (v) => (address ? (q.isLoading ? '…' : v) : '—');
  const figures = [
    ['Rewards pool', `${compact(pool.left)} ${sym}`, pool.active ? `Paid out over ${pool.daysLeft} more days` : 'Fills with every mint and royalty'],
    ['Paid per day', `${compact(pool.perDay)} ${sym}`, pool.active ? `${compact(pool.perNftPerDay)} ${sym} per NFT` : null],
    ['Accrued today', `${compact(pool.accruedToday)} ${sym}`, 'Shared at 00:00 UTC'],
    ['Your NFTs', mine(ids.length.toLocaleString('en-US')), `of ${Number(c.totalMinted || 0).toLocaleString('en-US')} minted`],
    ['You can claim', mine(claimable == null ? '—' : `${formatAmount(claimable, r.decimals ?? 18, { maxDecimals: 6 })} ${sym}`), null],
  ];
  return (
    <>
      <div className="pl-launch-nft-head">
        <TokenLogo token={{ symbol: c.symbol, name: c.name, contractURI: c.contractURI }} size={44} />
        <div className="pl-launch-nft-title">
          <Link className="pl-launch-strong pl-launch-nft-name" to={collectionPath(c.address)}>
            {c.name || 'Collection'}
          </Link>
          <span className="pl-launch-inline start">
            <Badge tone={st.tone}>{st.label}</Badge>
            {c.official && (
              <Badge tone="accent">
                <BadgeCheck size={11} /> Official
              </Badge>
            )}
            <span className="pl-launch-muted pl-launch-small">{c.kind === 'edition' ? 'Edition' : 'Unique'}</span>
          </span>
        </div>
        <Button as={Link} to={collectionPath(c.address)} variant="ghost" size="sm">
          Open collection
          <ArrowUpRight size={15} />
        </Button>
      </div>
      <p className="pl-launch-section-desc">
        Rewards for holders of this NFT collection. Every mint and royalty adds {sym} to a {POOL_DAYS}-day pool; each day at 00:00 UTC the day&apos;s part is shared equally by every NFT.
      </p>
      <dl className="pl-launch-plain-grid pl-launch-nft-figures">
        {figures.map(([label, v, sub]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{v}</dd>
            {sub && <dd className="pl-launch-nft-sub">{sub}</dd>}
          </div>
        ))}
      </dl>
      <p className="pl-launch-next-payout">
        Next epoch in <span className="mono pl-launch-strong">{untilMidnight(now)}</span> <span className="pl-launch-muted">at 00:00 UTC</span>
      </p>
      <div className="pl-launch-tab-actions">
        {address ? (
          <TxButton
            tx={tx}
            disabled={!claimable || claimable === 0n || !claimIds.length}
            busyLabel="Claiming on Base..."
            onClick={() => tx.send({ label: 'Claim NFT holder rewards', to: c.address, abi: NFT_COLLECTION_ABI, functionName: 'claim', args: [claimIds] })}
          >
            Claim rewards
          </TxButton>
        ) : (
          <ConnectButton>Connect wallet</ConnectButton>
        )}
        <Button as={Link} to="/launch/nft" variant="ghost">
          <ImageIcon size={15} />
          Launch NFT
        </Button>
      </div>
      <TxResult tx={tx} success="Rewards claimed" />
    </>
  );
}

/**
 * Rewards for this token beyond its own economy streams: Community Pool or wallet-funded streams on the token, streams
 * its Community Pool funded for other targets (an NFT holders campaign of a paired collection) and snapshot campaigns.
 * The page uses it to decide whether the Campaigns tab shows at all.
 */
export function useTokenCampaigns(data) {
  const t = data.token;
  const { address } = usePlaceAccount();
  const streams = useHubStreams(address ? { account: address } : {});
  const snapshots = useCampaigns({ status: 'all', target: t.address, limit: 50 });
  const pool = data.communityVault;
  const extra = (streams.data?.streams || []).filter((s) => s.source !== 'economy' && (s.token?.address === t.address || (pool && s.funder === pool)));
  const items = hubItems(extra, [], snapshots.data?.campaigns || []).sort(byPhase);
  return { items, isLoading: streams.isLoading || snapshots.isLoading };
}

export function CampaignsTab({ data, campaigns }) {
  const t = data.token;
  return (
    <div className="pl-launch-tab-body">
      {campaigns.items.length ? <CardGrid items={campaigns.items} /> : <EmptyState icon={<Coins size={28} />} title="No campaigns yet" description="Campaigns funded by the Community Pool, the creator or anyone else show up here." />}
      <HubLinks create={`/create?token=${t.address}`} createLabel="Create campaign" hub={`/hub?token=${t.address}`} />
    </div>
  );
}
