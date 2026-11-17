// Campaign page: rules from rulesURI, pool, timeline, "are you eligible?", Claim, and the
// snapshot table from proofsURI that anyone can check against the root stored in the hub.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ShieldCheck, ShieldAlert, Wallet, ExternalLink, Table2, EyeOff, AlertTriangle } from 'lucide-react';
import { keccak256, toBytes } from 'viem';
import { Card, Tile, Alert, Button, EmptyState, ProgressBar, SectionTitle } from '../../components/ui';
import { useCampaign, useCampaignMeta, useIpfsJson, useNow, usePlaceAccount, usePlaceTx } from '../../../../place/hooks';
import { PLACE_HUB_ABI } from '../../../../place/abi';
import { explorerTx } from '../../../../place/chain';
import { viewStatus } from '../../../../place/status';
import { canonicalJson } from '../../../../place/snapshot/rules';
import { formatAmount, formatToken, formatUtc, countdown, ipfsUrl, assetLabel, shortAddress, days } from '../../../../place/format';
import {
  StatusBadge,
  Amount,
  AddressLink,
  CopyAddress,
  TxButton,
  TxResult,
  ConnectButton,
  AddressLookup,
  QueryError,
  Skeleton,
  Banner,
  campaignTitle,
  tokenPath,
} from './parts';

const AUTO_TABLE_WALLETS = 2000;
const TABLE_PAGE = 200;

function Timeline({ c, status, snapshot, now }) {
  const nowMs = now;
  const snapAt = Date.parse(c.snapshotAt);
  const steps = [
    {
      title: 'Created and funded',
      sub: c.createdTx ? (
        <a className="pl-place-link" href={explorerTx(c.createdTx)} target="_blank" rel="noopener noreferrer">
          {formatUtc(c.createdAt)} <ExternalLink size={12} />
        </a>
      ) : (
        formatUtc(c.createdAt)
      ),
      state: 'done',
    },
  ];
  if (status === 'cancelled') {
    steps.push({ title: 'Cancelled before the snapshot', sub: 'The pool went back to the creator', state: 'done' });
  } else {
    steps.push({
      title: 'Snapshot',
      sub: nowMs < snapAt ? `${formatUtc(c.snapshotAt)} · in ${countdown(c.snapshotAt, nowMs)}` : formatUtc(c.snapshotAt),
      state: nowMs >= snapAt ? 'done' : 'current',
    });
    let table = { title: 'Table published', sub: 'Place computes the table and publishes its root', state: 'todo' };
    if (c.merkleRoot) table = { title: 'Table published', sub: 'The root is stored in the hub', state: 'done' };
    else if (snapshot?.status === 'rejected') table = { title: 'Snapshot rejected', sub: snapshot.error || 'The table could not be computed', state: 'failed' };
    else if (status === 'snapshotting') table = { title: 'Computing the table', sub: `Refundable from ${formatUtc(c.refundableAt)} if no root is published`, state: 'current' };
    else if (status === 'refundable' || status === 'refunded') table = { title: 'No table published in 72 hours', sub: 'The creator can take the pool back', state: 'failed' };
    steps.push(table);
    if (status === 'refunded') {
      steps.push({ title: 'Refunded', sub: 'The pool and the fee went back to the creator', state: 'done' });
    } else {
      steps.push({
        title: 'Claim window',
        sub: c.claimEnd
          ? status === 'live'
            ? `Until ${formatUtc(c.claimEnd)} · ${countdown(c.claimEnd, nowMs)} left`
            : `Ended ${formatUtc(c.claimEnd)}`
          : `${days(c.claimDuration)} from the publication`,
        state: status === 'live' ? 'current' : ['ended', 'closed'].includes(status) ? 'done' : 'todo',
      });
      steps.push({
        title: status === 'closed' ? 'Closed' : 'Close',
        sub: c.leftover === 'burn' ? 'What nobody claimed is burned' : 'What nobody claimed goes back to the creator',
        state: status === 'closed' ? 'done' : status === 'ended' ? 'current' : 'todo',
      });
    }
  }
  return (
    <ol className="pl-place-timeline">
      {steps.map((s) => (
        <li key={s.title} className={s.state}>
          <span className="pl-place-timeline-dot" />
          <div className="pl-place-timeline-title">{s.title}</div>
          <div className="pl-place-timeline-sub">{s.sub}</div>
        </li>
      ))}
    </ol>
  );
}

