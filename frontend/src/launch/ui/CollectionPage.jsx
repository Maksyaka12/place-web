// Collection page (/collection/:address): an NFT collection of the Place NFT launchpad. The gallery (or the edition
// image), the mint (progress, price in ETH and in the pair token, quantity, what to pay with), the economy ring, the
// 30-day holders pool, the wallet's NFTs with Claim, the calls anyone can make (share royalties after the sell-out,
// burn waiting ETH, pay out: Place's keeper runs them, so they sit folded under Advanced), holders, mints and the
// economy log. Every call goes through usePlaceTx (Builder Code).
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { maxUint256 } from 'viem';
import { ArrowLeft, BadgeCheck, Flame, Gift, Minus, Plus, Sparkles, Users, Wallet } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, AddressLink, CopyAddress, QueryError, Skeleton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { PLACE_CHAIN_ID, placeClient, explorerTx } from '../../place/chain';
import { formatAmount, formatUtc, countdown, shortAddress } from '../../place/format';
import { useCollection, useTokenMeta } from '../hooks.js';
import { nftDeployment } from '../deployments.js';
import { NFT_COLLECTION_ABI } from '../nftAbi.js';
import { ERC20_ABI } from '../swap.js';
import { MINT_STATUS, POOL_DAYS, poolNumbers } from '../nft.js';
import { compact } from '../format.js';
import { TokenLogo, Advanced, ReadyNote } from './parts.jsx';
import { NftImage, NftEconomy, NftNotLive, ethText } from './CollectionParts.jsx';

const ZERO = '0x0000000000000000000000000000000000000000';
const amount = (raw, decimals = 18, maxDecimals = 6) => formatAmount(BigInt(raw || 0), Number(decimals ?? 18), { maxDecimals });
const LOG_LABEL = {
  RevenueSplit: 'Revenue split',
  HoldersFunded: 'Holders pool funded',
  HoldersConverted: 'Swapped for holders',
  ConversionDeferred: 'Swap waiting',
  HoldersClaimed: 'Holder claim',
  Paid: 'Paid out',
  TokensBurned: 'Burned',
};

/** Pair-token price of `qty` NFTs right now (null when the guard can't price it: ETH only then). */
function useTokenQuote(c, qty, enabled) {
  return useQuery({
    queryKey: ['place', PLACE_CHAIN_ID, 'launch', 'nft-quote', c?.address, qty],
    enabled: Boolean(enabled && c && qty > 0),
    refetchInterval: 15_000,
    retry: 0,
    queryFn: async () => {
      try {
        return await placeClient().readContract({ address: c.address, abi: NFT_COLLECTION_ABI, functionName: 'quoteTokenPrice', args: [BigInt(qty)] });
      } catch {
        return null;
      }
    },
  });
}

function Gallery({ c }) {
  const [shown, setShown] = useState(8);
  if (!c.baseURI) return null;
  if (c.kind === 'edition') {
    return (
      <Card className="pl-collection-gallery edition">
        <NftImage c={c} id={1} className="pl-collection-edition-img" />
      </Card>
    );
  }
  const total = c.maxSupply || c.totalMinted;
  const ids = Array.from({ length: Math.min(shown, total) }, (_, i) => i + 1);
  return (
    <Card className="pl-place-stack">
      <SectionTitle title="Gallery" count={total} />
      <div className="pl-collection-gallery">
        {ids.map((id) => (
          <figure key={id} className="pl-collection-nft">
            <NftImage c={c} id={id} />
            <figcaption className="mono">#{id}</figcaption>
          </figure>
        ))}
      </div>
      {total > shown && (
        <Button size="sm" variant="ghost" onClick={() => setShown((s) => s + 16)}>
          Show more
        </Button>
      )}
    </Card>
  );
}

