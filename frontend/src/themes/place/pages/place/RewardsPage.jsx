// My rewards: what a wallet can claim across every Place campaign and hub, Claim all in one
// transaction per hub (the ready claimMany calls from GET claims), and the history.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gift, History, ExternalLink, Wallet } from 'lucide-react';
import { PageHeader, Card, SectionTitle, EmptyState, Button, StatusPill } from '../../components/ui';
import { useClaims, useCampaignMeta, useNow, usePlaceAccount, usePlaceTx } from '../../../../place/hooks';
import { PLACE_HUB_ABI } from '../../../../place/abi';
import { explorerTx } from '../../../../place/chain';
import { formatToken, formatUtc, countdown, assetLabel, shortAddress } from '../../../../place/format';
import { TxButton, TxResult, ConnectButton, AddressLookup, QueryError, Skeleton, campaignTitle, campaignPath } from './parts';

/** Sums per reward token: [{ key, raw, meta }]. */
function totals(list) {
  const m = new Map();
  for (const c of list) {
    const key = c.rewardToken;
    const prev = m.get(key) || { key, raw: 0n, meta: c.rewardMeta };
    prev.raw += BigInt(c.amount);
    m.set(key, prev);
  }
  return [...m.values()];
}

function ClaimRow({ c, account, canSend }) {
  const { data: meta } = useCampaignMeta(c);
  const now = useNow(1000);
  const tx = usePlaceTx();
  const amount = formatToken(c.amount, c.rewardMeta);
  const claim = () =>
    tx.send({
      to: c.hub,
      abi: PLACE_HUB_ABI,
      functionName: 'claimFor',
      args: [account, BigInt(c.id), BigInt(c.amount), c.proof],
      label: 'Claim',
    });
  const done = tx.status === 'success';
  return (
    <>
      <div className="pl-place-row">
        <div className="pl-place-row-main">
          <Link className="pl-place-row-title" to={campaignPath(c)}>
            {campaignTitle(c, meta)}
          </Link>
          <span className="pl-place-row-sub">
            {assetLabel(c.targetMeta, c.target)} holders · ends in <span className="mono">{countdown(c.claimEnd, now)}</span>
          </span>
        </div>
        <div className="pl-place-row-amount">{amount}</div>
        <div className="pl-place-row-actions">
          {done ? (
            <StatusPill status="claimed" tone="success" label="Claimed" />
          ) : canSend ? (
            <TxButton tx={tx} size="sm" variant="secondary" onClick={claim} busyLabel="Claiming...">
              Claim
            </TxButton>
          ) : null}
        </div>
      </div>
      {(tx.status === 'error' || done) && (
        <div className="pl-place-row-extra">
          <TxResult tx={tx} success="Claimed" />
        </div>
      )}
    </>
  );
}

function HistoryRow({ c, kind }) {
  const { data: meta } = useCampaignMeta(c);
  return (
    <div className="pl-place-row">
      <div className="pl-place-row-main">
        <Link className="pl-place-row-title" to={campaignPath(c)}>
          {campaignTitle(c, meta)}
        </Link>
        <span className="pl-place-row-sub">
          {kind === 'claimed' ? 'Claimed' : `Claim window ended ${formatUtc(c.claimEnd)}`}
          {kind === 'claimed' && c.claimTx && (
            <>
              {' · '}
              <a className="pl-place-link" href={explorerTx(c.claimTx)} target="_blank" rel="noopener noreferrer">
                Transaction <ExternalLink size={11} />
              </a>
            </>
          )}
        </span>
      </div>
      <div className="pl-place-row-amount">{formatToken(c.amount, c.rewardMeta)}</div>
      <StatusPill status={kind} tone={kind === 'claimed' ? 'success' : 'danger'} label={kind === 'claimed' ? 'Claimed' : 'Expired'} />
    </div>
  );
}