function Rules({ c }) {
  const q = useIpfsJson(c.rulesURI);
  const rules = q.data;
  const verified = useMemo(() => {
    if (!rules) return null;
    try {
      return keccak256(toBytes(canonicalJson(rules))) === c.rulesHash;
    } catch (e) {
      return false;
    }
  }, [rules, c.rulesHash]);
  const nft = c.kind === 'nft-holders';
  const targetUnits = (v) => (nft ? `${v} NFT` : formatToken(v, c.targetMeta));
  return (
    <Card>
      <h2 className="pl-place-card-title">Rules</h2>
      {q.isLoading ? (
        <Skeleton height={160} />
      ) : q.isError ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : rules ? (
        <>
          <dl className="pl-place-kv">
            <div>
              <dt>Who</dt>
              <dd>
                {nft ? 'Holders of the NFT collection' : 'Holders of the token'}{' '}
                <Link className="pl-place-link" to={tokenPath(c.target)}>
                  {assetLabel(c.targetMeta, c.target)}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Minimum to qualify</dt>
              <dd className="mono">{targetUnits(rules.minBalance)}</dd>
            </div>
            <div>
              <dt>Split</dt>
              <dd>{rules.distribution === 'equal' ? 'Equal for every wallet' : nft ? 'In proportion to NFTs held' : 'In proportion to balance'}</dd>
            </div>
            <div>
              <dt>Max per wallet</dt>
              <dd className="mono">{rules.maxPerWallet ? formatToken(rules.maxPerWallet, c.rewardMeta) : 'No limit'}</dd>
            </div>
            <div>
              <dt>Excluded</dt>
              <dd>
                LP pools, zero and dead addresses, the hub
                {rules.exclude.length ? ` and ${rules.exclude.length} more set by the creator` : ''}
              </dd>
            </div>
            <div>
              <dt>Claim window</dt>
              <dd>{days(rules.claimDuration)} from the publication</dd>
            </div>
            <div>
              <dt>Leftover</dt>
              <dd>{rules.leftover === 'burn' ? 'Burned' : 'Returned to the creator'}</dd>
            </div>
          </dl>
          <div style={{ marginTop: 14 }}>
            {verified ? (
              <Alert tone="success" icon={<ShieldCheck size={16} />}>
                These rules match the hash stored in the hub.{' '}
                <a className="pl-place-link" href={ipfsUrl(c.rulesURI)} target="_blank" rel="noopener noreferrer">
                  Rules file <ExternalLink size={12} />
                </a>
              </Alert>
            ) : (
              <Alert tone="danger" icon={<ShieldAlert size={16} />}>
                These rules do not match the hash stored in the hub. Place will not publish a table for them.
              </Alert>
            )}
          </div>
        </>
      ) : null}
    </Card>
  );
}

