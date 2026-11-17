// One reward stream of the Rewards hub (/hub?stream=<id>): what it pays and for what, the wallet's claim, the
// days with their tables, and the calls anyone can make (close a finished day; return the unallocated budget to
// the funder 30 days after the last day). Every call goes through usePlaceTx (Builder Code).
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, Rocket, Sparkles } from 'lucide-react';
import { Alert, Badge, Card, Tile } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, QueryError, Skeleton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx, useNow } from '../../place/hooks';
import { formatUtc, countdown, ipfsUrl } from '../../place/format';
import { useHubStream } from '../hooks.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../abi.js';
import { usd } from '../format.js';
import { launchTokenPath } from './parts.jsx';
import { PairLogos, PhaseBadge, CopyId, amountText, conditionText, SOURCE_BADGE } from './vaults.jsx';

const TABLE_STATUS = {
  published: ['Published', 'success'],
  sent: ['Publishing', 'accent'],
  built: ['Publishing', 'accent'],
  empty: ['No one eligible, rolls over', 'neutral'],
  failed: ['Retrying', 'warn'],
};
const TYPE_TEXT = { holders: 'Holder rewards', traders: 'Trader rewards', nft: 'NFT holder rewards' };
const SOURCE_TEXT = {
  economy: 'The token’s own tax: part of every trade funds this stream each day',
  pool: 'The token’s Community Pool, set up by its creator',
  creator: 'The token’s creator, from their wallet',
  community: 'A wallet in the community',
};

function YourReward({ s, mine, account }) {
  const tx = usePlaceTx();
  const r = s.rewardToken;
  if (!account) {
    return (
      <div className="pl-launch-your-reward">
        <span className="pl-launch-muted pl-launch-small">Connect wallet to see what you can claim.</span>
        <ConnectButton size="sm" />
      </div>
    );
  }
  const item = mine?.item;
  const claimable = BigInt(item?.claimable || 0);
  return (
    <div className="pl-launch-your-reward">
      <div className="pl-launch-your-reward-num">
        <span className="pl-launch-muted pl-launch-small">You can claim</span>
        <span className="mono pl-launch-strong">
          {amountText(item?.claimable || 0, r.decimals)} {r.symbol}
        </span>
        {mine?.pending && (
          <span className="pl-launch-muted pl-launch-small mono">
            +{amountText(mine.pending.amount, r.decimals)} {r.symbol} being published
          </span>
        )}
        {item && BigInt(item.claimed || 0) > 0n && (
          <span className="pl-launch-muted pl-launch-small mono">
            Claimed so far {amountText(item.claimed, r.decimals)} {r.symbol}
          </span>
        )}
      </div>
      <TxButton
        tx={tx}
        size="sm"
        disabled={claimable === 0n}
        busyLabel="Claiming on Base..."
        onClick={() =>
          tx.send({ label: `Claim ${TYPE_TEXT[s.type].toLowerCase()}`, to: item.distributor, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'claim', args: [item.streamId, account, BigInt(item.cumulative), item.proof] })
        }
      >
        {claimable === 0n ? 'Nothing to claim yet' : 'Claim'}
      </TxButton>
      <TxResult tx={tx} success="Rewards claimed" />
    </div>
  );
}

function Actions({ actions, s, account }) {
  const closeTx = usePlaceTx();
  const reclaimTx = usePlaceTx();
  const r = s.rewardToken;
  const reclaim = actions.reclaim;
  if (!actions.close && !reclaim) return null;
  return (
    <Card className="pl-place-stack">
      <span className="pl-launch-section-title">Keep it running</span>
      {actions.close && (
        <div className="pl-launch-your-reward">
          <span className="pl-launch-muted pl-launch-small">
            {actions.close.days === 1 ? 'Yesterday is over but not closed yet.' : `${actions.close.days} finished days are not closed yet.`} Anyone can close them; Place does it once a day.
          </span>
          {account ? (
            <TxButton tx={closeTx} size="sm" variant="secondary" busyLabel="Closing on Base..." onClick={() => closeTx.send({ label: 'Close the finished days', to: actions.close.tx.to, data: actions.close.tx.data, value: 0n })}>
              Close the day
            </TxButton>
          ) : (
            <ConnectButton size="sm" />
          )}
        </div>
      )}
      <TxResult tx={closeTx} success="Days closed" />
      {reclaim && (
        <div className="pl-launch-your-reward">
          <span className="pl-launch-muted pl-launch-small">
            {reclaim.ready
              ? `${amountText(reclaim.amount, r.decimals)} ${r.symbol} were never shared. Anyone can send them back to the funder.`
              : `What is not shared goes back to the funder from ${formatUtc(reclaim.at)}.`}
          </span>
          {reclaim.ready &&
            (account ? (
              <TxButton tx={reclaimTx} size="sm" variant="secondary" busyLabel="Returning on Base..." onClick={() => reclaimTx.send({ label: 'Return the unallocated budget', to: reclaim.tx.to, data: reclaim.tx.data, value: 0n })}>
                Return to funder
              </TxButton>
            ) : (
              <ConnectButton size="sm" />
            ))}
        </div>
      )}
      <TxResult tx={reclaimTx} success="Returned to the funder" />
    </Card>
  );
}