function MintCard({ c, account, you }) {
  const now = useNow(1000);
  const tx = usePlaceTx();
  const [qty, setQty] = useState(1);
  const [asset, setAsset] = useState('eth');
  const price = BigInt(c.mintPrice || 0);
  const left = c.maxSupply ? c.maxSupply - c.totalMinted : Infinity;
  const walletLeft = c.maxPerWallet ? Math.max(0, c.maxPerWallet - (you?.minted ?? 0)) : Infinity;
  const maxQty = Math.max(0, Math.min(left, walletLeft, 50));
  const canToken = c.tokenPayments && price > 0n && c.token;
  const quote = useTokenQuote(c, qty, canToken);
  const st = MINT_STATUS[c.status] || MINT_STATUS.live;
  const startsIn = c.status === 'upcoming' ? countdown(new Date(c.mintStart * 1000), now) : null;
  const sym = c.token?.symbol || 'TOKEN';
  const payToken = asset === 'token' && canToken;
  const due = quote.data ?? null;

  const mint = async () => {
    if (!account) return;
    if (!payToken) {
      await tx.send({ label: `Mint ${qty}`, to: c.address, abi: NFT_COLLECTION_ABI, functionName: 'mint', args: [account, BigInt(qty)], value: price * BigInt(qty) });
      return;
    }
    if (due == null) return;
    const maxIn = (due * 102n) / 100n; // the price may move a little before the transaction lands
    const client = placeClient();
    const allowance = await client.readContract({ address: c.token.address, abi: ERC20_ABI, functionName: 'allowance', args: [account, c.address] });
    const calls = [];
    if (allowance < maxIn) calls.push({ label: `Allow the collection to take ${sym}`, to: c.token.address, abi: ERC20_ABI, functionName: 'approve', args: [c.address, maxUint256] });
    calls.push({ label: `Mint ${qty} with ${sym}`, to: c.address, abi: NFT_COLLECTION_ABI, functionName: 'mintWithToken', args: [account, BigInt(qty), maxIn] });
    await tx.send(calls);
  };

  return (
    <Card className="pl-place-stack pl-collection-mint">
      <div className="pl-collection-mint-head">
        <span className="pl-launch-section-title">Mint</span>
        <Badge tone={st.tone} pill>
          {st.label}
        </Badge>
      </div>
      <div className="pl-collection-mint-progress">
        <ProgressBar value={c.totalMinted} max={c.maxSupply || Math.max(c.totalMinted, 1)} />
        <span className="pl-launch-muted pl-launch-small mono">
          {c.totalMinted.toLocaleString('en-US')} minted{c.maxSupply ? ` of ${c.maxSupply.toLocaleString('en-US')}` : ' · open edition'}
        </span>
      </div>
      <dl className="pl-place-kv">
        <div>
          <dt>Price</dt>
          <dd className="mono">{price > 0n ? ethText(price) : 'Free'}</dd>
        </div>
        {canToken && (
          <div>
            <dt>In {sym}</dt>
            <dd className="mono">{quote.isLoading ? '...' : due != null ? `≈ ${amount(due / BigInt(qty), c.token.decimals, 4)} ${sym}` : 'Not available right now'}</dd>
          </div>
        )}
        {c.maxPerWallet > 0 && (
          <div>
            <dt>Per wallet</dt>
            <dd className="mono">
              {c.maxPerWallet}
              {you?.minted != null ? ` (you minted ${you.minted})` : ''}
            </dd>
          </div>
        )}
        {c.mintEnd > 0 && (
          <div>
            <dt>Closes</dt>
            <dd className="mono">{formatUtc(new Date(c.mintEnd * 1000))}</dd>
          </div>
        )}
      </dl>
      {c.status === 'upcoming' && <Alert tone="info">Opens {formatUtc(new Date(c.mintStart * 1000))}{startsIn ? ` · in ${startsIn}` : ''}</Alert>}
      {c.status === 'live' && (
        <>
          <div className="pl-collection-qty">
            <span className="pl-launch-field-label">Quantity</span>
            <div className="pl-collection-qty-ctrl">
              <button type="button" className="pl-place-icon-btn" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1}>
                <Minus size={14} />
              </button>
              <input className="mono" inputMode="numeric" value={qty} onChange={(e) => setQty(Math.max(1, Math.min(maxQty || 1, Number(e.target.value.replace(/\D/g, '')) || 1)))} aria-label="Quantity" />
              <button type="button" className="pl-place-icon-btn" aria-label="More" onClick={() => setQty((q) => Math.min(maxQty || 1, q + 1))} disabled={qty >= maxQty}>
                <Plus size={14} />
              </button>
            </div>
          </div>
          {canToken && (
            <div className="seg soft" role="tablist" aria-label="Pay with">
              <button type="button" role="tab" aria-selected={asset === 'eth'} onClick={() => setAsset('eth')}>
                ETH
              </button>
              <button type="button" role="tab" aria-selected={asset === 'token'} onClick={() => setAsset('token')}>
                {sym}
              </button>
            </div>
          )}
          {!account ? (
            <ConnectButton size="lg">Connect wallet to mint</ConnectButton>
          ) : (
            <TxButton tx={tx} onClick={mint} size="lg" fullWidth disabled={maxQty === 0 || (payToken && due == null)} busyLabel="Minting on Base...">
              <Sparkles size={16} />
              {maxQty === 0 ? 'Wallet limit reached' : payToken ? `Mint ${qty} · ${due != null ? `${amount(due, c.token.decimals, 4)} ${sym}` : '...'}` : `Mint ${qty} · ${price > 0n ? ethText(price * BigInt(qty)) : 'free'}`}
            </TxButton>
          )}
          {payToken && due == null && !quote.isLoading && <span className="pl-place-hint">The {sym} price is not ready or moved too fast. Pay in ETH, or try again in a minute.</span>}
        </>
      )}
      <TxResult tx={tx} success="Minted" />
    </Card>
  );
}