function YourReward({ c, status, address, setAddress, own, you, loading }) {
  const tx = usePlaceTx();
  const amountText = you?.amount ? formatToken(you.amount, c.rewardMeta) : null;
  const claim = () =>
    tx.send({
      to: c.hub,
      abi: PLACE_HUB_ABI,
      functionName: 'claim',
      args: [BigInt(c.id), BigInt(you.amount), you.proof],
      label: 'Claim',
    });

  let body;
  if (!address) {
    body = (
      <div className="pl-place-you">
        <p className="pl-place-hint">Connect wallet to verify, or check any address.</p>
        <ConnectButton />
        <AddressLookup onCheck={setAddress} />
      </div>
    );
  } else if (!c.merkleRoot) {
    body = (
      <div className="pl-place-you">
        <p className="pl-place-hint">
          {status === 'scheduled'
            ? `Eligibility is decided by balances at the snapshot, ${formatUtc(c.snapshotAt)}. Hold at least the minimum by then.`
            : 'The table is not published yet. Eligibility shows here once it is.'}
        </p>
      </div>
    );
  } else if (loading) {
    body = <Skeleton height={80} />;
  } else if (!you?.eligible) {
    body = (
      <div className="pl-place-you">
        <StatusBadgeText tone="danger">Not eligible</StatusBadgeText>
        <p className="pl-place-hint">{shortAddress(address)} is not in this snapshot table.</p>
      </div>
    );
  } else {
    const claimed = you.claimed || tx.status === 'success';
    body = (
      <div className="pl-place-you">
        <StatusBadgeText tone={claimed ? 'success' : 'success'}>{claimed ? 'Claimed' : 'Eligible'}</StatusBadgeText>
        <div className="pl-place-you-amount">{amountText}</div>
        {!claimed && status === 'live' && own && (
          <TxButton tx={tx} onClick={claim} size="lg" fullWidth busyLabel="Claiming on Base...">
            Claim
          </TxButton>
        )}
        {!claimed && status === 'live' && !own && <p className="pl-place-hint">Connect this wallet to claim, or claim from My rewards.</p>}
        {!claimed && status !== 'live' && <p className="pl-place-hint">The claim window has ended.</p>}
        {you.claimTx && (
          <a className="pl-place-link" href={explorerTx(you.claimTx)} target="_blank" rel="noopener noreferrer">
            Claim transaction <ExternalLink size={12} />
          </a>
        )}
        <TxResult tx={tx} success="Claimed" />
      </div>
    );
  }
  return (
    <Card>
      <h2 className="pl-place-card-title">Your reward</h2>
      {address && (
        <div className="pl-place-table-tools">
          <span className="mono">
            <Wallet size={13} /> {shortAddress(address)}
          </span>
          {!own && (
            <Button size="sm" variant="ghost" onClick={() => setAddress(null)}>
              Clear
            </Button>
          )}
        </div>
      )}
      {body}
    </Card>
  );
}

function StatusBadgeText({ tone, children }) {
  return <span className={`badge badge-pill badge-${tone}`} style={{ alignSelf: 'flex-start' }}>{children}</span>;
}

