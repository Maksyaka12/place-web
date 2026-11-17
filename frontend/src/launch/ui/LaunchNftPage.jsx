// Launch NFT (/launch/nft): a collection of your own through the Place NFT factory (a ClubNFT clone): supply, mint
// price in ETH or a token, mint start, payout, a share of every mint that buys back and burns your token, royalties.
// Only collections launched here can get NFT holder rewards in the Rewards hub. Every call goes through usePlaceTx.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decodeEventLog } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Gift, ImagePlus, Rocket, Sparkles } from 'lucide-react';
import { Alert, Button, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton, AddressLink } from '../../themes/place/pages/place/parts';
import { useToken, usePlaceAccount, usePlaceTx, useCollections } from '../../place/hooks';
import { placeApi } from '../../place/api';
import { PLACE_CHAIN, PLACE_CHAIN_ID, placeClient, placeDeployment, explorerTx } from '../../place/chain';
import { PLACE_CONFIG_ABI, NFT_FACTORY_ABI } from '../../place/abi';
import { planCollection } from '../../place/create';
import { formatToken, formatUtc, shortAddress } from '../../place/format';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE = 600 * 1024;
const validAddr = (v) => (/^0x[0-9a-fA-F]{40}$/.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null);

function Field({ label, error, hint, children }) {
  return (
    <label className="pl-place-field">
      <span className="pl-launch-field-label">{label}</span>
      {children}
      {error ? <span className="pl-place-hint error">{error}</span> : hint ? <span className="pl-place-hint">{hint}</span> : null}
    </label>
  );
}

function Step({ n, title, desc, children }) {
  return (
    <section className="pl-launch-step">
      <div className="pl-launch-step-head">
        <span className="pl-launch-step-n mono">{String(n).padStart(2, '0')}</span>
        <div>
          <h2 className="pl-launch-step-title">{title}</h2>
          {desc && <p className="pl-launch-section-desc">{desc}</p>}
        </div>
      </div>
      <div className="pl-launch-step-body">{children}</div>
    </section>
  );
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(file);
  });
}

/** Pins name, description and the optional image; returns the metadata ipfs:// URI. */
async function pinDetails({ name, description, file }) {
  let image = null;
  if (file) image = (await placeApi.pinImage({ data: await readFileBase64(file), contentType: file.type })).uri;
  const { uri } = await placeApi.pinMetadata({ name: name.trim(), description: description?.trim() || null, image });
  return uri;
}

/** The deploy fee for this wallet (PlaceConfig). */
function useDeployFee(account) {
  const config = placeDeployment().config;
  return useQuery({
    queryKey: ['place-config', PLACE_CHAIN_ID, 'nft-fee', account],
    staleTime: 60_000,
    queryFn: () =>
      account
        ? placeClient().readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'nftDeployFeeFor', args: [account] })
        : placeClient().readContract({ address: config, abi: PLACE_CONFIG_ABI, functionName: 'nftDeployFee' }),
  });
}