function YourNfts({ c, account, you, decimals, symbol }) {
  const tx = usePlaceTx();
  if (!account) {
    return (
      <Card className="pl-place-stack">
        <span className="pl-launch-section-title">Your NFTs</span>
        <p className="pl-launch-muted pl-launch-small">Connect a wallet to see your NFTs and claim holder rewards.</p>
        <ConnectButton>Connect wallet</ConnectButton>
      </Card>
    );
  }
  const ids = you?.ids || [];
  const claimable = you?.claimable != null ? BigInt(you.claimable) : null;
  const claimIds = ids.filter((x) => x.claimable == null || BigInt(x.claimable) > 0n).map((x) => BigInt(x.id));
  return (
    <Card className="pl-place-stack">
      <span className="pl-launch-section-title">Your NFTs</span>
      {ids.length ? (
        <div className="pl-collection-mine">
          {ids.slice(0, 12).map((x) => (
            <figure key={x.id} className="pl-collection-nft small">
              <NftImage c={c} id={x.id} />
              <figcaption className="mono">#{x.id}</figcaption>
            </figure>
          ))}
          {ids.length > 12 && <span className="pl-collection-thumb more mono">+{ids.length - 12}</span>}
        </div>
      ) : (
        <p className="pl-launch-muted pl-launch-small">You hold none of these NFTs.</p>
      )}
      <div className="pl-launch-your-reward">
        <span className="pl-launch-muted pl-launch-small">You can claim</span>
        <span className="mono pl-launch-strong">{claimable == null ? '—' : `${amount(claimable, decimals)} ${symbol}`}</span>
        {you?.credit && BigInt(you.credit) > 0n && <span className="pl-place-hint">Includes {amount(you.credit, decimals)} {symbol} that NFTs you sold had earned.</span>}
      </div>
      <TxButton tx={tx} onClick={() => tx.send({ label: 'Claim', to: c.address, abi: NFT_COLLECTION_ABI, functionName: 'claim', args: [claimIds] })} disabled={!claimable || claimable === 0n} busyLabel="Claiming on Base...">
        <Gift size={15} /> Claim
      </TxButton>
      <TxResult tx={tx} success="Claimed" />
      {ids.length > 0 && <ReadyNote />}
    </Card>
  );
}

/**
 * Calls anyone can make: share royalties (after the sell-out, or when ETH is waiting), burn waiting ETH, pay out.
 * Place's keeper makes them on its own, so they are a folded fallback.
 */
