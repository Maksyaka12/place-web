// Launch NFT (/launch/nft): an NFT launch built like a token launch. 01 Basics (logo, name, symbol, description,
// Unique or Edition with its files, supply, wallet limit, mint window), 02 Pair token (a Place token or any token
// with a swap route; the burn buys it and the mint can be paid in it), 03 Mint (price in ETH, optionally also in the
// pair token at the ETH equivalent), 04 Economy (Place 20%, then creator / NFT holders / buyback & burn, the holders'
// reward token, royalties). One transaction to PlaceNftFactory.createCollection, with the Builder Code like every
// Place transaction. Before the 0.3.1 deploy the form works as a preview and the launch button says when it opens.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { decodeEventLog, formatEther, parseEther } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Flame, Gift, ImagePlus, Info, Layers, Loader2, Lock, Sparkles, Upload, Users } from 'lucide-react';
import { Alert, Badge, Button, Card } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { placeApi } from '../../place/api';
import { PLACE_CHAIN, PLACE_CHAIN_ID, placeClient, explorerTx, isTestnet } from '../../place/chain';
import { formatAmount, shortAddress, formatUtc } from '../../place/format';
import { launchApi } from '../client.js';
import { useNftPairs, usePairs, useCollections, launchKeys } from '../hooks.js';
import { nftDeployment } from '../deployments.js';
import { NFT_FACTORY_ABI, NFT_SWAPPER_ABI, PRICE_GUARD_ABI } from '../nftAbi.js';
import { uploadImage, imageProblem, prepareNftImage, IMAGE_TYPES } from '../image.js';
import {
  ETH,
  NFT_BUCKETS,
  DEFAULT_NFT_ECONOMY,
  NFT_PLATFORM_PCT,
  MAX_ROYALTY_PCT,
  MAX_UPLOAD_FILES,
  UPLOAD_BATCH_BYTES,
  POOL_DAYS,
  nftEconomyTotal,
  paymentPct,
  mintSplit,
  planNftCollection,
  byFileName,
  uniqueMetadata,
  collectionPath,
} from '../nft.js';
import { compact } from '../format.js';
import { pairIcon } from '../pairs.js';
import { TokenLogo } from './parts.jsx';
import { AllocationRing, BucketSlider } from './EconomyFields.jsx';
import { NftTokenButton, NftTokenPicker } from './NftTokenPicker.jsx';

const DEFAULT_FEE = 500_000_000_000_000n; // 0.0005 ETH, the creation fee of the 0.3.1 deploy script
const RING = [{ id: 'platform', tone: 'platform' }, ...NFT_BUCKETS];

