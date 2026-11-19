// Register token (/projects/register): a token launched elsewhere becomes a project on Place, without a new
// contract. The page checks the token (owner() or admin() of the contract, liquidity), the creator signs a message
// with that wallet (no transaction), and the API records it: verified when the wallet controls the token and the
// liquidity is at least $10K, otherwise the Place team checks it by hand. A verified project gets its page in
// Projects; anyone can already create reward campaigns and NFT collections for any token with a swap route.
// `?token=` fills the address (Launch NFT links here for tokens without a route).
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallets } from '@privy-io/react-auth';
import { connectedWallet } from '../../config/walletTx';
import { isAddress, toHex } from 'viem';
import { AlertTriangle, ArrowLeft, BadgeCheck, CheckCircle2, Clock, Info, Loader2, PenLine, Rocket, Search, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Card, PageHeader } from '../../themes/place/components/ui';
import { ConnectButton, AddressLink } from '../../themes/place/pages/place/parts';
import { usePlaceAccount } from '../../place/hooks';
import { PLACE_CHAIN_ID, isTestnet } from '../../place/chain';
import { launchApi } from '../client.js';
import { launchKeys } from '../hooks.js';
import { registerMessage, MIN_PROJECT_LIQUIDITY_USD } from '../projects.js';
import { launchNewPath } from './parts.jsx';
import { usd } from '../format.js';

const STEPS = [
  ['Prove the token is yours', 'Use the wallet that is the owner() or admin() of the token contract. Other wallets go to a check by the Place team.'],
  ['Sign, no transaction', 'Your wallet signs a short message. It costs nothing and moves no funds.'],
  ['Get a project page', 'With at least $10K of liquidity the token gets its page in Projects, next to tokens launched on Place.'],
];

const STATUS = {
  verified: { label: 'Verified project', tone: 'success', Icon: CheckCircle2 },
  review: { label: 'In review', tone: 'warn', Icon: Clock },
  rejected: { label: 'Not accepted', tone: 'danger', Icon: XCircle },
};

function Check({ ok, warn, children }) {
  const Icon = ok ? CheckCircle2 : warn ? Clock : XCircle;
  return (
    <li className={`pl-projects-check ${ok ? 'ok' : warn ? 'warn' : 'bad'}`}>
      <Icon size={16} />
      <span>{children}</span>
    </li>
  );
}

