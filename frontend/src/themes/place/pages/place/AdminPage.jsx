// Admin: storefront moderation — hide or show a campaign, a token or a collection (POST admin/hide,
// signed over moderationMessage). Moderation never touches funds, and hidden campaigns stay claimable.
// Platform settings (fees, publisher, pause) live in PlaceConfig and change through the Safe; here they are read-only.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallets } from '@privy-io/react-auth';
import { toHex, isAddress } from 'viem';
import { Shield, Eye, EyeOff, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, SectionTitle, EmptyState, Button, Alert, Badge } from '../../components/ui';
import { useCampaigns, useCampaignMeta, usePlaceAccount, placeKeys } from '../../../../place/hooks';
import { placeApi } from '../../../../place/api';
import { PLACE_CHAIN_ID, placeClient, placeDeployment } from '../../../../place/chain';
import { PLACE_CONFIG_ABI } from '../../../../place/abi';
import { moderationMessage, isPlaceAdmin } from '../../../../place/moderation';
import { viewStatus } from '../../../../place/status';
import { isWalletRejection, connectedWallet } from '../../../../config/walletTx';
import { formatToken, assetLabel } from '../../../../place/format';
import { StatusBadge, AddressLink, ConnectButton, QueryError, Skeleton, campaignTitle, campaignPath } from './parts';

/** Signs and sends one moderation request; returns { busy, error, done, run }. */
function useModerate() {
  const { wallets } = useWallets();
  const { address } = usePlaceAccount();
  const queryClient = useQueryClient();
  const [state, setState] = useState({ busy: null, error: null, done: null });
  const run = async ({ action, type, target, reason }) => {
    const key = `${type}:${target}`;
    setState({ busy: key, error: null, done: null });
    try {
      const wallet = connectedWallet(wallets, address);
      const issuedAt = new Date().toISOString();
      const admin = wallet.address.toLowerCase();
      const message = moderationMessage({ admin, chainId: PLACE_CHAIN_ID, action, type, target, issuedAt });
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
      await placeApi.hide({ action, type, target, admin, issuedAt, signature, reason });
      setState({ busy: null, error: null, done: `${action === 'hide' ? 'Hidden' : 'Shown again'}: ${type} ${target}` });
      queryClient.invalidateQueries({ queryKey: placeKeys.all });
    } catch (e) {
      setState({ busy: null, error: isWalletRejection(e) ? null : e.message, done: null });
    }
  };
  return { ...state, run };
}

function ConfigCard() {
  const d = placeDeployment();
  const q = useQuery({
    queryKey: ['place-config-admin', PLACE_CHAIN_ID],
    queryFn: async () => {
      const read = (functionName) => placeClient().readContract({ address: d.config, abi: PLACE_CONFIG_ABI, functionName });
      const [owner, treasury, publisher, feeBps, nftDeployFee, paused, activeHub] = await Promise.all(
        ['owner', 'treasury', 'publisher', 'feeBps', 'nftDeployFee', 'newCampaignsPaused', 'activeHub'].map(read)
      );
      return { owner, treasury, publisher, feeBps: Number(feeBps), nftDeployFee, paused, activeHub };
    },
  });
  const c = q.data;
  return (
    <Card>
      <h2 className="pl-place-card-title">PlaceConfig</h2>
      {q.isLoading ? (
        <Skeleton height={200} />
      ) : q.isError ? (
        <QueryError error={q.error} retry={q.refetch} />
      ) : (
        <>
          <dl className="pl-place-kv">
            <div><dt>Contract</dt><dd><AddressLink address={d.config} /></dd></div>
            <div><dt>Owner (Safe)</dt><dd><AddressLink address={c.owner} /></dd></div>
            <div><dt>Treasury</dt><dd><AddressLink address={c.treasury} /></dd></div>
            <div><dt>Publisher</dt><dd><AddressLink address={c.publisher} /></dd></div>
            <div><dt>Active hub</dt><dd><AddressLink address={c.activeHub} /></dd></div>
            <div><dt>Campaign fee</dt><dd className="mono">{c.feeBps / 100}%</dd></div>
            <div><dt>NFT deploy fee</dt><dd className="mono">{formatToken(c.nftDeployFee, { symbol: 'ETH', decimals: 18 })}</dd></div>
            <div><dt>New campaigns</dt><dd>{c.paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="success">Open</Badge>}</dd></div>
          </dl>
          <p className="pl-place-hint" style={{ marginTop: 12 }}>Fees, treasury, publisher and the pause change only through the owner Safe.</p>
        </>
      )}
    </Card>
  );
}

