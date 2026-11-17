// Campaigns in the profile: the creator's dashboard — every campaign with its status and claims, and the
// actions the hub allows at that moment: cancel, extend the claim window, take back an unpublished pool,
// close; plus the NFT collections deployed through Place.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LayoutDashboard, Sparkles, Wallet, EyeOff } from 'lucide-react';
import { Card, SectionTitle, EmptyState, Button, ProgressBar, Badge } from '../../components/ui';
import { useCampaigns, useCollections, useCampaignMeta, useNow, usePlaceAccount, usePlaceTx } from '../../../../place/hooks';
import { PLACE_HUB_ABI } from '../../../../place/abi';
import { viewStatus } from '../../../../place/status';
import { formatToken, formatUtc, countdown, assetLabel, shortAddress } from '../../../../place/format';
import { StatusBadge, TxButton, TxResult, ConnectButton, AddressLookup, AddressLink, QueryError, Skeleton, campaignTitle, campaignPath, tokenPath } from './parts';

const DAY = 86400;

function nextStep(c, status, now) {
  switch (status) {
    case 'scheduled':
      return `Snapshot in ${countdown(c.snapshotAt, now)}`;
    case 'snapshotting':
      return 'Place is computing the table';
    case 'refundable':
      return 'No table in 72 hours: you can take the pool back';
    case 'live':
      return `Claims close in ${countdown(c.claimEnd, now)}`;
    case 'ended':
      return 'Claim window over: close it to settle the leftover';
    default:
      return `Snapshot ${formatUtc(c.snapshotAt)}`;
  }
}

function CampaignRow({ c, own }) {
  const { data: meta } = useCampaignMeta(c);
  const now = useNow(1000);
  const status = viewStatus(c, Math.floor(now / 1000));
  const tx = usePlaceTx();
  const [extendDays, setExtendDays] = useState(null);
  const id = BigInt(c.id);
  const call = (functionName, args, action) =>
    tx.send({ to: c.hub, abi: PLACE_HUB_ABI, functionName, args, label: action });
  const pct = c.merkleRoot && BigInt(c.totalAllocated) > 0n ? Number((BigInt(c.claimed) * 10000n) / BigInt(c.totalAllocated)) / 100 : 0;
  const days = Number(extendDays);
  const validDays = Number.isInteger(days) && days >= 1 && days <= 365;

  let action = null;
  if (own && tx.status !== 'success') {
    if (status === 'scheduled') {
      action = (
        <TxButton tx={tx} size="sm" variant="secondary" onClick={() => call('cancel', [id], 'Cancel campaign')} busyLabel="Cancelling...">
          Cancel
        </TxButton>
      );
    } else if (status === 'refundable') {
      action = (
        <TxButton tx={tx} size="sm" variant="warn" onClick={() => call('refundUnpublished', [id], 'Take back the pool')} busyLabel="Refunding...">
          Take back pool
        </TxButton>
      );
    } else if (status === 'live') {
      action = (
        <Button size="sm" onClick={() => setExtendDays(extendDays == null ? '7' : null)} disabled={tx.busy}>
          Extend claim
        </Button>
      );
    }
  }
  if (status === 'ended' && tx.status !== 'success') {
    action = (
      <TxButton tx={tx} size="sm" variant="secondary" onClick={() => call('finalize', [id], 'Close campaign')} busyLabel="Closing...">
        Close
      </TxButton>
    );
  }

  return (
    <>
      <div className="pl-place-row">
        <div className="pl-place-row-main">
          <Link className="pl-place-row-title" to={campaignPath(c)}>
            {campaignTitle(c, meta)}
          </Link>
          <span className="pl-place-row-sub">
            #{c.id} · {assetLabel(c.targetMeta, c.target)} · {nextStep(c, status, now)}
          </span>
          {c.merkleRoot && <ProgressBar value={pct} max={100} style={{ marginTop: 6, maxWidth: 260 }} />}
        </div>
        <div className="pl-place-row-amount">
          {formatToken(c.pool, c.rewardMeta, { compact: true })}
          <div className="pl-place-row-sub">{c.merkleRoot ? `${pct}% claimed` : 'pool'}</div>
        </div>
        <StatusBadge status={status} />
        {c.hidden && (
          <Badge tone="warn">
            <EyeOff size={11} /> Hidden
          </Badge>
        )}
        {action && <div className="pl-place-row-actions">{action}</div>}
      </div>
      {(extendDays != null || tx.status === 'error' || tx.status === 'success') && (
        <div className="pl-place-row-extra pl-place-form">
          {extendDays != null && tx.status !== 'success' && (
            <>
              <label className="pl-place-field">
                <span>Add days to the claim window (now until {formatUtc(c.claimEnd)})</span>
                <input className="mono" inputMode="numeric" value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
                {validDays ? (
                  <span className="pl-place-hint">New end: {formatUtc(Date.parse(c.claimEnd) + days * DAY * 1000)}. It can only move later.</span>
                ) : (
                  <span className="pl-place-hint error">From 1 to 365 days</span>
                )}
              </label>
              <div className="pl-place-actions">
                <Button size="sm" variant="ghost" onClick={() => setExtendDays(null)} disabled={tx.busy}>
                  Back
                </Button>
                <TxButton
                  tx={tx}
                  size="sm"
                  disabled={!validDays}
                  onClick={() => call('extendClaim', [id, BigInt(Math.floor(Date.parse(c.claimEnd) / 1000) + days * DAY)], 'Extend claim window')}
                  busyLabel="Extending..."
                >
                  Extend by {validDays ? days : '…'} day{days === 1 ? '' : 's'}
                </TxButton>
              </div>
            </>
          )}
          <TxResult tx={tx} success="Done. The list updates within a minute" />
        </div>
      )}
    </>
  );
}