function KeepItRunning({ c, live }) {
  const tx = usePlaceTx();
  if (!live) return null;
  const unprocessed = BigInt(live.unprocessedEth || 0);
  const pending = BigInt(live.pendingHoldersEth || 0) + BigInt(live.pendingHoldersToken || 0);
  const buyback = BigInt(live.buybackPending || 0);
  const owed = BigInt(live.creatorOwedEth || 0) + BigInt(live.platformOwedEth || 0);
  const showProcess = c.status === 'sold-out' || c.status === 'ended' || unprocessed > 0n || pending > 0n;
  if (!showProcess && buyback === 0n && owed === 0n) return null;
  const call = (label, functionName, args) => tx.send({ label, to: c.address, abi: NFT_COLLECTION_ABI, functionName, args });
  return (
    <Advanced
      title="Advanced: keep it running"
      note="Place runs these on its own every few minutes: sharing royalties, buying back and burning, paying out. Use them by hand only if something waits for long. Anyone can make these calls; nobody gets the money but the people it belongs to."
    >
      <div className="pl-place-rows">
        {showProcess && (
          <div className="pl-place-row">
            <div className="pl-place-row-main">
              <span className="pl-launch-strong">Share royalties</span>
              <span className="pl-launch-muted pl-launch-small">
                {unprocessed > 0n ? `${ethText(unprocessed)} of royalties waits to be split. ` : ''}
                {pending > 0n ? 'Swaps for holders wait to run. ' : ''}
                After the sell-out there are no mints to do this.
              </span>
            </div>
            <Button size="sm" onClick={() => call('Share royalties', 'processPending', [ZERO])} disabled={tx.busy}>
              Run
            </Button>
          </div>
        )}
        {buyback > 0n && (
          <div className="pl-place-row">
            <div className="pl-place-row-main">
              <span className="pl-launch-strong">Burn {c.token?.symbol}</span>
              <span className="pl-launch-muted pl-launch-small">{ethText(buyback)} waits to buy back and burn {c.token?.symbol}.</span>
            </div>
            <Button size="sm" onClick={() => call('Buy back and burn', 'buyback', [buyback])} disabled={tx.busy}>
              <Flame size={14} /> Burn
            </Button>
          </div>
        )}
        {owed > 0n && (
          <div className="pl-place-row">
            <div className="pl-place-row-main">
              <span className="pl-launch-strong">Pay out</span>
              <span className="pl-launch-muted pl-launch-small">
                Creator {ethText(live.creatorOwedEth)}, Place {ethText(live.platformOwedEth)}.
              </span>
            </div>
            <Button size="sm" onClick={() => call('Pay out', 'payOut', [ZERO])} disabled={tx.busy}>
              <Wallet size={14} /> Pay out
            </Button>
          </div>
        )}
      </div>
      <TxResult tx={tx} success="Done" />
    </Advanced>
  );
}

function HoldersPool({ c, live }) {
  const pool = poolNumbers(live?.perDay != null ? { ...c.pool, ...live } : c.pool, c.rewardToken?.decimals);
  const sym = c.rewardToken?.symbol || 'ETH';
  return (
    <Card className="pl-place-stack">
      <SectionTitle title="Holders pool" right={<Badge tone={pool.active ? 'success' : 'neutral'}>{pool.active ? 'Paying' : 'Empty'}</Badge>} />
      <div className="pl-launch-tab-tiles">
        <Tile label="In the pool" value={`${compact(pool.left)} ${sym}`} sub={pool.active ? `paid over ${pool.daysLeft} more days` : 'fills with every mint'} />
        <Tile label="Every day" value={`${compact(pool.perDay)} ${sym}`} sub={pool.active ? `${compact(pool.perNftPerDay)} per NFT` : '—'} />
        <Tile label="Accrued today" value={`${compact(pool.accruedToday)} ${sym}`} sub="at 00:00 UTC" />
        <Tile label="Pays until" value={pool.endsAt ? formatUtc(pool.endsAt) : '—'} sub={`${compact(pool.claimed)} of ${compact(pool.funded)} ${sym} claimed`} />
      </div>
      <p className="pl-launch-muted pl-launch-small">
        {c.economy.holdersBps / 100}% of what is left after Place, from every mint and royalty, joins this pool in {sym}. It pays out over {POOL_DAYS} days: each day at 00:00 UTC the day&apos;s portion
        is shared equally by every NFT that exists then. A new income spreads what is left plus the income over the next {POOL_DAYS} days. Claim any time; when an NFT is sold, what it earned stays with the seller.
      </p>
    </Card>
  );
}