export default function RewardsPage() {
  const { address: own } = usePlaceAccount();
  const [lookup, setLookup] = useState(null);
  const account = lookup || own;
  const q = useClaims(account);
  const tx = usePlaceTx();
  const data = q.data;
  const claimable = data?.claimable || [];
  const sums = useMemo(() => totals(claimable), [claimable]);
  const history = [...(data?.claimed || []).map((c) => ({ c, kind: 'claimed' })), ...(data?.expired || []).map((c) => ({ c, kind: 'expired' }))];

  // Anyone may send claimMany for any account (the reward always goes to the account), so a connected
  // wallet can also claim for an address it is only looking at.
  const canSend = Boolean(own);
  const claimAll = () =>
    tx.send(
      data.transactions.map((t, i) => ({
        to: t.to,
        data: t.data,
        value: t.value,
        label: data.transactions.length > 1 ? `Claim all (${i + 1} of ${data.transactions.length})` : 'Claim all',
      }))
    );

  return (
    <div className="pl-place-rewards">
      <PageHeader title="My rewards" description="What your wallet can claim across every Place campaign, and what it already claimed" />

      {!account ? (
        <Card className="pl-place-section">
          <EmptyState
            icon={<Wallet size={28} />}
            title="Log in to see your rewards"
            description="Connect a wallet, or check any address without connecting"
            action={<ConnectButton />}
          />
          <AddressLookup onCheck={setLookup} />
        </Card>
      ) : (
        <>
          {lookup && (
            <div className="pl-place-table-tools">
              <span>
                Viewing <span className="mono">{shortAddress(lookup)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setLookup(null)}>
                {own ? 'Back to my wallet' : 'Clear'}
              </Button>
            </div>
          )}
          {q.isLoading ? (
            <Skeleton height={200} />
          ) : q.isError ? (
            <QueryError error={q.error} retry={q.refetch} />
          ) : (
            <>
              <section className="pl-place-section pl-place-claimable">
                <SectionTitle title="Ready to claim" count={claimable.length} />
                {claimable.length ? (
                  <>
                    <Card className="pl-place-claim-all">
                      <div>
                        <div className="tile-label">Total</div>
                        <div className="pl-place-claim-all-total">{sums.map((s) => formatToken(s.raw, s.meta)).join(' + ')}</div>
                      </div>
                      {canSend ? (
                        <TxButton tx={tx} size="lg" onClick={claimAll} disabled={tx.status === 'success'} busyLabel="Claiming on Base...">
                          {tx.status === 'success' ? 'All claimed' : `Claim all (${claimable.length})`}
                        </TxButton>
                      ) : (
                        <ConnectButton size="lg">Connect wallet to claim</ConnectButton>
                      )}
                    </Card>
                    {tx.status !== 'idle' && !tx.busy && (
                      <div className="pl-place-section">
                        <TxResult tx={tx} success="Everything is claimed" />
                      </div>
                    )}
                    <div className="pl-place-rows">
                      {claimable.map((c) => (
                        <ClaimRow key={`${c.hub}:${c.id}`} c={c} account={account} canSend={canSend} />
                      ))}
                    </div>
                  </>
                ) : (
                  <Card className="pl-place-empty-card">
                    <EmptyState
                      icon={<Gift size={28} />}
                      title="Nothing to claim right now"
                      description="Rewards appear here when a snapshot that includes this wallet is published"
                      action={
                        <Button as={Link} to="/">
                          Explore campaigns
                        </Button>
                      }
                    />
                  </Card>
                )}
              </section>

              <section className="pl-place-section">
                <SectionTitle title="History" count={history.length} />
                {history.length ? (
                  <div className="pl-place-rows">
                    {history.map(({ c, kind }) => (
                      <HistoryRow key={`${c.hub}:${c.id}`} c={c} kind={kind} />
                    ))}
                  </div>
                ) : (
                  <Card className="pl-place-empty-card">
                    <EmptyState icon={<History size={28} />} title="No history yet" description="Claimed and expired rewards are listed here" />
                  </Card>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
