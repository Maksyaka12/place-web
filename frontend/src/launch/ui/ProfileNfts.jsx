// Profile → NFT launches (/profile/nft-launches): the collections this wallet launched, each with the token it is
// paired with, then the NFTs it holds and its past holder claims. `NftClaimRow` (claim(ids) of one collection's
// holders pool) is also used by Profile → Rewards, NFT holders.
import { Link } from 'react-router-dom';
import { ArrowUpRight, Gift, Image as ImageIcon, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, SectionTitle } from '../../themes/place/components/ui';
import { TxButton, TxResult, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { explorerTx } from '../../place/chain';
import { formatAmount, formatUtc } from '../../place/format';
import { useNftAccount } from '../hooks.js';
import { NFT_COLLECTION_ABI } from '../nftAbi.js';
import { MINT_STATUS, collectionPath } from '../nft.js';
import { TokenLogo, launchTokenPath } from './parts.jsx';
import { NftImage, NftNotLive, ethText } from './CollectionParts.jsx';

const amount = (raw, decimals = 18) => formatAmount(BigInt(raw || 0), Number(decimals ?? 18), { maxDecimals: 6 });

export function NftClaimRow({ c, item }) {
  const tx = usePlaceTx();
  const ids = item.ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id));
  const r = item.rewardToken || c?.rewardToken;
  return (
    <div className="pl-launch-reward-row">
      <Link to={collectionPath(item.collection)} className="pl-launch-reward-token">
        <TokenLogo token={{ symbol: c?.symbol, name: c?.name, contractURI: c?.contractURI }} size={36} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{c?.name || 'Collection'}</span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <ImageIcon size={12} /> Holders pool · {item.ids.length} NFT{item.ids.length === 1 ? '' : 's'}
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
      {tx.status !== 'idle' && (
        <div className="pl-launch-reward-result">
          <TxResult tx={tx} success="Claimed" />
        </div>
      )}
    </div>
  );
}

/** One collection the wallet launched: status, mint progress and the token it is paired with. */
function CollectionRow({ c }) {
  const st = MINT_STATUS[c.status] || MINT_STATUS.live;
  const t = c.token;
  return (
    <div className="pl-launch-reward-row pl-profile-collection-row">
      <Link to={collectionPath(c.address)} className="pl-launch-reward-token">
        <TokenLogo token={{ symbol: c.symbol, name: c.name, contractURI: c.contractURI }} size={40} />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{c.name || 'Collection'}</span>
          <span className="pl-launch-muted pl-launch-small pl-launch-inline start">
            <Badge tone={st.tone}>{st.label}</Badge>
            {c.symbol} · {c.kind === 'edition' ? 'Edition' : 'Unique'}
          </span>
        </span>
      </Link>
      <span className="pl-launch-reward-amounts">
        <span className="pl-launch-small pl-launch-inline pl-profile-pair">
          <span className="pl-launch-muted">Paired with</span>
          {t ? (
            t.placeLaunch ? (
              <Link className="pl-place-link pl-launch-inline" to={launchTokenPath(t.address)}>
                <TokenLogo token={t} src={t.logo || undefined} size={20} shape="round" />
                {t.symbol}
              </Link>
            ) : (
              <AddressLink address={t.address} label={t.symbol || undefined} />
            )
          ) : (
            <span>ETH</span>
          )}
        </span>
        <span className="pl-launch-muted pl-launch-small mono">
          {c.totalMinted.toLocaleString('en-US')} / {c.maxSupply ? c.maxSupply.toLocaleString('en-US') : 'open'} minted · {BigInt(c.mintPrice || 0) > 0n ? ethText(c.mintPrice) : 'Free'}
        </span>
      </span>
      <Button as={Link} to={collectionPath(c.address)} size="sm" variant="ghost" aria-label={`Open ${c.name || 'collection'}`}>
        <ArrowUpRight size={15} />
      </Button>
    </div>
  );
}

export function ProfileNfts({ address }) {
  const q = useNftAccount(address);
  if (q.isLoading) return <Skeleton height={300} />;
  if (q.error) return <QueryError error={q.error} retry={q.refetch} />;
  if (!q.data?.deployed) return <NftNotLive />;
  const { owned, created, claims } = q.data;
  return (
    <div className="pl-launch-console-section">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">NFT launches</h2>
          <p className="pl-launch-section-desc">Collections you launched and the token each one is paired with. Claim NFT holder rewards in Rewards.</p>
        </div>
        <Button as={Link} to="/launch/nft" size="sm">
          <Sparkles size={14} /> Launch NFT
        </Button>
      </div>
      {created.length ? (
        <Card className="pl-launch-reward-list">
          {created.map((c) => (
            <CollectionRow key={c.address} c={c} />
          ))}
        </Card>
      ) : (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Sparkles size={28} />}
            title="No collections yet"
            description="Launch an NFT collection paired with a token: mints and royalties fund its holders, the creator and a buyback."
            action={
              <Button as={Link} to="/launch/nft" variant="primary">
                Launch NFT
              </Button>
            }
          />
        </Card>
      )}
      <Card className="pl-place-stack">
        <SectionTitle title="NFTs you hold" count={owned.reduce((n, o) => n + o.ids.length, 0)} />
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