export default function CollectionPage() {
  const { address: raw } = useParams();
  const address = String(raw || '').toLowerCase();
  const { address: account } = usePlaceAccount();
  const n = nftDeployment(PLACE_CHAIN_ID);
  const q = useCollection(n ? address : null, account);
  const c = q.data?.collection;
  const meta = useTokenMeta(c?.contractURI);
  const rewardDecimals = c?.rewardToken?.decimals ?? 18;
  const rewardSym = c?.rewardToken?.symbol || 'ETH';
  const priceWei = useMemo(() => BigInt(c?.mintPrice || 0), [c]);

  const back = (
    <Link to="/projects" className="pl-place-back">
      <ArrowLeft size={14} /> Projects
    </Link>
  );
  if (!n || q.data?.deployed === false) {
    return (
      <div className="pl-place-stack">
        {back}
        <NftNotLive />
      </div>
    );
  }
  if (q.isLoading) {
    return (
      <div className="pl-place-stack">
        {back}
        <Skeleton height={420} />
      </div>
    );
  }
  if (q.error || !c) {
    return (
      <div className="pl-place-stack">
        {back}
        {q.error?.status === 404 ? (
          <Card className="pl-place-empty-card">
            <EmptyState title="Collection not found" description="This address is not a collection of the Place NFT launchpad, or it was created seconds ago and is not indexed yet." />
          </Card>
        ) : (
          <QueryError error={q.error} retry={q.refetch} />
        )}
      </div>
    );
  }

  const live = q.data.live;
  const you = q.data.you;
  return (
    <div className="pl-launch pl-collection">
      {back}
      <div className="pl-place-head">
        <TokenLogo token={{ symbol: c.symbol, name: c.name, contractURI: c.contractURI }} size={56} />
        <div className="pl-place-head-main">
          <h1 className="page-title">{c.name || shortAddress(c.address)}</h1>
          <div className="pl-place-head-sub">
            <span className="mono">{c.symbol}</span>
            {c.official && (
              <Badge tone="accent" pill>
                <BadgeCheck size={12} /> Official
              </Badge>
            )}
            <Badge tone="neutral" pill>
              {c.kind === 'edition' ? 'Edition' : 'Unique'}
            </Badge>
            {c.token && (
              <Link className="pl-place-link" to={`/token/${c.token.address}`}>
                Paired with {c.token.symbol}
              </Link>
            )}
            <CopyAddress address={c.address} />
          </div>
        </div>
      </div>
      {meta.data?.description && <p className="pl-place-desc">{meta.data.description}</p>}
      {!c.official && c.token && <Alert tone="info">Made by a community member, not by the {c.token.symbol} team.</Alert>}

      <div className="pl-place-tiles pl-collection-tiles">
        <Tile label="Minted" value={`${c.totalMinted.toLocaleString('en-US')}${c.maxSupply ? ` / ${c.maxSupply.toLocaleString('en-US')}` : ''}`} sub={`${c.holders} holders`} />
        <Tile label="Mint revenue" value={ethText(c.paid.eth, 4)} sub={BigInt(c.paid.token) > 0n ? `+ ${amount(c.paid.token, c.token?.decimals, 2)} ${c.token?.symbol}` : 'in ETH'} />
        <Tile label="Burned" value={`${amount(c.burned, c.token?.decimals ?? 18, 2)} ${c.token?.symbol || ''}`} sub={`royalty ${c.royaltyBps / 100}%`} />
      </div>

      <div className="pl-place-cols">
        <div className="pl-place-stack">
          <Gallery c={c} />
          <Card className="pl-place-stack">
            <SectionTitle title="Economy" />
            <NftEconomy economy={c.economy} priceWei={priceWei} />
            <p className="pl-launch-muted pl-launch-small">
              Every mint{c.royaltyBps ? ` and every ${c.royaltyBps / 100}% royalty` : ''} is split this way, fixed for good. Burn buys {c.token?.symbol || 'the pair token'} and sends it to 0x…dEaD; holders are paid in {rewardSym}.
            </p>
          </Card>
          <HoldersPool c={c} live={live} />
          <Card className="pl-place-stack">
            <SectionTitle title="Holders" count={c.holders} right={<Users size={16} className="pl-launch-muted" />} />
            {q.data.holders.length ? (
              <div className="pl-place-rows">
                {q.data.holders.map((h) => (
                  <div key={h.owner} className="pl-place-row">
                    <AddressLink address={h.owner} />
                    <span className="mono">{h.count} NFT{h.count === 1 ? '' : 's'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="pl-launch-muted pl-launch-small">No holders yet. The first mint makes the first holder.</p>
            )}
          </Card>
          <Card className="pl-place-stack">
            <SectionTitle title="Mints" />
            {q.data.mints.length ? (
              <div className="pl-place-rows pl-collection-rows">
                {q.data.mints.map((m) => (
                  <a key={`${m.tx}-${m.firstId}`} className="pl-place-row" href={explorerTx(m.tx)} target="_blank" rel="noopener noreferrer">
                    <span className="pl-place-row-main">
                      <span className="mono">{shortAddress(m.minter)}</span>
                      <span className="pl-launch-muted pl-launch-small">{formatUtc(new Date(m.at))}</span>
                    </span>
                    <span className="mono">
                      {m.quantity} × #{m.firstId}
                      {m.quantity > 1 ? `–${Number(m.firstId) + m.quantity - 1}` : ''}
                    </span>
                    <span className="mono pl-launch-muted">{m.asset === 'eth' ? ethText(m.paid, 4) : `${amount(m.paid, c.token?.decimals, 2)} ${c.token?.symbol}`}</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="pl-launch-muted pl-launch-small">No mints yet.</p>
            )}
          </Card>
          {q.data.log.length > 0 && (
            <Card className="pl-place-stack">
              <SectionTitle title="Economy log" />
              <div className="pl-place-rows pl-collection-rows">
                {q.data.log.map((e) => (
                  <a key={`${e.tx}-${e.kind}-${e.amount}`} className="pl-place-row" href={explorerTx(e.tx)} target="_blank" rel="noopener noreferrer">
                    <span className="pl-place-row-main">
                      <span>{LOG_LABEL[e.kind] || e.kind}</span>
                      <span className="pl-launch-muted pl-launch-small">{formatUtc(new Date(e.at))}</span>
                    </span>
                    <span className="mono pl-launch-muted">
                      {e.kind === 'HoldersFunded' || e.kind === 'HoldersClaimed' || e.kind === 'HoldersConverted'
                        ? `${amount(e.kind === 'HoldersConverted' ? e.data?.rewardOut : e.amount, rewardDecimals, 4)} ${rewardSym}`
                        : e.kind === 'TokensBurned'
                          ? `${amount(e.amount, c.token?.decimals, 2)} ${c.token?.symbol || ''}`
                          : e.asset === 'eth' || e.asset == null
                            ? ethText(e.amount, 5)
                            : amount(e.amount, c.token?.decimals, 2)}
                    </span>
                  </a>
                ))}
              </div>
            </Card>
          )}
        </div>
        <div className="pl-place-stack">
          <MintCard c={c} account={account} you={you} />
          <YourNfts c={c} account={account} you={you} decimals={rewardDecimals} symbol={rewardSym} />
          <KeepItRunning c={c} live={live} />
          <Card className="pl-place-stack">
            <span className="pl-launch-section-title">Details</span>
            <dl className="pl-place-kv">
              <div>
                <dt>Contract</dt>
                <dd>
                  <AddressLink address={c.address} />
                </dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>
                  <AddressLink address={c.owner} />
                </dd>
              </div>
              <div>
                <dt>Pair token</dt>
                <dd>{c.token ? <Link className="pl-place-link" to={`/token/${c.token.address}`}>{c.token.symbol}</Link> : 'None'}</dd>
              </div>
              <div>
                <dt>Holders paid in</dt>
                <dd>{rewardSym}</dd>
              </div>
              <div>
                <dt>Royalty</dt>
                <dd className="mono">{c.royaltyBps / 100}%</dd>
              </div>
              <div>
                <dt>Metadata</dt>
                <dd>{c.metadataFrozen ? 'Frozen' : 'Can still change'}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd className="mono">
                  <a className="pl-place-link" href={explorerTx(c.createdTx)} target="_blank" rel="noopener noreferrer">
                    {formatUtc(new Date(c.createdAt))}
                  </a>
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
