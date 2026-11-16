// Token or collection page: the asset, its market price, every campaign for it and who made them.
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Layers, EyeOff, Rocket } from 'lucide-react';
import { isAddress } from 'viem';
import { Card, Tile, Alert, Button, EmptyState, SectionTitle, Badge } from '../../components/ui';
import { useToken } from '../../../../place/hooks';
import { isTestnet, PLACE_CHAIN } from '../../../../place/chain';
import { formatUtc, shortAddress } from '../../../../place/format';
import { CampaignCard, AddressLink, CopyAddress, TokenIcon, QueryError, Skeleton } from './parts';
import { viewStatus } from '../../../../place/status';

/** USD price and market link from DexScreener (Base mainnet only; test tokens have no market). */
function usePrice(address) {
  return useQuery({
    queryKey: ['dexscreener', address],
    enabled: Boolean(address) && !isTestnet,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal });
      if (!res.ok) throw new Error('No price');
      const body = await res.json();
      const pair = (body.pairs || []).filter((p) => p.chainId === 'base').sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      return pair ? { usd: Number(pair.priceUsd), url: pair.url } : null;
    },
  });
}

const usd = (n) => (n >= 1 ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${n.toPrecision(3)}`);

export default function TokenPage() {
  const { address: raw } = useParams();
  const address = isAddress(raw || '', { strict: false }) ? raw.toLowerCase() : null;
  const q = useToken(address);
  const price = usePrice(address);
  const t = q.data;
  const now = Math.floor(Date.now() / 1000);
  const campaigns = useMemo(() => (t?.campaigns || []).map((c) => ({ ...c, status: viewStatus(c, now) })), [t, now]);
  const creators = useMemo(() => {
    const m = new Map();
    for (const c of campaigns) m.set(c.creator, (m.get(c.creator) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [campaigns]);

  const back = (
    <Link to="/" className="pl-place-back">
      <ArrowLeft size={14} /> Explore
    </Link>
  );
  if (!address) {
    return (
      <>
        {back}
        <Alert tone="danger">This is not a valid token address.</Alert>
      </>
    );
  }
  if (q.isLoading) {
    return (
      <>
        {back}
        <Skeleton height={320} />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        {back}
        <QueryError error={q.error} retry={q.refetch} />
      </>
    );
  }

  const nft = t.kind === 'nft';
  const name = t.name || t.symbol || shortAddress(address);
  const live = campaigns.filter((c) => c.status === 'live').length;
  const upcoming = campaigns.filter((c) => c.status === 'scheduled' || c.status === 'snapshotting').length;
  const createLink = `/create?kind=${nft ? 'nft-holders' : 'token-holders'}&target=${address}`;
  const order = { live: 0, scheduled: 1, snapshotting: 1, refundable: 2 };
  const sorted = [...campaigns].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

  return (
    <div className="pl-place-token">
      {back}
      <div className="pl-place-head">
        <TokenIcon meta={t} address={address} size={48} />
        <div className="pl-place-head-main">
          <h1 className="page-title">
            {name}
            {t.symbol && t.name && <span className="pl-place-muted"> {t.symbol}</span>}
          </h1>
          <div className="pl-place-head-sub">
            <Badge pill tone="accent">{nft ? 'NFT collection' : 'Token'}</Badge>
            {t.placeLaunch && (
              <Badge pill tone="accent">
                <Rocket size={12} /> Launched on Place
              </Badge>
            )}
            <AddressLink address={address} />
            <CopyAddress address={address} />
          </div>
        </div>
        <div className="pl-place-actions">
          {t.placeLaunch && (
            <Button as={Link} to={`/launch/token/${address}`}>
              <Rocket size={15} />
              Trade on Place Launch
            </Button>
          )}
          <Button as={Link} to={createLink} variant="primary">
            Create a campaign
          </Button>
        </div>
      </div>

      {t.hidden && (
        <Alert tone="warn" icon={<EyeOff size={16} />} className="pl-place-section">
          Place moderation hides this asset from Explore. Its campaigns keep working and can still be claimed.
        </Alert>
      )}

      <div className="pl-place-tiles">
        <Tile
          label="Price"
          value={<span className="mono">{price.data ? usd(price.data.usd) : '—'}</span>}
          sub={
            isTestnet ? (
              `No market on ${PLACE_CHAIN.name}`
            ) : price.data ? (
              <a className="pl-place-link" href={price.data.url} target="_blank" rel="noopener noreferrer">
                DexScreener
              </a>
            ) : price.isLoading ? (
              'Loading...'
            ) : (
              'No market found'
            )
          }
        />
        <Tile label="Campaigns" value={<span className="mono">{campaigns.length}</span>} sub={`${live} live, ${upcoming} upcoming`} />
        <Tile
          label={t.placeCollection ? 'Made on Place' : 'Creators'}
          value={<span className="mono">{t.placeCollection ? formatUtc(t.placeCollection.createdAt) : creators.length}</span>}
          sub={t.placeCollection ? <>by <AddressLink address={t.placeCollection.creator} /></> : 'Wallets that funded campaigns'}
        />
      </div>

      <section className="pl-place-section">
        <SectionTitle title="Campaigns" count={campaigns.length} />
        {sorted.length && t.placeLaunch ? (
          // Official (the creator or the token's community fund) and from the community.
          [
            ['Official', sorted.filter((c) => c.section === 'official')],
            ['From the community', sorted.filter((c) => c.section !== 'official')],
          ].map(([title, list]) =>
            list.length ? (
              <div key={title} className="pl-place-stack">
                <span className="pl-launch-field-label">{title}</span>
                <div className="pl-place-grid">
                  {list.map((c) => (
                    <CampaignCard key={`${c.hub}:${c.id}`} c={c} />
                  ))}
                </div>
              </div>
            ) : null
          )
        ) : sorted.length ? (
          <div className="pl-place-grid">
            {sorted.map((c) => (
              <CampaignCard key={`${c.hub}:${c.id}`} c={c} />
            ))}
          </div>
        ) : (
          <Card className="pl-place-empty-card">
            <EmptyState
              icon={<Layers size={28} />}
              title={`No campaigns for ${name} yet`}
              description={`Anyone can reward the holders of ${nft ? 'this collection' : 'this token'}, not only its team`}
              action={
                <Button as={Link} to={createLink} variant="primary">
                  Create the first one
                </Button>
              }
            />
          </Card>
        )}
      </section>

      {creators.length > 0 && (
        <section className="pl-place-section">
          <SectionTitle title="Who created them" count={creators.length} />
          <div className="pl-place-rows">
            {creators.map(([creator, n]) => (
              <div className="pl-place-row" key={creator}>
                <div className="pl-place-row-main">
                  <AddressLink address={creator} full />
                </div>
                <div className="pl-place-row-amount">
                  {n} campaign{n === 1 ? '' : 's'}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