function SnapshotTable({ c, wallets, highlight }) {
  const [load, setLoad] = useState(wallets <= AUTO_TABLE_WALLETS);
  const [search, setSearch] = useState('');
  const [check, setCheck] = useState(null);
  const q = useIpfsJson(load ? c.proofsURI : null);
  const table = q.data;
  const rows = useMemo(() => {
    if (!table?.entries) return [];
    return table.entries
      .map((e) => ({ ...e, amountN: BigInt(e.amount) }))
      .sort((a, b) => (a.amountN === b.amountN ? 0 : a.amountN > b.amountN ? -1 : 1))
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }, [table]);
  const term = search.trim().toLowerCase();
  const shown = term ? rows.filter((r) => r.account.includes(term)) : rows.slice(0, TABLE_PAGE);
  const nft = c.kind === 'nft-holders';

  const verify = async () => {
    try {
      const { verifyTable } = await import('../../../../place/snapshot/tree');
      verifyTable(table);
      if (table.merkleRoot !== c.merkleRoot) throw new Error('The table root is not the root stored in the hub');
      setCheck({ ok: true });
    } catch (e) {
      setCheck({ ok: false, message: e.message });
    }
  };

  if (!c.proofsURI) {
    return (
      <Card className="pl-place-empty-card">
        <EmptyState icon={<Table2 size={28} />} title="No table yet" description="The snapshot table appears here once Place publishes it" />
      </Card>
    );
  }
  if (!load) {
    return (
      <Card className="pl-place-empty-card">
        <EmptyState
          icon={<Table2 size={28} />}
          title={`${wallets.toLocaleString('en-US')} wallets in the table`}
          description="A big table: load it from IPFS when you need it"
          action={<Button onClick={() => setLoad(true)}>Load the table</Button>}
        />
      </Card>
    );
  }
  if (q.isLoading) return <Skeleton height={240} />;
  if (q.isError) return <QueryError error={q.error} retry={q.refetch} />;
  return (
    <div>
      <div className="pl-place-table-tools">
        <span>
          Block <span className="mono">{table.snapshot?.block}</span> · {formatUtc(table.snapshot?.timestamp * 1000)} ·{' '}
          <a className="pl-place-link" href={ipfsUrl(c.proofsURI)} target="_blank" rel="noopener noreferrer">
            Table file <ExternalLink size={12} />
          </a>
        </span>
        <Button size="sm" onClick={verify}>
          <ShieldCheck size={14} /> Verify table
        </Button>
      </div>
      {check && (
        <Alert tone={check.ok ? 'success' : 'danger'} icon={check.ok ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />} style={{ marginBottom: 12 }}>
          {check.ok ? 'Recomputed in your browser: the entries give exactly the root stored in the hub, and the total fits the pool.' : check.message}
        </Alert>
      )}
      <input
        className="pl-place-input mono"
        style={{ marginBottom: 12 }}
        placeholder="Find a wallet, 0x..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Find a wallet in the table"
      />
      <div className="pl-schedule-card pl-place-table">
        <div className="pl-schedule-head">
          <span>#</span>
          <span>Wallet</span>
          <span>{nft ? 'NFTs held' : 'Balance'}</span>
          <span>Reward</span>
        </div>
        <div className="pl-schedule-scroll">
          {shown.map((r) => (
            <div key={r.account} className={`pl-schedule-row ${r.account === highlight ? 'you' : ''}`.trim()}>
              <span className="pl-place-table-cell num">{r.rank}</span>
              <span className="pl-place-table-cell">
                <AddressLink address={r.account} />
                {r.account === highlight && <span className="pl-place-muted"> · you</span>}
              </span>
              <span className="pl-place-table-cell num">
                <span className="pl-place-table-label">{nft ? 'NFTs' : 'Balance'}</span>
                {nft ? r.balance : formatAmount(r.balance, c.targetMeta?.decimals ?? 18, { compact: true })}
              </span>
              <span className="pl-place-table-cell num">
                <span className="pl-place-table-label">Reward</span>
                {formatToken(r.amount, c.rewardMeta)}
                {r.capped && <span className="pl-place-muted"> · max</span>}
              </span>
            </div>
          ))}
          {!shown.length && <div className="pl-schedule-row"><span className="pl-place-table-cell">No wallet matches</span></div>}
        </div>
      </div>
      {!term && rows.length > TABLE_PAGE && (
        <p className="pl-place-hint" style={{ marginTop: 8 }}>
          Showing the top {TABLE_PAGE} of {rows.length.toLocaleString('en-US')} wallets. Search to find any other.
        </p>
      )}
    </div>
  );
}

function Finalize({ c }) {
  const tx = usePlaceTx();
  return (
    <Card>
      <h2 className="pl-place-card-title">Close the campaign</h2>
      <p className="pl-place-hint" style={{ marginBottom: 12 }}>
        The claim window is over. Anyone can close the campaign: what nobody claimed is then{' '}
        {c.leftover === 'burn' ? 'burned' : 'returned to the creator'}.
      </p>
      <TxButton
        tx={tx}
        variant="secondary"
        onClick={() =>
          tx.send({ to: c.hub, abi: PLACE_HUB_ABI, functionName: 'finalize', args: [BigInt(c.id)], label: 'Finalize' })
        }
      >
        Close campaign
      </TxButton>
      <div style={{ marginTop: 12 }}>
        <TxResult tx={tx} success="Campaign closed" />
      </div>
    </Card>
  );
}