export default function MyCampaignsPage() {
  const { address: own } = usePlaceAccount();
  const [lookup, setLookup] = useState(null);
  const creator = lookup || own;
  const campaigns = useCampaigns({ creator, status: 'all', includeHidden: 1, limit: 100 }, { enabled: Boolean(creator) });
  const collections = useCollections({ creator, limit: 100 }, { enabled: Boolean(creator) });
  const list = campaigns.data?.campaigns || [];
  const cols = collections.data?.collections || [];
  const isOwn = Boolean(own) && creator === own;
  const create = (
    <Button as={Link} to="/create" variant="primary">
      Create
    </Button>
  );

  return (
    <div className="pl-launch-console-section pl-place-mine">
      <div className="pl-launch-console-head row">
        <div>
          <h2 className="pl-launch-console-title">Campaigns</h2>
          <p className="pl-launch-section-desc">Campaigns and NFT collections you created, with what you can do with them right now</p>
        </div>
        {own ? create : null}
      </div>
      {!creator ? (
        <Card className="pl-place-section">
          <EmptyState icon={<Wallet size={28} />} title="Log in to see your campaigns" description="Connect the wallet you created them with, or look up any creator" action={<ConnectButton />} />
          <AddressLookup onCheck={setLookup} placeholder="Creator address, 0x..." />
        </Card>
      ) : (
        <>
          {lookup && (
            <div className="pl-place-table-tools">
              <span>
                Campaigns created by <span className="mono">{shortAddress(lookup)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setLookup(null)}>
                {own ? 'Back to mine' : 'Clear'}
              </Button>
            </div>
          )}
          <section className="pl-place-section">
            <SectionTitle title="Campaigns" count={campaigns.data ? list.length : undefined} />
            {campaigns.isLoading ? (
              <Skeleton height={160} />
            ) : campaigns.isError ? (
              <QueryError error={campaigns.error} retry={campaigns.refetch} />
            ) : list.length ? (
              <div className="pl-place-rows">
                {list.map((c) => (
                  <CampaignRow key={`${c.hub}:${c.id}`} c={c} own={isOwn} />
                ))}
              </div>
            ) : (
              <Card className="pl-place-empty-card">
                <EmptyState icon={<LayoutDashboard size={28} />} title="No campaigns yet" description="Reward the holders of any token or NFT, funded in one transaction" action={create} />
              </Card>
            )}
          </section>

          <section className="pl-place-section">
            <SectionTitle title="NFT collections" count={collections.data ? cols.length : undefined} />
            {collections.isLoading ? (
              <Skeleton height={80} />
            ) : collections.isError ? (
              <QueryError error={collections.error} retry={collections.refetch} />
            ) : cols.length ? (
              <div className="pl-place-rows">
                {cols.map((col) => (
                  <div className="pl-place-row" key={col.address}>
                    <div className="pl-place-row-main">
                      <Link className="pl-place-row-title" to={tokenPath(col.address)}>
                        {col.name || shortAddress(col.address)} {col.symbol && <span className="pl-place-muted">{col.symbol}</span>}
                      </Link>
                      <span className="pl-place-row-sub">Deployed {formatUtc(col.createdAt)}</span>
                    </div>
                    <AddressLink address={col.address} />
                  </div>
                ))}
              </div>
            ) : (
              <Card className="pl-place-empty-card">
                <EmptyState
                  icon={<Sparkles size={28} />}
                  title="No collections yet"
                  description="Launch an NFT collection with a mint price, buyback and royalties"
                  action={
                    <Button as={Link} to="/launch/nft">
                      Create a collection
                    </Button>
                  }
                />
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}