export default function HubStreamDetail({ id }) {
  const navigate = useNavigate();
  const now = useNow(10_000);
  const { address } = usePlaceAccount();
  const q = useHubStream(id, address);
  const back = (
    <button type="button" className="pl-place-back" onClick={() => navigate('/hub')}>
      <ArrowLeft size={14} /> All rewards
    </button>
  );
  if (q.isLoading) return <Skeleton height={260} />;
  if (q.error) {
    return (
      <div className="pl-place-stack">
        {back}
        <QueryError error={q.error} retry={q.refetch} />
      </div>
    );
  }
  const { stream: s, mine, actions } = q.data;
  const r = s.rewardToken;
  const [sourceLabel, sourceTone] = SOURCE_BADGE[s.source] || [s.source, 'neutral'];
  const title = `${s.type === 'traders' ? 'Trade' : 'Hold'} ${s.token.symbol || ''}${s.type === 'nft' ? ' NFT' : ''} · Earn ${r.symbol || ''}`;
  return (
    <div className="pl-place-stack pl-rewards">
      {back}
      <div className="pl-vault-detail-head">
        <PairLogos a={s.token} b={r} size={40} />
        <div className="pl-vault-title">
          <h1 className="pl-vault-detail-title">{title}</h1>
          <CopyId id={s.id} title="Copy stream ID" />
        </div>
        <PhaseBadge status={s.status} />
        <Badge tone={sourceTone}>{sourceLabel}</Badge>
        {s.placeCollection ? (
          <Badge tone="neutral">
            <Sparkles size={11} /> Place collection
          </Badge>
        ) : (
          s.placeToken && (
            <Badge tone="neutral">
              <Rocket size={11} /> Launched on Place
            </Badge>
          )
        )}
      </div>
      {s.unsupported && (
        <Alert tone="warn" icon={<AlertTriangle size={16} />}>
          {s.unsupported}. Place does not build daily tables for this stream, so nobody can claim from it; its budget goes back to the funder 30 days after the last day.
        </Alert>
      )}
      <div className="pl-launch-token-tiles pl-staking-tiles">
        <Tile label={s.economy ? 'Last day' : 'Per day'} value={`${amountText(s.perDay, r.decimals)} ${r.symbol || ''}`} sub={s.perDayUsd == null ? 'UTC day' : usd(s.perDayUsd)} />
        <Tile label={s.economy ? 'Funded so far' : 'Pool'} value={`${amountText(s.pool, r.decimals)} ${r.symbol || ''}`} sub={s.poolUsd == null ? (s.economy ? 'From the tax' : `+ Place fee`) : usd(s.poolUsd)} />
        <Tile label="Shared so far" value={`${amountText(s.allocated, r.decimals)} ${r.symbol || ''}`} sub={`Claimed ${amountText(s.claimed, r.decimals)}`} />
        <Tile label={s.status === 'upcoming' ? 'Starts in' : 'Next day closes in'} value={countdown(s.status === 'upcoming' ? s.startsAt : s.nextCloseAt, now).replace(/ \d+s$/, '')} sub={formatUtc(s.status === 'upcoming' ? s.startsAt : s.nextCloseAt)} />
      </div>
      <div className="pl-place-cols">
        <Card className="pl-place-stack">
          <span className="pl-launch-section-title">{TYPE_TEXT[s.type]}</span>
          <p className="pl-launch-section-desc">
            {conditionText(s, true)}. Every UTC day the day&apos;s budget is shared between eligible wallets in proportion to their {s.type === 'traders' ? 'volume' : s.type === 'nft' ? 'NFT count' : 'balance'}. Claim any time: rewards add up and never expire.
          </p>
          <YourReward s={s} mine={mine} account={address} />
        </Card>
        <Card>
          <dl className="pl-place-kv">
            <div>
              <dt>{s.type === 'nft' ? 'Collection' : 'Token'}</dt>
              <dd>
                {s.placeToken ? (
                  <Link className="pl-place-link" to={launchTokenPath(s.token.address)}>
                    {s.token.symbol}
                  </Link>
                ) : (
                  <AddressLink address={s.token.address} label={s.token.symbol || undefined} />
                )}
              </dd>
            </div>
            <div>
              <dt>Days</dt>
              <dd className="mono">{s.epochCount ? `${s.daysDone} / ${s.epochCount}, ${formatUtc(s.startsAt)} – ${formatUtc(s.endsAt)}` : `${s.daysDone}, since ${formatUtc(s.startsAt)}`}</dd>
            </div>
            <div>
              <dt>Funded by</dt>
              <dd className="pl-launch-inline">
                {SOURCE_TEXT[s.source]}
                {!s.economy && s.funder && <AddressLink address={s.funder} />}
              </dd>
            </div>
            <div>
              <dt>Reward</dt>
              <dd>{r.address === 'eth' ? 'ETH' : <AddressLink address={r.address} label={r.symbol || undefined} />}</dd>
            </div>
            <div>
              <dt>Contract</dt>
              <dd>
                <AddressLink address={s.distributor} />
              </dd>
            </div>
          </dl>
        </Card>
      </div>
      <Actions actions={actions} s={s} account={address} />
      {s.epochs?.length > 0 && (
        <Card className="pl-place-stack">
          <span className="pl-launch-section-title">Days</span>
          <div className="pl-launch-table pl-launch-days">
            <div className="pl-launch-table-head pl-rewards-days-grid">
              <span>Day (UTC)</span>
              <span className="num">Shared</span>
              <span className="num">Wallets</span>
              <span>Table</span>
            </div>
            {s.epochs.map((e) => {
              const [label, tone] = e.table ? TABLE_STATUS[e.table.status] || [e.table.status, 'neutral'] : ['Waiting', 'neutral'];
              return (
                <div key={e.epoch} className="pl-launch-table-row pl-rewards-days-grid">
                  <span className="mono">{e.day}</span>
                  <span className="num mono">{e.table?.budget && e.table.status !== 'empty' ? `${amountText(e.table.budget, r.decimals)} ${r.symbol || ''}` : '—'}</span>
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
        </Card>
      )}
    </div>
  );
}
