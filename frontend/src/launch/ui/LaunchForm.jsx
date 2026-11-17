// Launch a token (/launch/new), in three steps as on the launchpad reference: 01 Basics (B20 or ERC-20, logo, name,
// ticker, pair, links), 02 Economy (Standard, or Economy with taxes and five buckets), 03 Launch options (fee split,
// dev buy, anti-sniping, editable metadata, vanity address). The live preview and the launch button sit on the right.
// `?pair=<address>` preselects the pair (the Stocks page links here). One transaction creates the token, its pool
// with locked liquidity and its vaults.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ImagePlus, RefreshCw, Loader2, Info, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { encodeFunctionData, isAddress, maxUint256 } from 'viem';
import { Button, Card, Badge, Alert } from '../../themes/place/components/ui';
import { TxButton, TxResult, ConnectButton } from '../../themes/place/pages/place/parts';
import { usePlaceAccount, usePlaceTx } from '../../place/hooks';
import { placeClient, isTestnet, explorerAddress } from '../../place/chain';
import { parseAmount, formatAmount, shortAddress } from '../../place/format';
import { launchApi } from '../client.js';
import { usePairs, launchD, launchKeys } from '../hooks.js';
import { LAUNCH_FACTORY_ABI, CREATOR_VAULT_ABI } from '../abi.js';
import { buildContractUri } from '../meta.js';
import { uploadImage, imageProblem } from '../image.js';
import { ERC20_ABI, ETH, quoteAddress, DIRECT_ROUTE } from '../swap.js';
import { httpsLink, xHandle, telegramHandle } from '../profile.js';
import { usd, smallNumber, compact } from '../format.js';
import { PairButton, PairPicker } from './PairPicker.jsx';
import { BUCKETS, DEFAULT_ALLOCATION, MIN_HOLDING_TOKENS, allocationTotal, pctToBps } from '../economy.js';
import { TokenLogo, launchPath, launchTokenPath } from './parts.jsx';
import { EconomyFields, LaunchTypePicker } from './EconomyFields.jsx';

const SUPPLY = 1_000_000_000;

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