function MyCollections({ account }) {
  const q = useCollections(account ? { creator: account } : {}, { enabled: Boolean(account) });
  if (!account) return null;
  const list = q.data?.collections || [];
  return (
    <Card className="pl-place-stack">
      <span className="pl-launch-section-title">Your collections</span>
      {list.length ? (
        <div className="pl-launch-hub-list">
          {list.map((c) => (
            <div key={c.address} className="pl-launch-hub-row">
              <Link className="pl-place-link" to={`/token/${c.address}`}>
                {c.name || shortAddress(c.address)} {c.symbol && <span className="pl-launch-muted">({c.symbol})</span>}
              </Link>
              <span className="pl-launch-hub-row-right">
                <Link className="pl-place-link pl-launch-small" to={`/create?type=nft&token=${c.address}`}>
                  Reward holders
                </Link>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="pl-launch-muted pl-launch-small">{q.isLoading ? 'Loading…' : 'None yet. Your first collection shows up here.'}</p>
      )}
    </Card>
  );
}

/** The collection image: a square preview with an Upload / Change button, like the token logo in Launch token. */
function ImagePicker({ file, error, onPick }) {
  const input = useRef(null);
  const [preview, setPreview] = useState(null);
  const pick = (x) => {
    setPreview(x ? URL.createObjectURL(x) : null);
    onPick(x);
  };
  return (
    <div className="pl-launch-logo-row">
      <button type="button" className="pl-launch-logo-drop" onClick={() => input.current?.click()} aria-label="Upload image">
        {preview && file ? <img src={preview} alt="" /> : <ImagePlus size={24} />}
      </button>
      <div className="pl-launch-logo-text">
        <Button size="sm" type="button" onClick={() => input.current?.click()}>
          <ImagePlus size={15} />
          {file ? 'Change image' : 'Upload image'}
        </Button>
        <span className="pl-place-hint">{file ? file.name : 'PNG, JPEG, WebP or GIF up to 600 KB'}</span>
        {error && <span className="pl-place-hint error">{error}</span>}
      </div>
      <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => pick(e.target.files?.[0] || null)} />
    </div>
  );
}

export default function LaunchNftPage() {
  const { address: account } = usePlaceAccount();
  const factory = placeDeployment().nftFactory.address;
  const [f, setF] = useState({
    name: '',
    symbol: '',
    maxSupply: '1000',
    maxPerWallet: '',
    paymentToken: 'eth',
    price: '0',
    mintStart: '',
    payout: '',
    burnPct: '',
    burnToken: '',
    swapPoolFee: '3000',
    royaltyPct: '5',
    royaltyReceiver: '',
    baseURI: '',
    description: '',
  });
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState(null);
  const [pinError, setPinError] = useState(null);
  const [created, setCreated] = useState(null);
  const tx = usePlaceTx();
  const fee = useDeployFee(account);
  const payToken = f.paymentToken === 'eth' ? null : validAddr(f.paymentToken);
  const payQ = useToken(payToken);
  const payMeta = f.paymentToken === 'eth' ? { symbol: 'ETH', decimals: 18 } : payQ.data;
  const burnQ = useToken(validAddr(f.burnToken));

  const form = { ...f, payout: f.payout || account || '' };
  const plan = planCollection(form, { chainId: PLACE_CHAIN_ID, now: Math.floor(Date.now() / 1000), deployFee: fee.data ?? null, paymentDecimals: payMeta?.decimals ?? null });
  const err = (k) => (touched ? plan.errors[k] : null);
  const working = phase !== null || tx.busy;

  const submit = async () => {
    setTouched(true);
    setPinError(null);
    if (Object.keys(plan.errors).length || !account) return;
    try {
      let contractURI = '';
      if (f.description.trim() || file) {
        setPhase('pin');
        contractURI = await pinDetails({ name: plan.params.name, description: f.description, file });
      }
      setPhase('tx');
      const receipt = await tx.send({ to: factory, abi: NFT_FACTORY_ABI, functionName: 'createCollection', args: [{ ...plan.params, contractURI }], value: plan.fee, label: 'Launch collection' });
      if (receipt) {
        let collection = null;
        for (const l of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: NFT_FACTORY_ABI, data: l.data, topics: l.topics });
            if (ev.eventName === 'CollectionCreated') collection = ev.args.collection.toLowerCase();
          } catch {
            // another contract's log
          }
        }
        setCreated({ collection, hash: receipt.transactionHash });
      }
    } catch (e) {
      setPinError(e.message);
    } finally {
      setPhase(null);
    }
  };

  const sym = payMeta?.symbol || 'tokens';
  return (
    <div className="pl-launch pl-launch-new pl-rewards-create">
      <Link to="/hub" className="pl-place-back">
        <ArrowLeft size={14} />
        Rewards
      </Link>
      <header className="pl-launch-new-header">
        <h1 className="page-title">Launch an NFT collection</h1>
        <p className="page-desc">Your own collection on {PLACE_CHAIN.name} with a mint, royalties and a buyback of your token, ready for holder rewards</p>
      </header>

      {created ? (
        <Card className="pl-place-stack">
          <Alert tone="success" icon={<CheckCircle2 size={16} />}>
            Collection launched{created.collection ? ` at ${shortAddress(created.collection)}` : ''}. You own it: set prices, the mint start and royalties from your wallet.
          </Alert>
          <div className="pl-place-actions" style={{ justifyContent: 'flex-start' }}>
            {created.collection && (
              <>
                <Button as={Link} to={`/create?type=nft&token=${created.collection}`} variant="primary">
                  <Gift size={15} /> Reward its holders
                </Button>
                <Button as={Link} to={`/token/${created.collection}`}>
                  Open collection
                </Button>
              </>
            )}
            <Button as="a" variant="ghost" href={explorerTx(created.hash)} target="_blank" rel="noopener noreferrer">
              Transaction <ExternalLink size={14} />
            </Button>
          </div>
        </Card>
      ) : (
        <div className="pl-launch-new-cols">
          <form
            className="pl-place-form pl-launch-new-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            noValidate
          >
            <fieldset disabled={working} className="pl-rewards-fieldset">
              <Step n={1} title="Collection">
                <div className="pl-launch-two even">
                  <Field label="Name" error={err('name')}>
                    <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Club" />
                  </Field>
                  <Field label="Symbol" error={err('symbol')}>
                    <input value={f.symbol} onChange={(e) => set({ symbol: e.target.value.toUpperCase() })} placeholder="CLUB" />
                  </Field>
                </div>
                <div className="pl-launch-two even">
                  <Field label="Supply" error={err('maxSupply')} hint="Fixed for good">
                    <input className="mono" inputMode="numeric" value={f.maxSupply} onChange={(e) => set({ maxSupply: e.target.value })} />
                  </Field>
                  <Field label="Max per wallet (optional)" error={err('maxPerWallet')} hint="Empty for no limit">
                    <input className="mono" inputMode="numeric" value={f.maxPerWallet} onChange={(e) => set({ maxPerWallet: e.target.value })} placeholder="No limit" />
                  </Field>
                </div>
                <Field label="Description (optional)">
                  <textarea value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="What holders get" />
                </Field>
                <div className="pl-place-field">
                  <span className="pl-launch-field-label">Image (optional)</span>
                  <ImagePicker file={file} error={fileError} onPick={(x) => {
                      if (x && (!IMAGE_TYPES.includes(x.type) || x.size > MAX_IMAGE)) {
                        setFileError('Use a PNG, JPEG, WebP or GIF up to 600 KB');
                        setFile(null);
                        return;
                      }
                      setFileError(null);
                      setFile(x);
                    }}
                  />
                </div>
                <Field label="Token metadata base URI (optional)" error={err('baseURI')} hint="ipfs://.../ with one JSON per token ID; you can set it later until you freeze it">
                  <input className="mono" value={f.baseURI} onChange={(e) => set({ baseURI: e.target.value })} placeholder="ipfs://" spellCheck={false} />
                </Field>
              </Step>

              <Step n={2} title="Mint">
                <div className="pl-launch-two even">
                  <Field label="Pay with" error={err('paymentToken')}>
                    <select value={f.paymentToken === 'eth' ? 'eth' : 'token'} onChange={(e) => set({ paymentToken: e.target.value === 'eth' ? 'eth' : '' })}>
                      <option value="eth">ETH</option>
                      <option value="token">An ERC-20 token</option>
                    </select>
                  </Field>
                  {f.paymentToken !== 'eth' && (
                    <Field label="Payment token address" error={err('paymentToken')} hint={payMeta ? `${payMeta.name || ''} (${payMeta.symbol})` : null}>
                      <input className="mono" value={f.paymentToken} onChange={(e) => set({ paymentToken: e.target.value })} placeholder="0x..." spellCheck={false} />
                    </Field>
                  )}
                </div>
                <div className="pl-launch-two even">
                  <Field label={`Price per NFT, ${sym}`} error={err('price')} hint="0 for a free mint; you can change it until the first mint">
                    <input className="mono" inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} />
                  </Field>
                  <Field label="Mint opens, UTC (optional)" error={err('mintStart')} hint="Empty to open right away">
                    <input type="datetime-local" className="mono" value={f.mintStart} onChange={(e) => set({ mintStart: e.target.value })} />
                  </Field>
                </div>
                <Field label="Revenue goes to" error={err('payout')} hint="Fixed at creation; defaults to your wallet">
                  <input className="mono" value={f.payout} onChange={(e) => set({ payout: e.target.value })} placeholder={account || '0x...'} spellCheck={false} />
                </Field>
              </Step>

              <Step n={3} title="Your token and royalties" desc="Tie the collection to your token: part of every mint buys it back and burns it">
                <div className="pl-launch-two even">
                  <Field label="Buy back and burn, % of each mint (optional)" error={err('burnPct')}>
                    <input className="mono" inputMode="decimal" value={f.burnPct} onChange={(e) => set({ burnPct: e.target.value })} placeholder="0" />
                  </Field>
                  <Field label="Token to burn" error={err('burnToken')} hint={burnQ.data ? `${burnQ.data.name || ''} (${burnQ.data.symbol || '?'})${burnQ.data.placeLaunch ? ' · Launched on Place' : ''}` : 'Your Place token'}>
                    <input className="mono" value={f.burnToken} onChange={(e) => set({ burnToken: e.target.value })} placeholder="0x..." disabled={!Number(f.burnPct)} spellCheck={false} />
                  </Field>
                </div>
                {Number(f.burnPct) > 0 && f.paymentToken !== f.burnToken && (
                  <Field label="Uniswap pool fee tier">
                    <select value={f.swapPoolFee} onChange={(e) => set({ swapPoolFee: e.target.value })}>
                      <option value="500">0.05%</option>
                      <option value="3000">0.3%</option>
                      <option value="10000">1%</option>
                    </select>
                  </Field>
                )}
                <div className="pl-launch-two even">
                  <Field label="Royalty, %" error={err('royaltyPct')} hint="Up to 10%, changeable later">
                    <input className="mono" inputMode="decimal" value={f.royaltyPct} onChange={(e) => set({ royaltyPct: e.target.value })} />
                  </Field>
                  <Field label="Royalty receiver" error={err('royaltyReceiver')}>
                    <input className="mono" value={f.royaltyReceiver} onChange={(e) => set({ royaltyReceiver: e.target.value })} placeholder={form.payout || '0x...'} spellCheck={false} />
                  </Field>
                </div>
              </Step>
            </fieldset>
          </form>

          <aside className="pl-launch-new-side">
            <Card className="pl-launch-summary">
              <span className="pl-launch-section-title">Summary</span>
              <dl className="pl-launch-summary-kv">
                <div>
                  <dt>Collection</dt>
                  <dd>{plan.params ? `${plan.params.name} (${plan.params.symbol})` : f.name || '—'}</dd>
                </div>
                <div>
                  <dt>Mint</dt>
                  <dd className="mono">{plan.params ? `${plan.params.maxSupply} × ${formatToken(plan.params.price, payMeta)}` : '—'}</dd>
                </div>
                <div>
                  <dt>Opens</dt>
                  <dd className="mono">{plan.params ? formatUtc(new Date(Number(plan.params.mintStart) * 1000)) : '—'}</dd>
                </div>
                <div>
                  <dt>Buyback</dt>
                  <dd className="mono">{Number(f.burnPct) > 0 ? `${f.burnPct}% of each mint` : 'None'}</dd>
                </div>
                <div>
                  <dt>Deploy fee</dt>
                  <dd className="mono">{fee.data != null ? formatToken(fee.data, { symbol: 'ETH', decimals: 18 }) : '...'}</dd>
                </div>
                {plan.params?.payout && (
                  <div>
                    <dt>Revenue to</dt>
                    <dd>
                      <AddressLink address={plan.params.payout} />
                    </dd>
                  </div>
                )}
              </dl>
              <div className="pl-launch-submit">
                {account ? (
                  <TxButton tx={{ ...tx, busy: working, status: phase === 'pin' ? 'pending' : tx.status }} size="lg" fullWidth onClick={submit} busyLabel={phase === 'pin' ? 'Uploading to IPFS...' : 'Launching on Base...'}>
                    <Sparkles size={16} /> Launch collection
                  </TxButton>
                ) : (
                  <ConnectButton size="lg">Connect wallet to launch</ConnectButton>
                )}
                {touched && Object.keys(plan.errors).length > 0 && !plan.errors.form && <span className="pl-place-hint error">Fix the fields marked on the left.</span>}
                {pinError && (
                  <Alert tone="danger" icon={<AlertTriangle size={16} />}>
                    {pinError}
                  </Alert>
                )}
                <TxResult tx={tx} success="Collection launched" />
              </div>
            </Card>
            <Alert tone="info" icon={<Rocket size={16} />}>
              Collections launched on Place can get daily NFT holder rewards in the Rewards hub, paid in ETH or any token, from you or anyone.
            </Alert>
            <MyCollections account={account} />
          </aside>
        </div>
      )}
    </div>
  );
}
