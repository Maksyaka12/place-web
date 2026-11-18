// Shared pieces of the NFT launchpad pages: the collection card (Projects, project pages, profile, Rewards), the
// Collections section of a project page, the economy ring and table of a collection, and NFT images from metadata.
import { Link } from 'react-router-dom';
import { BadgeCheck, Image as ImageIcon, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ProgressBar } from '../../themes/place/components/ui';
import { QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { useIpfsJson } from '../../place/hooks';
import { formatAmount, ipfsUrl } from '../../place/format';
import { useCollections } from '../hooks.js';
import { NFT_BUCKETS, NFT_PLATFORM_PCT, MINT_STATUS, economyPct, paymentPct, poolNumbers, collectionPath } from '../nft.js';
import { compact } from '../format.js';
import { TokenArt, Stat } from './parts.jsx';
import { AllocationRing } from './EconomyFields.jsx';

export const RING_BUCKETS = [{ id: 'platform', tone: 'platform', label: 'Place' }, ...NFT_BUCKETS];

export const ethText = (wei, maxDecimals = 6) => `${formatAmount(BigInt(wei || 0), 18, { maxDecimals })} ETH`;

/** The metadata JSON link of NFT `id` (Unique: folder + id + suffix; Edition: the one link). */
export function tokenUri(c, id) {
  if (!c?.baseURI) return null;
  return c.kind === 'edition' ? c.baseURI : `${c.baseURI}${id}${c.uriSuffix || ''}`;
}

/** One NFT's image from its metadata (ipfs:// metadata only; https metadata is not fetched). */
export function NftImage({ c, id, className = 'pl-collection-nft-img' }) {
  const uri = tokenUri(c, id);
  const meta = useIpfsJson(uri);
  const url = meta.data?.image ? ipfsUrl(meta.data.image) : null;
  if (url) return <img className={className} src={url} alt={meta.data?.name || `#${id}`} loading="lazy" />;
  return (
    <span className={`${className} empty`} aria-hidden="true">
      {meta.isLoading ? null : <ImageIcon size={20} />}
    </span>
  );
}

export function CollectionCard({ c }) {
  const st = MINT_STATUS[c.status] || MINT_STATUS.live;
  const pool = poolNumbers(c.pool, c.rewardToken?.decimals);
  const max = c.maxSupply || 0;
  return (
    <Link to={collectionPath(c.address)} className="card card-hover pl-launch-card pl-collection-card" data-testid="collection-card">
      <div className="pl-launch-art">
        <TokenArt token={{ contractURI: c.contractURI, symbol: c.symbol, name: c.name }} />
        <div className="pl-launch-art-overlay" />
        <div className="pl-launch-art-badges">
          <Badge tone={st.tone}>{st.label}</Badge>
          {c.official && (
            <Badge tone="accent">
              <BadgeCheck size={11} /> Official
            </Badge>
          )}
        </div>
        <div className="pl-launch-art-title">
          <span className="pl-launch-art-name">{c.name || 'Collection'}</span>
          <span className="pl-launch-art-symbol">{c.symbol}</span>
        </div>
      </div>
      <div className="pl-launch-card-body">
        <div className="pl-launch-card-mc">
          <span className="pl-launch-card-mc-value mono">{BigInt(c.mintPrice || 0) > 0n ? ethText(c.mintPrice) : 'Free'}</span>
          <span className="pl-launch-card-mc-label">mint</span>
        </div>
        <div className="pl-collection-card-progress">
          <ProgressBar value={c.totalMinted} max={max || Math.max(c.totalMinted, 1)} />
          <span className="pl-launch-muted pl-launch-small mono">
            {c.totalMinted.toLocaleString('en-US')} / {max ? max.toLocaleString('en-US') : 'open'}
          </span>
        </div>
        <div className="pl-launch-card-stats">
          <Stat label="Holders" value={compact(c.holders)} />
          <Stat label="Pool / day" value={pool.active ? `${compact(pool.perDay)} ${c.rewardToken?.symbol || ''}` : '—'} className="right" />
        </div>
        <div className="pl-launch-card-foot">
          <span className="pl-launch-pair">
            {c.symbol} / {c.token?.symbol || 'ETH'}
          </span>
          <span className="pl-launch-muted pl-launch-small">{c.kind === 'edition' ? 'Edition' : 'Unique'}</span>
        </div>
      </div>
    </Link>
  );
}

export function CollectionGrid({ list }) {
  return (
    <div className="pl-launch-grid">
      {list.map((c) => (
        <CollectionCard key={c.address} c={c} />
      ))}
    </div>
  );
}

/** "Coming soon" before the NFT launchpad is deployed. */
export function NftNotLive({ title = 'NFT collections are coming soon', compactCard = false }) {
  return (
    <Card className="pl-place-empty-card">
      <EmptyState
        icon={<Sparkles size={28} />}
        title={title}
        description="The NFT launchpad goes live on Base Sepolia soon. Collections, mints and holder pools appear here once it does."
        action={
          compactCard ? null : (
            <Button as={Link} to="/launch/nft">
              Prepare a collection
            </Button>
          )
        }
      />
    </Card>
  );
}

/** The Collections section of a project page: every collection paired with `token`, the official one first. */
export function CollectionsSection({ token, name }) {
  const q = useCollections({ token });
  if (q.isLoading) return <Skeleton height={220} />;
  if (q.error) return <QueryError error={q.error} retry={q.refetch} />;
  if (!q.data?.deployed) return <NftNotLive compactCard />;
  const list = q.data.collections || [];
  if (!list.length) {
    return (
      <Card className="pl-place-empty-card">
        <EmptyState
          icon={<ImageIcon size={28} />}
          title={`No NFT collections for ${name} yet`}
          description="Anyone can launch a collection paired with this token. The token creator's collection is marked official."
          action={
            <Button as={Link} to="/launch/nft">
              Launch NFT
            </Button>
          }
        />
      </Card>
    );
  }
  return <CollectionGrid list={list} />;
}

/** The ring of a collection's economy (% of every payment, Place included) beside its table. */
export function NftEconomy({ economy, priceWei }) {
  const e = economyPct(economy);
  const shares = paymentPct(e);
  return (
    <div className="pl-econ-palette pl-collection-econ">
      <AllocationRing allocation={shares} buckets={RING_BUCKETS} total={100} label="of every mint" />
      <div className="pl-collection-econ-table">
        {RING_BUCKETS.map((b) => (
          <div key={b.id} className="pl-collection-econ-row">
            <span className="pl-econ-bucket-label">
              <span className={`pl-econ-dot ${b.tone}`} />
              {b.id === 'platform' ? `Place (fixed ${NFT_PLATFORM_PCT}%)` : b.label}
            </span>
            <span className="mono">{Number(shares[b.id].toFixed(2))}%</span>
            <span className="mono pl-launch-muted">{priceWei > 0n ? ethText((BigInt(priceWei) * BigInt(Math.round(shares[b.id] * 100))) / 10_000n) : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