/** A numbered step of the form. */
function Step({ n, title, desc, right, children }) {
  return (
    <section className="pl-launch-step">
      <div className="pl-launch-step-head">
        <span className="pl-launch-step-n mono">{String(n).padStart(2, '0')}</span>
        <div>
          <h2 className="pl-launch-step-title">{title}</h2>
          {desc && <p className="pl-launch-section-desc">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="pl-launch-step-body">{children}</div>
    </section>
  );
}

/** An on/off option card with its details below when on. */
function Option({ title, desc, on, onChange, children }) {
  return (
    <div className={`pl-launch-option ${on ? 'on' : ''}`.trim()}>
      <label className="pl-launch-option-head">
        <input type="checkbox" className="pl-launch-switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span className="pl-launch-option-text">
          <span className="pl-launch-strong">{title}</span>
          <span className="pl-launch-muted">{desc}</span>
        </span>
      </label>
      {on && children && <div className="pl-launch-option-body">{children}</div>}
    </div>
  );
}

/** Tokens a buy of `amountIn` quote gets right after launch: one range from the start price up, `feePct` fee. */
function devBuyOut(amountIn, startPrice, feePct) {
  if (!amountIn || !startPrice) return null;
  const L = SUPPLY * Math.sqrt(startPrice);
  const s1 = Math.sqrt(startPrice) + (amountIn * (1 - feePct / 100)) / L;
  return L / Math.sqrt(startPrice) - L / s1;
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** JSON launchParams from the API → the types viem encodes (0.3.0 economics). */
function toLaunchParams(p) {
  const e = p.economics;
  return {
    ...p,
    tokenKind: Number(p.tokenKind),
    expectedConfigVersion: BigInt(p.expectedConfigVersion),
    deadline: BigInt(p.deadline),
    economics: {
      ...e,
      launchType: Number(e.launchType),
      buyTaxRate: Number(e.buyTaxRate),
      sellTaxRate: Number(e.sellTaxRate),
      allocation: Object.fromEntries(Object.entries(e.allocation || {}).map(([k, v]) => [k, Number(v)])),
      minHolding: BigInt(e.minHolding || 0),
      minTraderDailyVolume: BigInt(e.minTraderDailyVolume || 0),
      xShares: (e.xShares || []).map((x) => ({ xId: BigInt(x.xId), bps: Number(x.bps) })),
    },
  };
}

const initialEconomy = (pairAddress) => ({
  buyTax: 3,
  sellTax: 3,
  allocation: { ...DEFAULT_ALLOCATION },
  minHolding: String(MIN_HOLDING_TOKENS),
  minTraderVolume: '',
  rewardToken: pairAddress || 'eth',
});

export default function LaunchForm() {
  const navigate = useNavigate();
  const { address } = usePlaceAccount();
  const pairsQ = usePairs();
  const pairs = useMemo(() => pairsQ.data?.pairs || [], [pairsQ.data]);
  const d = launchD();
  const [params] = useSearchParams();

  const [kind, setKind] = useState('b20');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [quote, setQuote] = useState(() => String(params.get('pair') || 'eth').toLowerCase());
  const [picker, setPicker] = useState(false);
  const [links, setLinks] = useState({ website: '', x: '', telegram: '' });
  const [logo, setLogo] = useState({ preview: null, uri: null, busy: false, error: null });
  const [suffix, setSuffix] = useState('');
  const [nonce, setNonce] = useState(0);
  const salt = useRef(null);
  const [launchType, setLaunchType] = useState('standard');
  const [econ, setEcon] = useState(() => initialEconomy(quote));
  const [split, setSplit] = useState(false);
  const [payout, setPayout] = useState('');
  const [xRows, setXRows] = useState([]);
  const [devBuy, setDevBuy] = useState(false);
  const [devAmount, setDevAmount] = useState('');
  const [antiSnipe, setAntiSnipe] = useState(true);
  const [editable, setEditable] = useState(false);
  const fileInput = useRef(null);
  const tx = usePlaceTx();
  const [stage, setStage] = useState(null);
  const [launchError, alertError] = useState(null);

  const pair = pairs.find((p) => p.address === quote) || null;
  useEffect(() => {
    if (pairs.length && !pairs.some((p) => p.address === quote)) setQuote(pairs[0].address);
  }, [pairs, quote]);

  // Reward tokens for this pair: the pair asset, the token itself, and listed swap routes.
  const rewardQ = useQuery({
    queryKey: [...launchKeys.all, 'reward-tokens', quote],
    enabled: Boolean(pair) && typeof launchApi.rewardTokens === 'function',
    staleTime: 60_000,
    queryFn: ({ signal }) => launchApi.rewardTokens(quote, signal),
  });
  const rewardTokens = useMemo(() => {
    if (rewardQ.data?.tokens?.length) return rewardQ.data.tokens;
    return pair ? [{ address: pair.address, symbol: pair.symbol, source: 'pair' }, { address: 'self', symbol: symbol || 'TOKEN', source: 'self' }] : [];
  }, [rewardQ.data, pair, symbol]);
  // A starting minimum for trader rewards when the pair changes: about $25 of the pair asset.
  const seededFor = useRef(null);
  useEffect(() => {
    if (!pair?.usd || seededFor.current === pair.address) return;
    seededFor.current = pair.address;
    setEcon((e) => ({ ...e, minTraderVolume: String(Number((25 / pair.usd).toPrecision(2))) }));
  }, [pair]);
  useEffect(() => {
    if (rewardTokens.length && !rewardTokens.some((t) => t.address === econ.rewardToken)) setEcon((e) => ({ ...e, rewardToken: rewardTokens[0].address }));
  }, [rewardTokens, econ.rewardToken]);

  // ── checks ──
  const nameErr = name.length > 64 ? 'At most 64 characters' : null;
  const symbolErr = symbol && !/^[A-Za-z0-9]{1,10}$/.test(symbol) ? 'Up to 10 letters or digits' : null;
  const linkErr = {};
  const cleanLinks = {};
  try {
    cleanLinks.website = httpsLink(links.website) || undefined;
  } catch (e) {
    linkErr.website = e.message;
  }
  try {
    const h = xHandle(links.x);
    cleanLinks.x = h ? `https://x.com/${h}` : undefined;
  } catch (e) {
    linkErr.x = e.message;
  }
  try {
    const h = telegramHandle(links.telegram);
    cleanLinks.telegram = h ? `https://t.me/${h}` : undefined;
  } catch (e) {
    linkErr.telegram = e.message;
  }
  const suffixErr = suffix && !/^[0-9a-fA-F]{1,2}$/.test(suffix) ? 'One or two hex characters (0–9, a–f)' : null;
  const xSharesPct = xRows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const xErr = split && xRows.some((r) => !/^\d{1,20}$/.test(r.id.trim()) || !(Number(r.pct) > 0)) ? 'Each X account needs its numeric id and a share above 0%' : null;
  const payoutErr = split && payout && !isAddress(payout.trim()) ? 'Not a wallet address' : null;
  const shareErr = split && xSharesPct > 100 ? 'X accounts can share at most 100% of your part' : null;

  const isEconomy = launchType === 'economy';
  const a = econ.allocation;
  const econErr = {};
  if (isEconomy) {
    if (allocationTotal(a) !== 100) econErr.allocation = 'The allocation must add up to 100%';
    const mh = Number(econ.minHolding);
    if (a.holders > 0 && !(mh >= MIN_HOLDING_TOKENS && mh <= SUPPLY)) econErr.minHolding = `Between ${MIN_HOLDING_TOKENS.toLocaleString('en-US')} and ${SUPPLY.toLocaleString('en-US')} tokens`;
    if (a.traders > 0 && !(Number(econ.minTraderVolume) > 0)) econErr.minTraderVolume = `Enter a daily volume in ${pair?.symbol || 'the pair asset'}`;
  }
  const feePct = isEconomy ? econ.buyTax : 1;
  const devIn = devBuy ? parseAmount(devAmount, pair?.decimals ?? 18) : null;
  const devErr = devBuy && devAmount && !devIn ? 'Enter an amount' : null;

  const ready = Boolean(
    name.trim() && symbol && !nameErr && !symbolErr && !Object.keys(linkErr).length && pair && !suffixErr && !shareErr && !xErr && !payoutErr && !logo.busy && !Object.keys(econErr).length
  );

  // ── address preview: the API mines a salt for the 01 ending (+ the vanity suffix), and keeps it while details change ──
  const contractURI = buildContractUri({ image: logo.uri });
  const predictArgs = useDebounced(
    ready && address
      ? {
          creator: address,
          kind,
          quote,
          name: name.trim(),
          symbol,
          uri: contractURI,
          editable: editable ? '1' : '0',
          ...cleanLinks,
          type: launchType,
          antiSnipe: antiSnipe ? '1' : '0',
          ...(isEconomy
            ? {
                buyTaxBps: pctToBps(econ.buyTax),
                sellTaxBps: pctToBps(econ.sellTax),
                ...Object.fromEntries(BUCKETS.map((b) => [`${b.id}Bps`, pctToBps(a[b.id])])),
                minHolding: a.holders > 0 ? econ.minHolding : undefined,
                minTraderVolume: a.traders > 0 ? econ.minTraderVolume : undefined,
                rewardToken: a.holders > 0 || a.traders > 0 ? econ.rewardToken : undefined,
              }
            : {}),
          xShares: split ? xRows.map((r) => `${r.id.trim()}:${Math.round(Number(r.pct) * 100)}`).join(',') || undefined : undefined,
          suffix: suffix || undefined,
          nonce,
        }
      : null,
    500
  );
  const prediction = useQuery({
    queryKey: [...launchKeys.all, 'predict', predictArgs],
    enabled: Boolean(predictArgs),
    staleTime: 10 * 60_000,
    retry: 0,
    queryFn: async ({ signal }) => {
      const { nonce: _n, ...args } = predictArgs;
      try {
        return await launchApi.predict({ ...args, salt: salt.current || undefined }, signal);
      } catch (e) {
        if (e?.status === 409 && salt.current) {
          salt.current = null;
          return launchApi.predict(args, signal);
        }
        throw e;
      }
    },
  });
  useEffect(() => {
    if (prediction.data?.creatorSalt) salt.current = prediction.data.creatorSalt;
  }, [prediction.data]);

  const quoteBalance = useQuery({
    queryKey: [...launchKeys.all, 'quote-balance', address, quote],
    enabled: Boolean(address && devBuy && pair),
    queryFn: async () => {
      const client = placeClient();
      const q = quoteAddress(quote);
      return q === ETH ? client.getBalance({ address }) : client.readContract({ address: q, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
    },
  });

  const pickLogo = async (file) => {
    if (!file) return;
    const problem = imageProblem(file);
    if (problem) {
      setLogo((l) => ({ ...l, error: problem }));
      return;
    }
    const preview = URL.createObjectURL(file);
    setLogo({ preview, uri: null, busy: true, error: null });
    try {
      const uri = await uploadImage(file);
      setLogo({ preview, uri, busy: false, error: null });
    } catch (e) {
      setLogo({ preview: null, uri: null, busy: false, error: `Upload failed: ${e.message}` });
    }
  };

  const fee = BigInt(prediction.data?.nativeLaunchFee || '500000000000000');
  const devTokens = devBuyOut(devIn != null ? Number(devAmount) : null, pair?.startPrice, feePct);

  const launch = async () => {
    if (!ready || !address || notDeployed) return;
    alertError(null);
    setStage('Reserving your address...');
    let p;
    try {
      const { nonce: _n, ...args } = predictArgs || {};
      p = await launchApi.predict({ ...args, salt: salt.current || undefined });
    } catch (e) {
      setStage(null);
      tx.reset();
      alertError(e.message);
      return;
    }
    setStage(null);
    const calls = [];
    const q = quoteAddress(quote);
    if (devIn) {
      if (q !== ETH) {
        const allowance = await placeClient().readContract({ address: q, abi: ERC20_ABI, functionName: 'allowance', args: [address, d.launchBuyAdapter] });
        if (allowance < devIn) {
          calls.push({ label: `Allow the dev buy to spend ${pair.symbol}`, to: q, abi: ERC20_ABI, functionName: 'approve', args: [d.launchBuyAdapter, maxUint256] });
        }
      }
      calls.push({
        label: 'Launch and buy',
        to: d.factory,
        data: encodeFunctionData({
          abi: LAUNCH_FACTORY_ABI,
          functionName: 'createLaunchAndBuy',
          args: [toLaunchParams(p.launchParams), { fundingToken: q, amountIn: devIn, minAmountOut: 1n, routeData: DIRECT_ROUTE }],
        }),
        value: BigInt(p.nativeLaunchFee) + (q === ETH ? devIn : 0n),
      });
    } else {
      calls.push({ label: 'Launch', to: d.factory, data: p.tx.data, value: BigInt(p.tx.value) });
    }
    const payTo = split && payout.trim() && payout.trim().toLowerCase() !== address ? payout.trim() : null;
    if (payTo) calls.push({ label: 'Set the payout wallet', to: p.vault, abi: CREATOR_VAULT_ABI, functionName: 'setPayoutAddress', args: [payTo] });
    const receipt = await tx.send(calls);
    if (receipt) {
      salt.current = null;
      setTimeout(() => navigate(launchTokenPath(p.token)), 1200);
    }
  };
  // Before 0.3.0 is deployed the API answers from local math: no address, no transaction.
  const notDeployed = prediction.data?.deployed === false;
  const predicted = prediction.data?.token ? prediction.data : null;
  const ending = (suffix || '').toLowerCase() + '01';
  const rewardSymbol = rewardTokens.find((t) => t.address === econ.rewardToken)?.symbol;

  return (
    <div className="pl-launch pl-launch-new">
      <Link to={launchPath()} className="pl-place-back">
        <ArrowLeft size={14} />
        Dashboard
      </Link>
      <header className="pl-launch-new-header">
        <h1 className="page-title">Launch a token</h1>
        <p className="page-desc">One transaction creates the token, its pool with liquidity locked for good, and its vaults</p>
      </header>

      <div className="pl-launch-new-cols">
        <form className="pl-place-form pl-launch-new-form" onSubmit={(e) => e.preventDefault()}>
          <Step n={1} title="Basics">
            <div className="pl-launch-kinds" role="radiogroup" aria-label="Token standard">
              {[
                { id: 'b20', title: 'B20', badge: 'Base standard', desc: 'Native Base token: fixed supply, no admin, cheaper transfers. Address starts with 0xB2.' },
                { id: 'erc20', title: 'ERC-20', badge: 'Classic', desc: 'The standard every wallet and app knows. Fixed supply, no owner, no mint.' },
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
            <div className="pl-launch-logo-row">
              <button type="button" className="pl-launch-logo-drop" onClick={() => fileInput.current?.click()} aria-label="Upload logo">
                {logo.preview ? <img src={logo.preview} alt="" /> : <ImagePlus size={24} />}
                {logo.busy && (
                  <span className="pl-launch-logo-busy">
                    <Loader2 size={18} className="spin" />
                  </span>
                )}
              </button>
              <div className="pl-launch-logo-text">
                <Button size="sm" type="button" onClick={() => fileInput.current?.click()}>
                  <ImagePlus size={15} />
                  {logo.preview ? 'Change logo' : 'Upload logo'}
                </Button>
                <span className="pl-place-hint">PNG, JPG, WEBP or GIF. Square works best; we crop and resize it to 512 px.</span>
                {logo.busy && <span className="pl-place-hint">Uploading to IPFS...</span>}
                {logo.error && <span className="pl-place-hint error">{logo.error}</span>}
              </div>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
            </div>
            <div className="pl-launch-two">
              <Field label="Name" error={nameErr} counter={<span className="pl-launch-counter">{name.length}/64</span>}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Token" maxLength={64} />
              </Field>
              <Field label="Ticker" error={symbolErr} hint="Can't be changed after launch">
                <div className="pl-launch-prefixed">
                  <span>$</span>
                  <input value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10))} placeholder="TOKEN" />
                </div>
              </Field>
            </div>
            <Field label="Pair asset" hint="What buyers pay with. Crypto: ETH, USDC and more. Stocks: tokenized shares on Base.">
              <PairButton pair={pair} onClick={() => setPicker(true)} disabled={!pairs.length} />
            </Field>
            {pairsQ.error && (
              <Alert tone="danger" icon={<AlertTriangle size={16} />} action={<Button size="sm" type="button" onClick={() => pairsQ.refetch()}>Try again</Button>}>
                Could not load the pairs: {pairsQ.error.message}
              </Alert>
            )}
            {pairsQ.isLoading && <span className="pl-place-hint">Loading pairs...</span>}
            <div className="pl-launch-three">
              <Field label="Website" error={linkErr.website}>
                <input value={links.website} onChange={(e) => setLinks({ ...links, website: e.target.value })} placeholder="yourproject.xyz" />
              </Field>
              <Field label="X" error={linkErr.x}>
                <input value={links.x} onChange={(e) => setLinks({ ...links, x: e.target.value })} placeholder="x.com/yourproject" />
              </Field>
              <Field label="Telegram" error={linkErr.telegram}>
                <input value={links.telegram} onChange={(e) => setLinks({ ...links, telegram: e.target.value })} placeholder="t.me/yourproject" />
              </Field>
            </div>
          </Step>

          <Step n={2} title="Economy" desc="A plain token, or one with its own taxes and rewards">
            <LaunchTypePicker value={launchType} onChange={setLaunchType} />
            {isEconomy ? (
              <EconomyFields value={econ} onChange={setEcon} pair={pair} symbol={symbol} rewardTokens={rewardTokens} errors={econErr} />
            ) : (
              <p className="pl-place-hint">Every buy and sell pays 1% in {pair?.symbol || 'the pair asset'}: 0.7% to you, 0.3% to Place. You claim your part in Profile.</p>
            )}
            {econErr.allocation && <span className="pl-place-hint error">{econErr.allocation}</span>}
          </Step>

          <Step
            n={3}
            title="Launch options"
            right={
              <button
                type="button"
                className="pl-place-icon-btn pl-launch-refresh"
                aria-label="New address"
                title="New address"
                disabled={!predictArgs || prediction.isFetching}
                onClick={() => {
                  salt.current = null;
                  setNonce((n) => n + 1);
                }}
              >
                <RefreshCw size={15} className={prediction.isFetching ? 'spin' : ''} />
              </button>
            }
          >
            <div className="pl-launch-options">
              <Option title="Share creator fees" desc="Send your creator funds to another wallet, or share them with X accounts. This does not change the taxes." on={split} onChange={setSplit}>
                <Field label="Payout wallet" error={payoutErr} hint="Leave empty to get paid to this wallet. You can change it any time.">
                  <input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder={address || '0x...'} className="mono" spellCheck={false} />
                </Field>
                <div className="pl-launch-xrows">
                  <span className="pl-launch-field-label">X accounts</span>
                  {xRows.map((r, i) => (
                    <div key={i} className="pl-launch-xrow">
                      <input
                        value={r.id}
                        onChange={(e) => setXRows(xRows.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/\D/g, '') } : x)))}
                        placeholder="Numeric X user id"
                        className="mono"
                        aria-label="X user id"
                      />
                      <div className="pl-launch-prefixed suffix">
                        <input value={r.pct} onChange={(e) => setXRows(xRows.map((x, j) => (j === i ? { ...x, pct: e.target.value.replace(/[^\d.]/g, '') } : x)))} placeholder="10" aria-label="Share in percent" />
                        <span>%</span>
                      </div>
                      <button type="button" className="pl-place-icon-btn" aria-label="Remove" onClick={() => setXRows(xRows.filter((_, j) => j !== i))}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {(xErr || shareErr) && <span className="pl-place-hint error">{xErr || shareErr}</span>}
                  {xRows.length < 5 && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setXRows([...xRows, { id: '', pct: '' }])}>
                      <Plus size={14} />
                      Add X account
                    </Button>
                  )}
                  <span className="pl-place-hint">Shares are a part of your creator funds. They wait in the vault until the account links a wallet with Sign in with X (coming soon).</span>
                </div>
              </Option>
              <Option title="Include dev buy" desc={`Buy tokens as part of the launch, in the same transaction, at the normal ${isEconomy ? 'buy tax' : '1% fee'}`} on={devBuy} onChange={setDevBuy}>
                <Field
                  label={`Amount in ${pair?.symbol || 'the pair asset'}`}
                  error={devErr}
                  hint={quoteBalance.data != null ? `Balance: ${formatAmount(quoteBalance.data, pair?.decimals ?? 18)} ${pair?.symbol || ''}` : null}
                >
                  <div className="pl-launch-prefixed suffix">
                    <input value={devAmount} onChange={(e) => setDevAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.01" inputMode="decimal" className="mono" />
                    <span>{pair?.symbol}</span>
                  </div>
                </Field>
              </Option>
              <div className="pl-launch-two even">
                <Option title="Enable anti-sniping" desc="Fees start high and fall to the normal rate over 20 seconds. The dev buy skips this extra charge." on={antiSnipe} onChange={setAntiSnipe} />
                <Option title="Metadata editable after launch" desc="Let the creator update the name and logo after launch. Leave off to lock them. The ticker never changes." on={editable} onChange={setEditable} />
              </div>
            </div>
            <div className="pl-launch-vanity">
              <Field label="Address ending" error={suffixErr} hint="Optional, before the 01 every Place address ends in">
                <div className="pl-launch-prefixed suffix">
                  <input
                    value={suffix}
                    onChange={(e) => {
                      salt.current = null;
                      setSuffix(e.target.value.replace(/^0x/i, '').slice(0, 2));
                    }}
                    placeholder="ab"
                    className="mono"
                    spellCheck={false}
                  />
                  <span className="mono">01</span>
                </div>
              </Field>
              <div className="pl-launch-address">
                <span className="pl-launch-field-label">Your token address</span>
                <span className="pl-launch-address-value mono">
                  {!address ? (
                    <span className="pl-launch-muted">Connect a wallet to reserve one</span>
                  ) : !predictArgs ? (
                    <span className="pl-launch-muted">Fill in the name, ticker and pair first</span>
                  ) : notDeployed ? (
                    <span className="pl-launch-muted">Launch contracts 0.3.0 are not deployed on this network yet</span>
                  ) : prediction.isFetching && !predicted ? (
                    <span className="pl-launch-muted">Finding an address ending in {ending}...</span>
                  ) : prediction.error ? (
                    <span className="pl-place-hint error">{prediction.error.message}</span>
                  ) : predicted ? (
                    <>
                      {predicted.token.slice(0, -ending.length)}
                      <span className="pl-launch-accent">{predicted.token.slice(-ending.length)}</span>
                    </>
                  ) : null}
                </span>
                {kind === 'erc20' && predicted && <span className="pl-place-hint">An ERC-20 address depends on the name, logo and links, so it changes while you edit them. B20 addresses stay put.</span>}
              </div>
            </div>
          </Step>
        </form>

        <aside className="pl-launch-new-side">
          <Preview
            kind={kind}
            name={name}
            symbol={symbol}
            logo={logo.preview}
            pair={pair}
            launchType={launchType}
            econ={econ}
            rewardSymbol={rewardSymbol === 'TOKEN' || econ.rewardToken === 'self' ? symbol || 'your token' : rewardSymbol}
            editable={editable}
          />
          <Card className="pl-launch-summary">
            <dl className="pl-launch-summary-kv">
              <div>
                <dt>Fixed supply</dt>
                <dd className="mono">1B</dd>
              </div>
              <div>
                <dt>Pool model</dt>
                <dd>Locked pool</dd>
              </div>
              <div>
                <dt>Launch market cap</dt>
                <dd className="mono">{pair?.startFdvUsd != null ? `≈ ${usd(pair.startFdvUsd)}` : pair ? `${smallNumber(pair.startFdv)} ${pair.symbol}` : '—'}</dd>
              </div>
              <div>
                <dt>Taxes</dt>
                <dd className="mono">{isEconomy ? `${econ.buyTax}% buy · ${econ.sellTax}% sell` : '1% buy · 1% sell'}</dd>
              </div>
              <div>
                <dt>Creation fee</dt>
                <dd className="mono">{formatAmount(fee, 18)} ETH</dd>
              </div>
              <div>
                <dt>Paired asset</dt>
                <dd>{pair?.symbol || '—'}</dd>
              </div>
              {devIn && (
                <div>
                  <dt>Dev buy</dt>
                  <dd className="mono">
                    {devAmount} {pair?.symbol} → ~{compact(devTokens)}
                  </dd>
                </div>
              )}
              <div>
                <dt>Address</dt>
                <dd className="mono">
                  {predicted ? (
                    <a className="pl-place-link" href={explorerAddress(predicted.token)} target="_blank" rel="noopener noreferrer">
                      {shortAddress(predicted.token)}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            </dl>
            <div className="pl-launch-submit">
              {!address ? (
                <ConnectButton size="lg">Connect wallet to launch</ConnectButton>
              ) : (
                <TxButton tx={tx} onClick={launch} size="lg" fullWidth variant="primary" disabled={!ready || Boolean(stage) || !predicted} busyLabel="Launching on Base...">
                  {notDeployed ? 'Launching opens once 0.3.0 is deployed' : stage || `Launch token · ${formatAmount(fee + (devIn && quoteAddress(quote) === ETH ? devIn : 0n), 18)} ETH`}
                </TxButton>
              )}
              {address && !ready && <span className="pl-place-hint pl-launch-center">Add a name, a ticker and a pair{isEconomy ? ', and finish the economy' : ''} to launch.</span>}
              <span className="pl-place-hint pl-launch-center">You confirm the transaction in your wallet. Nothing is minted until you submit.</span>
              {tx.step && tx.busy && <span className="pl-place-hint">Step: {tx.step}</span>}
              <TxResult tx={tx} success="Launched. Opening your token page" />
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
        </aside>
      </div>

      {picker && (
        <PairPicker
          pairs={pairs}
          value={quote}
          onPick={(addr) => {
            salt.current = null;
            setQuote(addr);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

function Preview({ kind, name, symbol, logo, pair, launchType, econ, rewardSymbol, editable }) {
  const startPrice = pair?.startPrice;
  const startUsd = pair?.usd != null && startPrice != null ? startPrice * pair.usd : null;
  const isEconomy = launchType === 'economy';
  const a = econ.allocation;
  return (
    <Card className="pl-launch-preview">
      <span className="pl-launch-preview-label">Live preview</span>
      <div className="pl-launch-preview-head">
        <TokenLogo token={{ symbol: symbol || name || 'T', name }} src={logo} size={48} />
        <div className="pl-launch-preview-title">
          <span className="pl-launch-preview-name">{name || 'Your token'}</span>
          <span className="pl-launch-muted mono">
            {symbol || 'TOKEN'}/{pair?.symbol || '—'}
          </span>
        </div>
        <Badge tone="accent" pill>
          New
        </Badge>
      </div>
      <p className="pl-launch-preview-desc">
        {isEconomy
          ? `${econ.buyTax}% buy and ${econ.sellTax}% sell tax, split between ${BUCKETS.filter((b) => a[b.id] > 0)
              .map((b) => b.short.toLowerCase())
              .join(', ')}.`
          : 'Fixed-supply token trading on a locked Uniswap v4 pool.'}
      </p>
      <div className="pl-launch-preview-grid">
        <div>
          <span className="pl-launch-preview-k">Start price</span>
          <span className="mono pl-launch-strong">{startUsd != null ? `≈ ${usd(startUsd)}` : startPrice != null ? `${smallNumber(startPrice)} ${pair.symbol}` : '—'}</span>
          {startPrice != null && pair?.usd != null && <span className="pl-launch-muted pl-launch-small mono">{smallNumber(startPrice)} {pair.symbol}</span>}
        </div>
        <div>
          <span className="pl-launch-preview-k">Launch cap</span>
          <span className="mono pl-launch-strong">{pair?.startFdvUsd != null ? `≈ ${usd(pair.startFdvUsd)}` : '—'}</span>
          {pair && <span className="pl-launch-muted pl-launch-small mono">{smallNumber(pair.startFdv)} {pair.symbol}</span>}
        </div>
        <div>
          <span className="pl-launch-preview-k">Fixed supply</span>
          <span className="mono pl-launch-strong">1B</span>
        </div>
        {isEconomy && (a.holders > 0 || a.traders > 0) && (
          <div>
            <span className="pl-launch-preview-k">Rewards in</span>
            <span className="pl-launch-strong">{rewardSymbol || '—'}</span>
          </div>
        )}
      </div>
      {isEconomy && (
        <div className="pl-launch-preview-bar" aria-label="Tax allocation">
          {BUCKETS.filter((b) => a[b.id] > 0).map((b) => (
            <span key={b.id} className={`pl-econ-fill ${b.tone}`} style={{ width: `${a[b.id]}%` }} title={`${b.label} ${a[b.id]}%`} />
          ))}
        </div>
      )}
      <div className="pl-launch-preview-badges">
        <Badge tone="neutral">{kind === 'b20' ? 'B20' : 'ERC-20'}</Badge>
        {pair && <Badge tone="neutral">{pair.symbol}</Badge>}
        <Badge tone="neutral">{isEconomy ? 'Economy' : 'Standard'}</Badge>
        {!editable && <Badge tone="success">Immutable</Badge>}
      </div>
    </Card>
  );
}