export default function RegisterTokenPage() {
  const [params] = useSearchParams();
  const { address: account } = usePlaceAccount();
  const { wallets } = useWallets();
  const queryClient = useQueryClient();
  const [input, setInput] = useState(params.get('token') || '');
  const token = isAddress(input.trim(), { strict: false }) ? input.trim().toLowerCase() : null;
  const [sign, setSign] = useState({ status: 'idle', error: null, result: null });
  const check = useQuery({
    queryKey: [...launchKeys.all, 'project-check', token, account || null],
    enabled: Boolean(token),
    queryFn: ({ signal }) => launchApi.projectCheck(account ? { token, account } : { token }, signal),
    staleTime: 20_000,
    retry: 0,
  });
  const d = check.data;
  const reg = sign.result || d?.registration;
  const decision = d?.decision;

  const register = async () => {
    setSign({ status: 'signing', error: null, result: null });
    try {
      const wallet = connectedWallet(wallets, account);
      const issuedAt = new Date().toISOString();
      const message = registerMessage({ chainId: PLACE_CHAIN_ID, token, account, issuedAt });
      const provider = await wallet.getEthereumProvider();
      const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), wallet.address] });
      setSign({ status: 'saving', error: null, result: null });
      const r = await launchApi.registerProject({ token, account, issuedAt, signature });
      setSign({ status: 'done', error: null, result: r.registration });
      queryClient.invalidateQueries({ queryKey: launchKeys.all });
    } catch (e) {
      const rejected = e?.code === 4001 || /reject|denied|cancel/i.test(e?.message || '');
      setSign(rejected ? { status: 'idle', error: null, result: null } : { status: 'error', error: e?.message || 'Could not register the token', result: null });
    }
  };

  const liquidityLow = d?.liquidityUsd != null && d.liquidityUsd < MIN_PROJECT_LIQUIDITY_USD;
  const st = reg ? STATUS[reg.status] : null;
  return (
    <div className="pl-place-stack pl-projects-register">
      <Link to="/projects" className="pl-place-back">
        <ArrowLeft size={14} /> Projects
      </Link>
      <PageHeader title="Register token" description="Bring a token launched elsewhere to Place and run it as a project" />
      <Card>
        <ol className="pl-projects-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="mono">{i + 1}</span>
              <span>
                <span className="pl-launch-strong">{title}</span>
                <br />
                <span className="pl-launch-muted">{text}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="pl-place-stack">
        <span className="pl-launch-section-title">Your token</span>
        <label className="pl-launch-search">
          <Search size={15} />
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSign({ status: 'idle', error: null, result: null });
            }}
            placeholder="Token address, 0x..."
            aria-label="Token address"
            spellCheck={false}
            className="mono"
          />
        </label>
        {input.trim() && !token && <span className="pl-place-hint error">Not a token address</span>}
        {check.isLoading && (
          <span className="pl-place-hint">
            <Loader2 size={13} className="spin" /> Checking the token on {isTestnet ? 'Base Sepolia' : 'Base'}...
          </span>
        )}
        {check.error && <Alert tone="danger" icon={<AlertTriangle size={16} />}>{check.error.message}</Alert>}
        {d && !d.isToken && <Alert tone="danger" icon={<AlertTriangle size={16} />}>This address is not an ERC-20 token on this network.</Alert>}
        {d?.placeLaunch && (
          <Alert tone="info" icon={<Rocket size={16} />} action={<Button as={Link} size="sm" to={`/token/${token}`}>Open project</Button>}>
            {d.token.symbol} was launched on Place: it is a project already.
          </Alert>
        )}
        {d?.isToken && !d.placeLaunch && (
          <>
            <div className="pl-projects-token">
              <span className="pl-launch-strong">{d.token.name || d.token.symbol}</span>
              <span className="pl-launch-muted mono">{d.token.symbol}</span>
              {st && (
                <Badge tone={st.tone} pill>
                  <st.Icon size={12} /> {st.label}
                </Badge>
              )}
            </div>
            <ul className="pl-projects-checks">
              <Check ok={Boolean(decision && decision.method !== 'manual')} warn={!account || decision?.method === 'manual'}>
                {d.rights.owner ? (
                  <>
                    owner() is <AddressLink address={d.rights.owner} />
                  </>
                ) : (
                  'The token has no owner()'
                )}
                {d.rights.admin && (
                  <>
                    , admin() is <AddressLink address={d.rights.admin} />
                  </>
                )}
                .{' '}
                {!account ? 'Connect the wallet that controls it.' : decision?.method === 'manual' ? 'This wallet is neither, so the Place team checks it by hand.' : 'This wallet controls the token.'}
              </Check>
              <Check ok={d.liquidityUsd != null && !liquidityLow} warn={d.liquidityUsd == null}>
                {d.liquidityUsd == null
                  ? `Liquidity can't be measured on ${isTestnet ? 'the testnet' : 'this network'}, so the Place team checks it by hand.`
                  : `Liquidity ${usd(d.liquidityUsd)}${liquidityLow ? `, below the ${usd(MIN_PROJECT_LIQUIDITY_USD)} a project needs` : ''}.`}
              </Check>
            </ul>
            {reg && (
              <Alert tone={reg.status === 'verified' ? 'success' : reg.status === 'review' ? 'warn' : 'danger'} icon={<BadgeCheck size={16} />} action={reg.status === 'verified' ? <Button as={Link} size="sm" to={`/token/${token}`}>Open project</Button> : null}>
                {reg.status === 'verified'
                  ? `Registered to ${reg.creator.slice(0, 6)}...${reg.creator.slice(-4)}. The project page is live.`
                  : reg.status === 'review'
                    ? `Registered and waiting for a check by the Place team${reg.note ? `: ${reg.note}` : ''}.`
                    : 'The Place team did not accept this registration.'}
              </Alert>
            )}
            {!account ? (
              <ConnectButton size="lg">Connect wallet to register</ConnectButton>
            ) : (
              <Button variant="primary" size="lg" onClick={register} disabled={sign.status === 'signing' || sign.status === 'saving' || liquidityLow}>
                {sign.status === 'signing' || sign.status === 'saving' ? <Loader2 size={16} className="spin" /> : <PenLine size={16} />}
                {sign.status === 'signing' ? 'Sign in your wallet...' : sign.status === 'saving' ? 'Registering...' : reg ? 'Sign again' : 'Sign and register'}
              </Button>
            )}
            {sign.error && <Alert tone="danger" icon={<AlertTriangle size={16} />}>{sign.error}</Alert>}
            <Alert tone="info" icon={<Info size={16} />}>
              Registering gives the token a project page and marks the project as yours. Two things stay with Place: a swap route for a new token (needed to pair NFT collections with it and to pay rewards in it) is added
              by a Place admin onchain, and the Official badge on collections still comes from the token&apos;s owner() until the onchain project registry is live.
            </Alert>
          </>
        )}
      </Card>

      <div className="pl-projects-actions">
        <Button as={Link} to="/create">
          Create vault / campaign
        </Button>
        <Button as={Link} to={launchNewPath()} variant="primary">
          <Rocket size={15} /> Launch token
        </Button>
      </div>
    </div>
  );
}
