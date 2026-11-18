// Profile, NFTs (/profile/nfts): holder rewards the wallet can claim in each collection, the NFTs it holds, the
// collections it launched and its past claims. `NftRewards` alone also shows in the Rewards section of the profile.
import { Link } from 'react-router-dom';
import { Gift, Image as ImageIcon, Sparkles } from 'lucide-react';
import { Button, Card, EmptyState, SectionTitle } from '../../themes/place/components/ui';
import { TxButton, TxResult, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc } from '../../place/format';
import { useNftAccount } from '../hooks.js';
import { NFT_COLLECTION_ABI } from '../nftAbi.js';
import { collectionPath } from '../nft.js';
import { TokenLogo } from './parts.jsx';
import { CollectionGrid, NftImage, NftNotLive } from './CollectionParts.jsx';

const amount = (raw, decimals = 18) => formatAmount(BigInt(raw || 0), Number(decimals ?? 18), { maxDecimals: 6 });

function ClaimRow({ c, item }) {
  const tx = usePlaceTx();
  const ids = item.ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id));
  const r = item.rewardToken || c?.rewardToken;
  return (
    <div className="pl-launch-reward-row">
      <Link to={collectionPath(item.collection)} className="pl-launch-reward-token">
        <TokenLogo token={{ symbol: c?.symbol, name: c?.name, contractURI: c?.contractURI }} size={36} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{c?.name || 'Collection'}</span>
          <span className="pl-launch-muted pl-launch-small">
            {item.ids.length} NFT{item.ids.length === 1 ? '' : 's'}
            {item.credit && BigInt(item.credit) > 0n ? ' · with what sold NFTs earned' : ''}
          </span>
        </span>
      </Link>
      <span className="pl-launch-reward-amounts">
        <span className="mono pl-launch-strong">{item.claimable == null ? '—' : `${amount(item.claimable, r?.decimals)} ${r?.symbol || ''}`}</span>
      </span>
      <TxButton tx={tx} size="sm" onClick={() => tx.send({ label: 'Claim', to: item.collection, abi: NFT_COLLECTION_ABI, functionName: 'claim', args: [ids] })} busyLabel="Claiming...">
        Claim
      </TxButton>
      <div className="pl-launch-reward-result">
        <TxResult tx={tx} success="Claimed" />
      </div>
    </div>
  );
}

/** NFT holder rewards the wallet can claim now, one row per collection (nothing when there are none). */
export function NftRewards({ address, showEmpty = false }) {
  const q = useNftAccount(address);
  if (!q.data?.deployed) return null;
  const list = q.data.claimable || [];
  const byAddress = new Map([...q.data.owned.map((o) => o.collection), ...q.data.created].map((c) => [c.address, c]));
  if (!list.length && !showEmpty) return null;
  return (
    <Card className="pl-place-stack">
      <SectionTitle title="NFT holder rewards" count={list.length} />
      {list.length ? (
        list.map((item) => <ClaimRow key={item.collection} c={byAddress.get(item.collection)} item={item} />)
      ) : (
        <p className="pl-launch-muted pl-launch-small">Nothing to claim. Holders of NFTs launched on Place earn from every mint and royalty, paid daily at 00:00 UTC.</p>
      )}
    </Card>
  );
}

export function ProfileNfts({ address }) {
  const q = useNftAccount(address);
  if (q.isLoading) return <Skeleton height={300} />;
  if (q.error) return <QueryError error={q.error} retry={q.refetch} />;
  if (!q.data?.deployed) return <NftNotLive />;
  const { owned, created, claims } = q.data;
  return (
    <div className="pl-place-stack">
      <NftRewards address={address} showEmpty />
      <Card className="pl-place-stack">
        <SectionTitle title="My NFTs" count={owned.reduce((n, o) => n + o.ids.length, 0)} />
        {owned.length ? (
          owned.map(({ collection: c, ids }) => (
            <div key={c.address} className="pl-place-stack">
              <Link className="pl-place-link pl-launch-strong" to={collectionPath(c.address)}>
                {c.name} <span className="pl-launch-muted">{c.symbol}</span>
              </Link>
              <div className="pl-collection-mine">
                {ids.slice(0, 12).map((id) => (
                  <figure key={id} className="pl-collection-nft small">
                    <NftImage c={c} id={id} />
                    <figcaption className="mono">#{id}</figcaption>
                  </figure>
                ))}
                {ids.length > 12 && <span className="pl-collection-thumb more mono">+{ids.length - 12}</span>}
              </div>
            </div>
          ))
        ) : (
          <EmptyState icon={<ImageIcon size={28} />} title="No NFTs yet" description="NFTs you mint or buy from collections launched on Place show up here." action={<Button as={Link} to="/projects?view=collections">Browse collections</Button>} />
        )}
      </Card>
      <Card className="pl-place-stack">
        <SectionTitle
          title="My collections"
          count={created.length}
          right={
            <Button as={Link} to="/launch/nft" size="sm">
              <Sparkles size={14} /> Launch NFT
            </Button>
          }
        />
        {created.length ? <CollectionGrid list={created} /> : <p className="pl-launch-muted pl-launch-small">You have not launched a collection yet.</p>}
      </Card>
      {claims.length > 0 && (
        <Card className="pl-place-stack">
          <SectionTitle title="Claim history" count={claims.length} />
          <div className="pl-place-rows pl-collection-rows">
            {claims.map((x) => {
              const c = [...owned.map((o) => o.collection), ...created].find((y) => y.address === x.collection);
              return (
                <a key={x.tx} className="pl-place-row" href={explorerTx(x.tx)} target="_blank" rel="noopener noreferrer">
                  <span className="pl-place-row-main">
                    <span>
                      <Gift size={13} /> {c?.name || x.collection}
                    </span>
                    <span className="pl-launch-muted pl-launch-small">{formatUtc(new Date(x.at))}</span>
                  </span>
                  <span className="mono">
                    {amount(x.amount, c?.rewardToken?.decimals)} {c?.rewardToken?.symbol || ''}
                  </span>
                </a>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