function ModerateRow({ c, mod }) {
  const { data: meta } = useCampaignMeta(c);
  const target = `${c.hub}:${c.id}`;
  const busy = mod.busy === `campaign:${target}`;
  return (
    <div className="pl-place-row">
      <div className="pl-place-row-main">
        <Link className="pl-place-row-title" to={campaignPath(c)}>
          {campaignTitle(c, meta)}
        </Link>
        <span className="pl-place-row-sub">
          #{c.id} · {assetLabel(c.targetMeta, c.target)} · by {c.creator.slice(0, 8)}...
        </span>
      </div>
      <StatusBadge status={viewStatus(c)} />
      {c.hidden && <Badge tone="warn">Hidden</Badge>}
      <div className="pl-place-row-actions">
        <Button size="sm" variant={c.hidden ? 'secondary' : 'ghost'} disabled={Boolean(mod.busy)} onClick={() => mod.run({ action: c.hidden ? 'unhide' : 'hide', type: 'campaign', target })}>
          {busy ? <Loader2 size={14} className="spin" /> : c.hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          {c.hidden ? 'Show' : 'Hide'}
        </Button>
      </div>
    </div>
  );
}

function AssetForm({ mod }) {
  const [type, setType] = useState('asset');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const valid = isAddress(target.trim(), { strict: false });
  const go = (action) => mod.run({ action, type, target: target.trim().toLowerCase(), reason: reason.trim() || undefined });
  return (
    <Card className="pl-place-form">
      <h2 className="pl-place-card-title">Token or collection</h2>
      <div className="pl-place-row2">
        <label className="pl-place-field">
          <span>What</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="asset">A token or NFT (every campaign for it)</option>
            <option value="collection">A Place NFT collection</option>
          </select>
        </label>
        <label className="pl-place-field">
          <span>Address</span>
          <input className="mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x..." spellCheck={false} />
        </label>
      </div>
      {type === 'asset' && (
        <label className="pl-place-field">
          <span>Reason (optional)</span>
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Scam token, impersonation..." />
        </label>
      )}
      <div className="pl-place-actions">
        <Button disabled={!valid || Boolean(mod.busy)} onClick={() => go('unhide')}>
          <Eye size={14} /> Show
        </Button>
        <Button variant="primary" disabled={!valid || Boolean(mod.busy)} onClick={() => go('hide')}>
          <EyeOff size={14} /> Hide
        </Button>
      </div>
    </Card>
  );
}

export default function AdminPage() {
  const { address } = usePlaceAccount();
  const admin = isPlaceAdmin(address);
  const mod = useModerate();
  const campaigns = useCampaigns({ status: 'all', includeHidden: 1, limit: 100 }, { enabled: admin });
  const list = campaigns.data?.campaigns || [];

  return (
    <div className="pl-place-admin">
      <PageHeader title="Admin" description="Storefront moderation and the platform settings in PlaceConfig" />
      {!admin ? (
        <Card className="pl-place-empty-card">
          <EmptyState
            icon={<Shield size={28} />}
            title={address ? 'This wallet is not a Place admin' : 'Admins only'}
            description="Moderation is signed by an admin wallet and checked by the server"
            action={address ? null : <ConnectButton />}
          />
        </Card>
      ) : (
        <>
          <Alert tone="info" icon={<Shield size={16} />} className="pl-place-section">
            Hiding only removes something from Explore and token pages. Funds are never touched, and hidden campaigns stay claimable.
            Each change asks your wallet to sign a message (no transaction, no gas).
          </Alert>
          {mod.error && <Alert tone="danger" icon={<AlertTriangle size={16} />} className="pl-place-section">{mod.error}</Alert>}
          {mod.done && <Alert tone="success" icon={<CheckCircle2 size={16} />} className="pl-place-section">{mod.done}</Alert>}
          <div className="pl-place-cols">
            <section className="pl-place-stack">
              <SectionTitle title="Campaigns" count={campaigns.data ? list.length : undefined} />
              {campaigns.isLoading ? (
                <Skeleton height={160} />
              ) : campaigns.isError ? (
                <QueryError error={campaigns.error} retry={campaigns.refetch} />
              ) : (
                <div className="pl-place-rows">
                  {list.map((c) => (
                    <ModerateRow key={`${c.hub}:${c.id}`} c={c} mod={mod} />
                  ))}
                </div>
              )}
              <AssetForm mod={mod} />
            </section>
            <div className="pl-place-stack">
              <ConfigCard />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