function Field({ label, hint, error, counter, children }) {
  return (
    <label className="pl-place-field">
      <span className="pl-launch-field-label">
        {label}
        {counter}
      </span>
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

function Seg({ label, options, value, onChange }) {
  return (
    <div className="seg soft" role="tablist" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Creation fee of the factory (the expected one before the deploy). */
function useCreationFee(n) {
  return useQuery({
    queryKey: [...launchKeys.all, 'nft-fee', n?.factory || null],
    enabled: Boolean(n),
    staleTime: 60_000,
    queryFn: () => placeClient().readContract({ address: n.factory, abi: NFT_FACTORY_ABI, functionName: 'creationFee' }),
  });
}

/**
 * Pair-token amount worth `wei` of ETH right now: from the guard's reference and spot prices once the NFT launchpad
 * is live (what mintWithToken would charge), else from Place's market prices for a Place token. null when unknown.
 */
function useTokenEquivalent(n, pair, wei) {
  const ethUsd = usePairs().data?.pairs?.find((p) => p.address === 'eth')?.usd ?? null;
  return useQuery({
    queryKey: [...launchKeys.all, 'nft-equivalent', n?.swapper || null, pair?.address || null, String(wei), ethUsd],
    enabled: Boolean(pair?.address && wei > 0n),
    staleTime: 30_000,
    retry: 0,
    queryFn: async () => {
      if (n) {
        const client = placeClient();
        try {
          const route = await client.readContract({ address: n.swapper, abi: NFT_SWAPPER_ABI, functionName: 'ethRoute', args: [pair.address, pair.launchPool || { currency0: ETH, currency1: ETH, fee: 0, tickSpacing: 0, hooks: ETH }] });
          const [ref, spot] = await client.readContract({ address: n.priceGuard, abi: PRICE_GUARD_ABI, functionName: 'quote', args: [route, ETH, wei] });
          return { amount: Number(formatEther(ref > spot ? ref : spot)), source: 'guard' };
        } catch {
          return { amount: null, source: 'guard', notReady: true };
        }
      }
      if (!pair.placeLaunch || !ethUsd) return { amount: null, source: 'none' };
      const t = await launchApi.token(pair.address);
      const usd = t?.token?.priceUsd ?? t?.priceUsd;
      return { amount: usd ? (Number(formatEther(wei)) * ethUsd) / usd : null, source: 'market' };
    },
  });
}

function LogoPicker({ logo, onPick }) {
  const input = useRef(null);
  return (
    <div className="pl-launch-logo-row">
      <button type="button" className="pl-launch-logo-drop" onClick={() => input.current?.click()} aria-label="Upload logo">
        {logo.preview ? <img src={logo.preview} alt="" /> : <ImagePlus size={24} />}
        {logo.busy && (
          <span className="pl-launch-logo-busy">
            <Loader2 size={18} className="spin" />
          </span>
        )}
      </button>
      <div className="pl-launch-logo-text">
        <Button size="sm" type="button" onClick={() => input.current?.click()}>
          <ImagePlus size={15} />
          {logo.preview ? 'Change logo' : 'Upload logo'}
        </Button>
        <span className="pl-place-hint">The collection logo in Place and in wallets. Square works best.</span>
        {logo.busy && <span className="pl-place-hint">Uploading to IPFS...</span>}
        {logo.error && <span className="pl-place-hint error">{logo.error}</span>}
      </div>
      <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => onPick(e.target.files?.[0])} />
    </div>
  );
}

/** Unique collections: the picked files with thumbnails, and the upload to IPFS (images, then one metadata folder). */
function UniqueFiles({ files, onFiles, uploaded, upload, onUpload, supply, error }) {
  const input = useRef(null);
  const thumbs = useMemo(() => files.slice(0, 12).map((f) => ({ name: f.name, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => thumbs.forEach((t) => URL.revokeObjectURL(t.url)), [thumbs]);
  const count = files.length;
  const want = Number(supply) || 0;
  return (
    <div className="pl-collection-files">
      <div className="pl-collection-files-head">
        <Button size="sm" type="button" onClick={() => input.current?.click()} disabled={upload.busy}>
          <ImagePlus size={15} /> {count ? 'Pick other files' : 'Pick images'}
        </Button>
        <span className="pl-place-hint">
          {count ? `${count} of ${want || '?'} files. NFT #1 is the first file by name, then #2 and so on.` : `One image per NFT (${want || 'supply'} files), PNG, JPG, WEBP or GIF, up to ${MAX_UPLOAD_FILES}.`}
        </span>
      </div>
      <input ref={input} type="file" multiple accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => onFiles([...(e.target.files || [])].sort(byFileName))} />
      {thumbs.length > 0 && (
        <div className="pl-collection-thumbs">
          {thumbs.map((t, i) => (
            <figure key={t.name} className="pl-collection-thumb">
              <img src={t.url} alt="" />
              <figcaption className="mono">#{i + 1}</figcaption>
            </figure>
          ))}
          {count > thumbs.length && <span className="pl-collection-thumb more mono">+{count - thumbs.length}</span>}
        </div>
      )}
      {error && <span className="pl-place-hint error">{error}</span>}
      {count > 0 && !error && (
        <div className="pl-collection-upload">
          {uploaded ? (
            <span className="pl-place-hint">
              <CheckCircle2 size={13} className="pl-collection-ok" /> Uploaded. Metadata folder <span className="mono">{uploaded}</span>
            </span>
          ) : (
            <Button size="sm" type="button" variant="secondary" onClick={onUpload} disabled={upload.busy || count !== want}>
              {upload.busy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
              {upload.busy ? upload.label : 'Upload to IPFS'}
            </Button>
          )}
          {upload.error && <span className="pl-place-hint error">{upload.error}</span>}
        </div>
      )}
    </div>
  );
}

function MyCollections({ account }) {
  const q = useCollections({ creator: account }, { enabled: Boolean(account) });
  if (!account || !q.data?.deployed) return null;
  const list = q.data.collections || [];
  return (
    <Card className="pl-place-stack">
      <span className="pl-launch-section-title">Your collections</span>
      {list.length ? (
        <div className="pl-launch-hub-list">
          {list.map((c) => (
            <div key={c.address} className="pl-launch-hub-row">
              <Link className="pl-place-link" to={collectionPath(c.address)}>
                {c.name || shortAddress(c.address)} {c.symbol && <span className="pl-launch-muted">({c.symbol})</span>}
              </Link>
              <span className="pl-launch-hub-row-right mono pl-launch-small">
                {c.totalMinted}
                {c.maxSupply ? ` / ${c.maxSupply}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="pl-launch-muted pl-launch-small">{q.isLoading ? 'Loading...' : 'None yet. Your first collection shows up here.'}</p>
      )}
    </Card>
  );
}

const ethText = (wei) => `${formatAmount(wei, 18, { maxDecimals: 6 })} ETH`;
const pct = (v) => `${Number(v.toFixed(2))}%`;

export default function LaunchNftPage() {
  const navigate = useNavigate();
  const { address: account } = usePlaceAccount();
  const n = nftDeployment(PLACE_CHAIN_ID);
  const pairsQ = useNftPairs();
  const pairs = useMemo(() => pairsQ.data?.pairs || [], [pairsQ.data]);
  const routeTokens = useMemo(() => (pairsQ.data?.rewardTokens || []).filter((t) => t.address !== 'eth'), [pairsQ.data]);
  const feeQ = useCreationFee(n);
  const fee = feeQ.data ?? DEFAULT_FEE;
  const tx = usePlaceTx();

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [logo, setLogo] = useState({ preview: null, uri: null, busy: false, error: null });
  const [kind, setKind] = useState('unique');
  const [uniqueMode, setUniqueMode] = useState('upload');
  const [files, setFiles] = useState([]);
  const [uploaded, setUploaded] = useState(null);
  const [upload, setUpload] = useState({ busy: false, label: '', error: null });
  const [folder, setFolder] = useState({ baseURI: '', suffix: '.json' });
  const [editionMode, setEditionMode] = useState('upload');
  const [editionFile, setEditionFile] = useState(null);
  const [editionLink, setEditionLink] = useState('');
  const [supply, setSupply] = useState('100');
  const [maxPerWallet, setMaxPerWallet] = useState('');
  const [mintStart, setMintStart] = useState('');
  const [mintEnd, setMintEnd] = useState('');
  const [pair, setPair] = useState(null);
  const [picking, setPicking] = useState(null);
  const [price, setPrice] = useState('0.001');
  const [tokenPayments, setTokenPayments] = useState(true);
  const [economy, setEconomy] = useState({ ...DEFAULT_NFT_ECONOMY });
  const [reward, setReward] = useState(null); // null = the pair token
  const [royalty, setRoyalty] = useState(5);
  const [touched, setTouched] = useState(false);
  const [stage, setStage] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const [created, setCreated] = useState(null);
  const editionInput = useRef(null);

  // Metadata names and descriptions are written into the files: a change means uploading again.
  useEffect(() => setUploaded(null), [files, name, description]);

  const rewardToken = reward ?? pair?.address ?? null;
  const rewardOptions = useMemo(() => {
    const top = [];
    if (pair) top.push({ ...pair, source: 'pair', note: 'The pair token: no swap when the mint is paid in it' });
    top.push({ address: 'eth', symbol: 'ETH', name: 'Ether', category: 'majors', logo: pairIcon({ symbol: 'ETH' }), note: 'Holders are paid in ETH' });
    return { top, tokens: routeTokens.filter((t) => t.address !== pair?.address) };
  }, [pair, routeTokens]);
  const rewardPicked = [...rewardOptions.top, ...rewardOptions.tokens].find((t) => t.address === rewardToken) || null;

  const editionPreview = useMemo(() => (editionFile ? URL.createObjectURL(editionFile) : null), [editionFile]);
  const firstThumb = useMemo(() => (files[0] ? URL.createObjectURL(files[0]) : null), [files]);
  const baseURI = kind === 'unique' ? (uniqueMode === 'upload' ? uploaded : folder.baseURI.trim()) : editionMode === 'link' ? editionLink.trim() : editionFile ? 'pending' : '';
  const plan = planNftCollection(
    {
      name,
      symbol,
      kind,
      supply,
      maxPerWallet,
      mintStart,
      mintEnd,
      price,
      tokenPayments,
      royalty,
      economy,
      baseURI: kind === 'unique' ? baseURI : baseURI ? 'ipfs://pending/metadata.json' : '',
      uriSuffix: uniqueMode === 'upload' ? '.json' : folder.suffix,
      files: kind === 'unique' && uniqueMode === 'upload' ? files : null,
    },
    { pair, rewardToken }
  );
  const err = (k) => (touched ? plan.errors[k] : null);
  const priceWei = useMemo(() => {
    try {
      return price.trim() ? parseEther(price.trim()) : 0n;
    } catch {
      return 0n;
    }
  }, [price]);
  const equivalent = useTokenEquivalent(n, pair, priceWei);
  const split = mintSplit(priceWei, economy);
  const shares = paymentPct(economy);
  const total = nftEconomyTotal(economy);
  const editionLinkErr = editionMode === 'link' && editionLink && !/^(ipfs|https):\/\/\S+$/.test(editionLink.trim()) ? 'An ipfs:// or https:// link' : null;

  const pickLogo = async (file) => {
    if (!file) return;
    const problem = imageProblem(file);
    if (problem) return setLogo((l) => ({ ...l, error: problem }));
    const preview = URL.createObjectURL(file);
    setLogo({ preview, uri: null, busy: true, error: null });
    try {
      setLogo({ preview, uri: await uploadImage(file), busy: false, error: null });
    } catch (e) {
      setLogo({ preview: null, uri: null, busy: false, error: `Upload failed: ${e.message}` });
    }
  };

  /** Images in folders of up to ~2.8 MB, then every NFT's metadata JSON in one folder: its link is the base URI. */
  const uploadUnique = async () => {
    setUpload({ busy: true, label: 'Preparing images...', error: null });
    try {
      const images = [];
      let batch = [];
      let size = 0;
      const flush = async () => {
        if (!batch.length) return;
        setUpload({ busy: true, label: `Uploading images ${images.length + batch.length} / ${files.length}...`, error: null });
        const { uri } = await placeApi.pinFolder(batch.map(({ name: fileName, contentType, data }) => ({ name: fileName, contentType, data })));
        images.push(...batch.map((b) => `${uri}${b.name}`));
        batch = [];
        size = 0;
      };
      for (let i = 0; i < files.length; i++) {
        const img = await prepareNftImage(files[i]);
        if (size + img.size > UPLOAD_BATCH_BYTES) await flush();
        batch.push({ ...img, name: `${i + 1}.${img.ext}` });
        size += img.size;
      }
      await flush();
      setUpload({ busy: true, label: 'Uploading metadata...', error: null });
      const meta = images.map((image, i) => ({ name: `${i + 1}.json`, contentType: 'application/json', content: uniqueMetadata({ name: name.trim() || 'NFT', description: description.trim(), image, id: i + 1 }) }));
      const { uri } = await placeApi.pinFolder(meta);
      setUploaded(uri);
      setUpload({ busy: false, label: '', error: null });
    } catch (e) {
      setUpload({ busy: false, label: '', error: e.message });
    }
  };

  /** Edition: the one image (uploaded or linked) and its metadata JSON; returns the metadata link. */
  const editionMetadata = async () => {
    let image = editionLink.trim();
    if (editionMode === 'link' && /\.json$/i.test(image)) return image;
    if (editionMode === 'upload') {
      const img = await prepareNftImage(editionFile, 2048);
      const { uri } = await placeApi.pinFolder([{ name: `image.${img.ext}`, contentType: img.contentType, data: img.data }]);
      image = `${uri}image.${img.ext}`;
    }
    const { uri } = await placeApi.pinFolder([{ name: 'metadata.json', contentType: 'application/json', content: { name: name.trim(), description: description.trim() || null, image } }]);
    return `${uri}metadata.json`;
  };

  const launch = async () => {
    setTouched(true);
    setLaunchError(null);
    if (!plan.params || !account || !n || editionLinkErr) return;
    try {
      setStage('Uploading the collection details...');
      const { uri: contractURI } = await placeApi.pinMetadata({ name: plan.params.name, description: description.trim() || null, image: logo.uri });
      const params = { ...plan.params, contractURI };
      if (kind === 'edition') {
        setStage('Uploading the edition...');
        params.baseURI = await editionMetadata();
      }
      setStage(null);
      const receipt = await tx.send({ to: n.factory, abi: NFT_FACTORY_ABI, functionName: 'createCollection', args: [params], value: fee, label: 'Launch collection' });
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
        if (collection) setTimeout(() => navigate(collectionPath(collection)), 1500);
      }
    } catch (e) {
      setLaunchError(e.message);
    } finally {
      setStage(null);
    }
  };

  const pairSym = pair?.symbol || 'the pair token';
  const rewardSym = rewardPicked?.symbol || pairSym;
  const previewImage = kind === 'unique' ? firstThumb || logo.preview : editionPreview || logo.preview;

  return (
    <div className="pl-launch pl-launch-new pl-rewards-create pl-collection-launch">
      <Link to="/hub" className="pl-place-back">
        <ArrowLeft size={14} />
        Rewards
      </Link>
      <header className="pl-launch-new-header">
        <h1 className="page-title">Launch an NFT collection</h1>
        <p className="page-desc">An NFT collection paired with a token: every mint pays its creator, rewards its holders for 30 days and burns the token</p>
      </header>
      {!n && (
        <Alert tone="info" icon={<Info size={16} />}>
          The NFT launchpad is coming to {PLACE_CHAIN.name} soon. You can prepare your collection now; launching opens once its contracts are live.
        </Alert>
      )}

      {created ? (
        <Card className="pl-place-stack">
          <Alert tone="success" icon={<CheckCircle2 size={16} />}>
            Collection launched{created.collection ? ` at ${shortAddress(created.collection)}` : ''}. Opening its page...
          </Alert>
          <div className="pl-place-actions" style={{ justifyContent: 'flex-start' }}>
            {created.collection && (
              <Button as={Link} to={collectionPath(created.collection)} variant="primary">
                <Layers size={15} /> Open collection
              </Button>
            )}
            <Button as="a" variant="ghost" href={explorerTx(created.hash)} target="_blank" rel="noopener noreferrer">
              Transaction <ExternalLink size={14} />
            </Button>
          </div>
        </Card>
      ) : (
        <div className="pl-launch-new-cols">
          <form className="pl-place-form pl-launch-new-form" onSubmit={(e) => e.preventDefault()} noValidate>
            <Step n={1} title="Basics">
              <LogoPicker logo={logo} onPick={pickLogo} />
              <div className="pl-launch-two">
                <Field label="Name" error={err('name')} counter={<span className="pl-launch-counter">{name.length}/64</span>}>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Club" maxLength={64} />
                </Field>
                <Field label="Symbol" error={err('symbol')} hint="Can't be changed after launch">
                  <input value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10))} placeholder="CLUB" />
                </Field>
              </div>
              <Field label="Description" hint="Shown on the collection page and in every NFT's metadata">
                <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 2000))} placeholder="What holders get" />
              </Field>
              <div className="pl-launch-kinds" role="radiogroup" aria-label="Collection type">
                {[
                  { id: 'unique', title: 'Unique', badge: 'One image per NFT', desc: 'Every NFT has its own image. Upload one file per NFT; the number of files is the supply.' },
                  { id: 'edition', title: 'Edition', badge: 'One image for all', desc: 'Every NFT shares one image. Set a supply, or leave it open.' },
                ].map((k) => (
                  <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className="card pl-launch-kind" onClick={() => setKind(k.id)}>
                    <span className="pl-launch-kind-title">
                      {k.title}
                      <Badge tone={kind === k.id ? 'accent' : 'neutral'}>{k.badge}</Badge>
                    </span>
                    <span className="pl-launch-kind-desc">{k.desc}</span>
                  </button>
                ))}
              </div>
              <div className="pl-launch-two even">
                <Field label="Supply" error={err('supply')} hint={kind === 'unique' ? 'Equal to the number of files' : 'Empty for an open edition'}>
                  <input className="mono" inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value.replace(/\D/g, ''))} placeholder={kind === 'unique' ? '100' : 'Open'} />
                </Field>
                <Field label="Max per wallet" error={err('maxPerWallet')} hint="Empty for no limit">
                  <input className="mono" inputMode="numeric" value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value.replace(/\D/g, ''))} placeholder="No limit" />
                </Field>
              </div>
              {kind === 'unique' ? (
                <div className="pl-place-field">
                  <span className="pl-launch-field-label">NFT files</span>
                  <Seg
                    label="NFT files"
                    options={[
                      ['upload', 'Upload images'],
                      ['folder', 'My metadata folder'],
                    ]}
                    value={uniqueMode}
                    onChange={setUniqueMode}
                  />
                  {uniqueMode === 'upload' ? (
                    <UniqueFiles files={files} onFiles={setFiles} uploaded={uploaded} upload={upload} onUpload={uploadUnique} supply={supply} error={err('files') || (touched && !uploaded && files.length ? 'Upload the files to IPFS first' : null)} />
                  ) : (
                    <div className="pl-launch-two">
                      <Field label="Metadata folder" error={err('media')} hint="One JSON file per NFT: 1.json, 2.json and so on">
                        <input className="mono" value={folder.baseURI} onChange={(e) => setFolder({ ...folder, baseURI: e.target.value })} placeholder="ipfs://bafy.../" spellCheck={false} />
                      </Field>
                      <Field label="File ending">
                        <input className="mono" value={folder.suffix} onChange={(e) => setFolder({ ...folder, suffix: e.target.value.slice(0, 10) })} placeholder=".json" spellCheck={false} />
                      </Field>
                    </div>
                  )}
                  {uniqueMode === 'upload' && touched && err('media') && !files.length && <span className="pl-place-hint error">{err('media')}</span>}
                </div>
              ) : (
                <div className="pl-place-field">
                  <span className="pl-launch-field-label">Edition image</span>
                  <Seg
                    label="Edition image"
                    options={[
                      ['upload', 'Upload image'],
                      ['link', 'Link'],
                    ]}
                    value={editionMode}
                    onChange={setEditionMode}
                  />
                  {editionMode === 'upload' ? (
                    <div className="pl-launch-logo-row">
                      <button type="button" className="pl-launch-logo-drop pl-collection-edition-drop" onClick={() => editionInput.current?.click()} aria-label="Upload edition image">
                        {editionPreview ? <img src={editionPreview} alt="" /> : <ImagePlus size={24} />}
                      </button>
                      <div className="pl-launch-logo-text">
                        <Button size="sm" type="button" onClick={() => editionInput.current?.click()}>
                          <ImagePlus size={15} /> {editionFile ? 'Change image' : 'Pick image'}
                        </Button>
                        <span className="pl-place-hint">{editionFile ? editionFile.name : 'Uploaded to IPFS when you launch'}</span>
                        {touched && err('media') && <span className="pl-place-hint error">{err('media')}</span>}
                      </div>
                      <input
                        ref={editionInput}
                        type="file"
                        accept={IMAGE_TYPES.join(',')}
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0] || null;
                          setEditionFile(f && !imageProblem(f) ? f : null);
                        }}
                      />
                    </div>
                  ) : (
                    <Field label="Image or metadata link" error={editionLinkErr || err('media')} hint="An image link becomes the edition's metadata; a link ending in .json is used as it is">
                      <input className="mono" value={editionLink} onChange={(e) => setEditionLink(e.target.value)} placeholder="ipfs://... or https://..." spellCheck={false} />
                    </Field>
                  )}
                </div>
              )}
              <div className="pl-launch-two even">
                <Field label="Mint opens, UTC" error={err('mintStart')} hint="Empty to open right away">
                  <input type="datetime-local" className="mono" value={mintStart} onChange={(e) => setMintStart(e.target.value)} />
                </Field>
                <Field label="Mint closes, UTC" error={err('mintEnd')} hint="Empty for no end">
                  <input type="datetime-local" className="mono" value={mintEnd} onChange={(e) => setMintEnd(e.target.value)} />
                </Field>
              </div>
            </Step>

            <Step n={2} title="Pair token" desc="The token this collection works for: the burn buys it, and the mint can be paid in it">
              <Field label="Pair token" error={err('pair')} hint="A token launched on Place, or any token Place has a swap route to. Paste an address to check your own token.">
                <NftTokenButton token={pair} placeholder="Choose the pair token" onClick={() => setPicking('pair')} />
              </Field>
              {pairsQ.error && <span className="pl-place-hint error">Could not load the tokens: {pairsQ.error.message}</span>}
              {pair?.placeLaunch && <span className="pl-place-hint">Swaps go through the {pair.symbol} launch pool on Uniswap v4.</span>}
            </Step>

            <Step n={3} title="Mint">
              <Field label="Price per NFT" error={err('price')} hint="Fixed in ETH. 0 for a free mint (then there is nothing to split)">
                <div className="pl-launch-prefixed suffix">
                  <input className="mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.001" />
                  <span>ETH</span>
                </div>
              </Field>
              <div className={`pl-launch-option ${tokenPayments ? 'on' : ''}`.trim()}>
                <label className="pl-launch-option-head">
                  <input type="checkbox" className="pl-launch-switch" checked={tokenPayments} onChange={(e) => setTokenPayments(e.target.checked)} disabled={priceWei === 0n} />
                  <span className="pl-launch-option-text">
                    <span className="pl-launch-strong">Also accept {pairSym}</span>
                    <span className="pl-launch-muted">Buyers can pay the ETH price in {pairSym} at the market rate of the moment. A protected price keeps it fair: a pumped pool can&apos;t make the mint cheaper.</span>
                  </span>
                </label>
                {tokenPayments && pair && priceWei > 0n && (
                  <div className="pl-launch-option-body">
                    <span className="pl-place-hint mono">
                      {equivalent.isLoading
                        ? 'Checking the price...'
                        : equivalent.data?.amount != null
                          ? `Now ≈ ${compact(equivalent.data.amount)} ${pair.symbol} per NFT`
                          : equivalent.data?.notReady
                            ? `The ${pair.symbol} price is warming up; paying in ${pair.symbol} opens once it is ready`
                            : `The ${pair.symbol} price shows once the NFT launchpad is live`}
                    </span>
                  </div>
                )}
              </div>
            </Step>

            <Step n={4} title="Economy" desc={`Place takes ${NFT_PLATFORM_PCT}% of every mint and royalty. You split the rest`}>
              <div className="pl-econ">
                <div className="pl-econ-alloc-head">
                  <div>
                    <h3 className="pl-launch-section-title">Mint allocation</h3>
                    <p className="pl-launch-section-desc">Split what is left after Place. Fixed at launch.</p>
                  </div>
                  <Badge tone={total === 100 ? 'success' : 'warn'} pill>
                    {total === 100 ? 'Fully allocated' : `${100 - total}% left`}
                  </Badge>
                </div>
                <div className="pl-econ-alloc">
                  <AllocationRing allocation={shares} buckets={RING} total={total} onReset={() => setEconomy({ ...DEFAULT_NFT_ECONOMY })} />
                  <div className="pl-econ-buckets">
                    {NFT_BUCKETS.map((b) => (
                      <BucketSlider key={b.id} bucket={b} value={economy[b.id]} others={total - economy[b.id]} onChange={(v) => setEconomy({ ...economy, [b.id]: v })} />
                    ))}
                  </div>
                </div>
                {err('economy') && <span className="pl-place-hint error">{err('economy')}</span>}
                {priceWei > 0n && (
                  <div className="pl-econ-taxcard">
                    <span className="pl-launch-strong">Each mint at {ethText(priceWei)}</span>
                    <dl>
                      <div>
                        <dt>
                          <span className="pl-econ-dot platform" /> Place
                        </dt>
                        <dd className="mono">{ethText(split.platform)}</dd>
                      </div>
                      {NFT_BUCKETS.map((b) => (
                        <div key={b.id}>
                          <dt>
                            <span className={`pl-econ-dot ${b.tone}`} /> {b.label}
                          </dt>
                          <dd className="mono">
                            {ethText(split[b.id])} · {pct(shares[b.id])}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
                <div className="pl-place-field">
                  <span className="pl-launch-field-label">
                    <Gift size={13} className="pl-econ-icon holders" /> NFT holders are paid in
                  </span>
                  <NftTokenButton token={rewardPicked} placeholder="Choose the pair token first" sub={rewardPicked?.note} onClick={() => setPicking('reward')} disabled={!pair} />
                  <span className="pl-place-hint">The holders&apos; part is swapped into this token in the mint transaction. By default it is the pair token.</span>
                </div>
                <Field label={`Royalty on sales: ${royalty}%`} error={err('royalty')} hint={`0–${MAX_ROYALTY_PCT}%. Royalties are split like the mint: Place ${NFT_PLATFORM_PCT}%, then your allocation`}>
                  <input type="range" min={0} max={MAX_ROYALTY_PCT} step={0.5} value={royalty} onChange={(e) => setRoyalty(Number(e.target.value))} className="pl-econ-range" style={{ '--fill': `${(royalty / MAX_ROYALTY_PCT) * 100}%` }} aria-label="Royalty" />
                </Field>
                <ul className="pl-launch-econ-notes">
                  <li>
                    <Users size={14} className="pl-econ-icon holders" />
                    <span>
                      Holders pool: every mint and royalty adds its holders&apos; part to a pool that pays out over {POOL_DAYS} days. Each day at 00:00 UTC the day&apos;s portion is shared equally by every NFT that exists then. Holders claim any time; when an NFT is sold, what it earned stays with the seller. A new NFT starts earning from the next 00:00 UTC.
                    </span>
                  </li>
                  {economy.burn > 0 && (
                    <li>
                      <Flame size={14} className="pl-econ-icon burn" />
                      <span>Burn: mints paid in {pairSym} burn that part at once; the ETH part buys {pairSym} in the same transaction and burns it.</span>
                    </li>
                  )}
                  <li>
                    <Lock size={14} className="pl-launch-muted" />
                    <span>The allocation and the reward token are fixed at launch. You can change the price, the mint window and royalties later.</span>
                  </li>
                </ul>
              </div>
            </Step>
          </form>

          <aside className="pl-launch-new-side">
            <Card className="pl-launch-preview pl-econ-palette">
              <span className="pl-launch-preview-label">Live preview</span>
              <div className="pl-collection-preview-art">
                {previewImage ? <img src={previewImage} alt="" /> : <TokenLogo token={{ symbol: symbol || name || 'NFT' }} size={96} />}
              </div>
              <div className="pl-launch-preview-head">
                <div className="pl-launch-preview-title">
                  <span className="pl-launch-preview-name">{name || 'Your collection'}</span>
                  <span className="pl-launch-muted mono">
                    {symbol || 'NFT'}
                    {pair ? ` · ${pair.symbol}` : ''}
                  </span>
                </div>
                <Badge tone="accent" pill>
                  New
                </Badge>
              </div>
              <div className="pl-launch-preview-grid">
                <div>
                  <span className="pl-launch-preview-k">Price</span>
                  <span className="mono pl-launch-strong">{priceWei > 0n ? ethText(priceWei) : 'Free'}</span>
                </div>
                <div>
                  <span className="pl-launch-preview-k">Supply</span>
                  <span className="mono pl-launch-strong">{Number(supply) ? Number(supply).toLocaleString('en-US') : kind === 'edition' ? 'Open' : '—'}</span>
                </div>
                <div>
                  <span className="pl-launch-preview-k">Holders paid in</span>
                  <span className="pl-launch-strong">{rewardSym}</span>
                </div>
                <div>
                  <span className="pl-launch-preview-k">Royalty</span>
                  <span className="mono pl-launch-strong">{royalty}%</span>
                </div>
              </div>
              <div className="pl-launch-preview-bar" aria-label="Mint allocation">
                {RING.filter((b) => shares[b.id] > 0).map((b) => (
                  <span key={b.id} className={`pl-econ-fill ${b.tone}`} style={{ width: `${shares[b.id]}%` }} title={`${b.label || 'Place'} ${pct(shares[b.id])}`} />
                ))}
              </div>
              <div className="pl-launch-preview-badges">
                <Badge tone="neutral">{kind === 'unique' ? 'Unique' : 'Edition'}</Badge>
                {pair && <Badge tone="neutral">{pair.symbol}</Badge>}
                {tokenPayments && priceWei > 0n && pair && <Badge tone="neutral">Pay in {pair.symbol}</Badge>}
              </div>
            </Card>
            <Card className="pl-launch-summary">
              <dl className="pl-launch-summary-kv">
                <div>
                  <dt>Type</dt>
                  <dd>{kind === 'unique' ? 'Unique' : 'Edition'}</dd>
                </div>
                <div>
                  <dt>Mint</dt>
                  <dd className="mono">{plan.params ? `${plan.params.maxSupply || '∞'} × ${priceWei > 0n ? ethText(priceWei) : 'free'}` : '—'}</dd>
                </div>
                <div>
                  <dt>Opens</dt>
                  <dd className="mono">{plan.params?.mintStart ? formatUtc(new Date(Number(plan.params.mintStart) * 1000)) : 'At once'}</dd>
                </div>
                <div>
                  <dt>Pair token</dt>
                  <dd>{pair?.symbol || '—'}</dd>
                </div>
                <div>
                  <dt>Split</dt>
                  <dd className="mono">
                    {NFT_PLATFORM_PCT} / {pct(shares.creator)} / {pct(shares.holders)} / {pct(shares.burn)}
                  </dd>
                </div>
                <div>
                  <dt>Creation fee</dt>
                  <dd className="mono">
                    {formatAmount(fee, 18)} ETH{!n ? ' (expected)' : ''}
                  </dd>
                </div>
              </dl>
              <div className="pl-launch-submit">
                {!account ? (
                  <ConnectButton size="lg">Connect wallet to launch</ConnectButton>
                ) : (
                  <TxButton tx={{ ...tx, busy: tx.busy || Boolean(stage) }} onClick={launch} size="lg" fullWidth variant="primary" disabled={!n || upload.busy || logo.busy} busyLabel={stage || 'Launching on Base...'}>
                    <Sparkles size={16} /> {n ? `Launch collection · ${formatAmount(fee, 18)} ETH` : 'Launching opens once the NFT launchpad is live'}
                  </TxButton>
                )}
                {touched && Object.keys(plan.errors).length > 0 && <span className="pl-place-hint error pl-launch-center">Fix the fields marked on the left.</span>}
                <span className="pl-place-hint pl-launch-center">You confirm the transaction in your wallet. You own the collection and can change the price, window and royalties later.</span>
                <TxResult tx={tx} success="Collection launched" />
                {launchError && (
                  <Alert tone="danger" icon={<AlertTriangle size={16} />}>
                    {launchError}
                  </Alert>
                )}
                {isTestnet && (
                  <span className="pl-place-hint pl-launch-center">
                    <Info size={12} /> Base Sepolia testnet. Get test ETH from a Base Sepolia faucet.
                  </span>
                )}
              </div>
            </Card>
            <MyCollections account={account} />
          </aside>
        </div>
      )}

      {picking === 'pair' && (
        <NftTokenPicker
          title="Pair token"
          desc="The collection works for this token: the burn buys it and mints can be paid in it. Tokens launched on Place and tokens Place has a swap route to."
          tokens={pairs}
          value={pair?.address}
          allowAddress
          emptyText="Tokens appear here once Place lists a swap route to them. Paste an address to check your own token."
          onPick={(t) => {
            setPair(t);
            setReward(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'reward' && (
        <NftTokenPicker
          title="Holders' reward token"
          desc={`NFT holders claim their rewards in this token. Anything other than ${pairSym} or ETH is bought in the mint transaction.`}
          tokens={rewardOptions.tokens}
          top={rewardOptions.top}
          value={rewardToken}
          emptyText="A token can be a reward once Place lists a swap route to it from ETH."
          onPick={(t) => setReward(t.address === pair?.address ? null : t.address)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