export default function CampaignPage() {
  const { hub, id } = useParams();
  const { address: own } = usePlaceAccount();
  const [lookup, setLookup] = useState(null);
  const address = lookup || own;
  const q = useCampaign({ hub, id, address });
  const c = q.data?.campaign;
  const { data: meta } = useCampaignMeta(c);
  const now = useNow(1000);

  const back = (
    <Link to="/hub" className="pl-place-back">
      <ArrowLeft size={14} /> All rewards
    </Link>
  );
  if (q.isLoading) {
    return (
      <>
        {back}
        <Skeleton height={420} />
      </>
    );
  }
  if (q.isError || !c) {
    return (
      <>
        {back}
        <QueryError error={q.error || new Error('Campaign not found')} retry={q.refetch} />
      </>
    );
  }

  const status = viewStatus(c, Math.floor(now / 1000));
  const title = campaignTitle(c, meta);
  const claimedPct = c.totalAllocated && BigInt(c.totalAllocated) > 0n ? Number((BigInt(c.claimed) * 10000n) / BigInt(c.totalAllocated)) / 100 : 0;
  const stats = q.data.stats || {};

  return (
    <div className="pl-place-campaign">
      {back}
      {meta?.image && (
        <div className="pl-place-hero">
          <Banner meta={meta} alt="" />
        </div>
      )}
      <div className="pl-place-head">
        <div className="pl-place-head-main">
          <h1 className="page-title">{title}</h1>
          <div className="pl-place-head-sub">
            <StatusBadge status={status} />
            <span>{c.kind === 'nft-holders' ? 'NFT holder rewards' : 'Token holder rewards'}</span>
            <span className="pl-place-muted">·</span>
            <span>
              by <AddressLink address={c.creator} />
            </span>
          </div>
        </div>
      </div>

      {c.hidden && (
        <Alert tone="warn" icon={<EyeOff size={16} />} className="pl-place-section">
          This campaign is hidden from Explore by Place moderation. Claims keep working.
        </Alert>
      )}

      <div className="pl-place-tiles">
        <Tile label="Pool" value={<Amount raw={c.pool} meta={c.rewardMeta} compact />} sub={`+ ${formatToken(c.fee, c.rewardMeta)} Place fee`} />
        <Tile
          label="Claimed"
          value={<Amount raw={c.claimed} meta={c.rewardMeta} compact />}
          sub={c.merkleRoot ? `${claimedPct}% of ${formatToken(c.totalAllocated, c.rewardMeta, { compact: true })}` : 'Opens after the snapshot'}
        >
          {c.merkleRoot && <ProgressBar value={claimedPct} max={100} />}
        </Tile>
        <Tile label="Wallets" value={<span className="mono">{c.merkleRoot ? (stats.wallets ?? 0).toLocaleString('en-US') : '—'}</span>} sub={c.merkleRoot ? `${stats.claims ?? 0} claimed` : 'In the table after the snapshot'} />
      </div>

      <div className="pl-place-cols">
        <div className="pl-place-stack">
          {meta?.description && (
            <Card>
              <h2 className="pl-place-card-title">About</h2>
              <p className="pl-place-desc">{meta.description}</p>
            </Card>
          )}
          <Rules c={c} />
        </div>
        <div className="pl-place-stack">
          <YourReward c={c} status={status} address={address} setAddress={setLookup} own={Boolean(own) && address === own} you={q.data.you} loading={q.isPlaceholderData} />
          <Card>
            <h2 className="pl-place-card-title">Timeline</h2>
            <Timeline c={c} status={status} snapshot={q.data.snapshot} now={now} />
          </Card>
          {status === 'ended' && <Finalize c={c} />}
          <Card>
            <h2 className="pl-place-card-title">Contract</h2>
            <dl className="pl-place-kv">
              <div>
                <dt>Hub</dt>
                <dd>
                  <AddressLink address={c.hub} /> <CopyAddress address={c.hub} />
                </dd>
              </div>
              <div>
                <dt>Campaign ID</dt>
                <dd className="mono">{c.id}</dd>
              </div>
              <div>
                <dt>Reward token</dt>
                <dd>{c.rewardToken === 'eth' ? 'ETH' : <AddressLink address={c.rewardToken} label={assetLabel(c.rewardMeta, c.rewardToken)} />}</dd>
              </div>
              <div>
                <dt>Merkle root</dt>
                <dd className="mono">{c.merkleRoot ? `${c.merkleRoot.slice(0, 10)}...${c.merkleRoot.slice(-6)}` : '—'}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>

      <section className="pl-place-section">
        <SectionTitle title="Snapshot table" count={c.merkleRoot ? stats.wallets : undefined} />
        <SnapshotTable c={c} wallets={stats.wallets || 0} highlight={address} />
      </section>
    </div>
  );
}
