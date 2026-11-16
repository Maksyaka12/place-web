// Launch a token (/launch/new): type, logo, name, ticker, pair, links, vanity address, options (fee split,
// dev buy, editable metadata) and the Economics block: the creator's 0.7% in three baskets (burn, community fund,
// the creator), set with templates and nested sliders.
// The preview on the right shows the token as it will start. One transaction creates the token, its pool
// with locked liquidity and the creator vault.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ImagePlus, RefreshCw, Loader2, Info, Plus, Trash2, Flame, Users, HandCoins, AlertTriangle, Lock } from 'lucide-react';
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
import {
  PLATFORM_FEE_PCT,
  ECONOMY_TEMPLATES,
  templateOf,
  basketsFromNested,
  nestedFromBaskets,
  toBps,
  feeFlow,
  flowSentence,
} from '../economy.js';
import { TokenLogo, EconomicsBar, launchPath, launchTokenPath } from './parts.jsx';

const SUPPLY = 1_000_000_000;
const CREATOR_FEE_PCT_TEXT = 0.7;

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

function Section({ title, desc, children, right }) {
  return (
    <Card className="pl-launch-section">
      <div className="pl-launch-section-head">
        <div>
          <h2 className="pl-launch-section-title">{title}</h2>
          {desc && <p className="pl-launch-section-desc">{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

/** An on/off option row with its details below when on. */
function Option({ title, desc, on, onChange, children }) {
  return (
    <div className={`pl-launch-option ${on ? 'on' : ''}`.trim()}>
      <label className="pl-launch-option-head">
        <span className="pl-launch-option-text">
          <span className="pl-launch-strong">{title}</span>
          <span className="pl-launch-muted">{desc}</span>
        </span>
        <input type="checkbox" className="pl-launch-switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      </label>
      {on && children && <div className="pl-launch-option-body">{children}</div>}
    </div>
  );
}

/** A 0–100% slider in 5% steps with the value beside it. */
function Percent({ label, value, onChange, max = 100, Icon, tone, sub, nested }) {
  return (
    <div className={`pl-launch-percent ${nested ? 'nested' : ''}`.trim()}>
      <div className="pl-launch-percent-head">
        <span className="pl-launch-percent-label">
          {Icon && <Icon size={15} className={tone} />}
          {label}
        </span>
        <span className="mono pl-launch-strong">{value}%</span>
      </div>
      <input type="range" min={0} max={max} step={5} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      {sub && <span className="pl-place-hint">{sub}</span>}
    </div>
  );
}

/** Tokens a buy of `amountIn` quote gets right after launch: one range from the start price up, 1% fee. */
function devBuyOut(amountIn, startPrice) {
  if (!amountIn || !startPrice) return null;
  const L = SUPPLY * Math.sqrt(startPrice);
  const s1 = Math.sqrt(startPrice) + (amountIn * 0.99) / L;
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

/** JSON launchParams from the API → the types viem encodes. */
function toLaunchParams(p) {
  return {
    ...p,
    tokenKind: Number(p.tokenKind),
    expectedConfigVersion: BigInt(p.expectedConfigVersion),
    deadline: BigInt(p.deadline),
    economics: {
      ...p.economics,
      burnBps: Number(p.economics.burnBps),
      communityBps: Number(p.economics.communityBps),
      xShares: (p.economics.xShares || []).map((x) => ({ xId: BigInt(x.xId), bps: Number(x.bps) })),
    },
  };
}

export default function LaunchForm() {
  const navigate = useNavigate();
  const { address } = usePlaceAccount();
  const pairsQ = usePairs();
  const pairs = useMemo(() => pairsQ.data?.pairs || [], [pairsQ.data]);
  const d = launchD();

  const [kind, setKind] = useState('b20');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [quote, setQuote] = useState('eth');
  const [picker, setPicker] = useState(false);
  const [links, setLinks] = useState({ website: '', x: '', telegram: '' });
  const [logo, setLogo] = useState({ preview: null, uri: null, busy: false, error: null });
  const [suffix, setSuffix] = useState('');
  const [nonce, setNonce] = useState(0);
  const salt = useRef(null);
  const [split, setSplit] = useState(false);
  const [payout, setPayout] = useState('');
  const [xRows, setXRows] = useState([]);
  const [devBuy, setDevBuy] = useState(false);
  const [devAmount, setDevAmount] = useState('');
  const [editable, setEditable] = useState(true);
  // Nested sliders: how much of your part goes back to the token, and how much of that is burned.
  const [nested, setNested] = useState(() => nestedFromBaskets(ECONOMY_TEMPLATES[3].burn, ECONOMY_TEMPLATES[3].fund));
  const { burn, fund } = basketsFromNested(nested.giveBack, nested.burnOfGiveBack);
  const template = templateOf(burn, fund);
  const pickTemplate = (t) => setNested(nestedFromBaskets(t.burn, t.fund));
  const fileInput = useRef(null);
  const tx = usePlaceTx();
  const [stage, setStage] = useState(null);
  const [launchError, alertError] = useState(null);

  const pair = pairs.find((p) => p.address === quote) || null;
  useEffect(() => {
    if (pairs.length && !pairs.some((p) => p.address === quote)) setQuote(pairs[0].address);
  }, [pairs, quote]);

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
  const youPct = 100 - burn - fund;
  const shareErr = split && xSharesPct > 100 ? 'X accounts can share at most 100% of your part' : null;
  const flow = feeFlow({ burn, fund, xPct: split ? Math.min(xSharesPct, 100) : 0 });
  const devIn = devBuy ? parseAmount(devAmount, pair?.decimals ?? 18) : null;
  const devErr = devBuy && devAmount && !devIn ? 'Enter an amount' : null;

  const ready = Boolean(name.trim() && symbol && !nameErr && !symbolErr && !Object.keys(linkErr).length && pair && !suffixErr && !shareErr && !xErr && !payoutErr && !logo.busy);

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
          burnBps: toBps(burn),
          communityBps: toBps(fund),
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
  const devTokens = devBuyOut(devIn != null ? Number(devAmount) : null, pair?.startPrice);

  const launch = async () => {
    if (!ready || !address) return;
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
    const params = toLaunchParams(p.launchParams);
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
          args: [params, { fundingToken: q, amountIn: devIn, minAmountOut: 1n, routeData: DIRECT_ROUTE }],
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
  const predicted = prediction.data;
  const ending = (suffix || '').toLowerCase() + '01';

  return (
    <div className="pl-launch pl-launch-new">
      <Link to={launchPath()} className="pl-place-back">
        <ArrowLeft size={14} />
        Launchpad
      </Link>
      <header className="page-header pl-launch-new-header">
        <h1 className="page-title">Launch a token</h1>
        <p className="page-desc">One transaction creates the token, its pool with liquidity locked for good, and your fee vault</p>
      </header>

      <div className="pl-launch-new-cols">
        <form className="pl-place-form pl-launch-new-form" onSubmit={(e) => e.preventDefault()}>
          <Section title="Token type">
            <div className="pl-launch-kinds" role="radiogroup" aria-label="Token type">
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
          </Section>

          <Section title="Token">
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
          </Section>

          <Section title="Links" desc="Optional. Shown on the token page.">
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
          </Section>

          <Section
            title="Economics"
            desc={`Every trade pays a 1% fee: ${CREATOR_FEE_PCT_TEXT}% to your token's vault, ${PLATFORM_FEE_PCT}% to Place. Choose what your part does.`}
          >
            <div className="pl-launch-econ">
              <div className="pl-launch-templates" role="radiogroup" aria-label="Economics template">
                {ECONOMY_TEMPLATES.map((t) => (
                  <button key={t.id} type="button" role="radio" aria-selected={template?.id === t.id} className="pl-launch-template" onClick={() => pickTemplate(t)}>
                    <span className="pl-launch-strong">{t.label}</span>
                    <span className="pl-launch-muted mono">
                      {t.burn ? `${t.burn}% burn` : 'no burn'} · {t.fund ? `${t.fund}% fund` : 'no fund'}
                    </span>
                  </button>
                ))}
              </div>
              {template && <p className="pl-place-hint">{template.desc}.</p>}
              <Percent
                label="Give back to the token"
                value={nested.giveBack}
                onChange={(v) => setNested({ ...nested, giveBack: v })}
                Icon={HandCoins}
                tone="pl-launch-accent"
                sub={`${nested.giveBack}% of your part works for holders, ${youPct}% is yours.`}
              />
              {nested.giveBack > 0 && (
                <Percent
                  nested
                  label="Of that, burn"
                  value={Math.round(nested.burnOfGiveBack / 5) * 5}
                  onChange={(v) => setNested({ ...nested, burnOfGiveBack: v })}
                  Icon={Flame}
                  tone="pl-launch-buy"
                  sub={`${burn}% burned, ${fund}% to the community fund.`}
                />
              )}
              <EconomicsBar burn={burn} fund={fund} x={split ? (youPct * Math.min(xSharesPct, 100)) / 100 : 0} you={split ? (youPct * (100 - Math.min(xSharesPct, 100))) / 100 : youPct} />
              <p className="pl-launch-flow">{flowSentence(flow)}.</p>
              {shareErr && <span className="pl-place-hint error">{shareErr}</span>}
              <ul className="pl-launch-econ-notes">
                {burn > 0 && (
                  <li>
                    <Flame size={14} className="pl-launch-buy" />
                    <span>
                      Burn: once a day the vault buys {symbol ? `$${symbol}` : 'the token'} in its own pool and sends it to 0x…dEaD. Anyone can trigger it, Place does it daily. Small daily buys keep the price impact low.
                    </span>
                  </li>
                )}
                {fund > 0 && (
                  <li>
                    <Users size={14} className="pl-launch-accent" />
                    <span>
                      Community fund: stays in the vault. You cannot withdraw it, you can only turn it into holder campaigns or staking programs, in any listed reward token. If you leave it unused for 30 days, anyone can start a default holder campaign
                      {pair?.defaultCampaignMinimum ? ` (from ${formatAmount(pair.defaultCampaignMinimum, pair.decimals)} ${pair.symbol})` : ''}.
                    </span>
                  </li>
                )}
              </ul>
              <Alert tone="info" icon={<Lock size={15} />}>
                After launch you can raise the burn and fund shares, never lower them, so holders can count on them.
              </Alert>
            </div>
          </Section>

          <Section title="Options">
            <div className="pl-launch-options">
              <Option title="Split creator fees" desc="Send your part to another wallet, or share it with X accounts" on={split} onChange={setSplit}>
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
                  {xErr && <span className="pl-place-hint error">{xErr}</span>}
                  {xRows.length < 5 && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setXRows([...xRows, { id: '', pct: '' }])}>
                      <Plus size={14} />
                      Add X account
                    </Button>
                  )}
                  <span className="pl-place-hint">
                    Shares are a part of your creator fee. They wait in the vault until the account links a wallet with Sign in with X (coming soon).
                  </span>
                </div>
              </Option>
              <Option
                title="Dev buy"
                desc="Buy your own token in the launch transaction, before anyone else, at the normal 1% fee"
                on={devBuy}
                onChange={setDevBuy}
              >
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
              <Option title="Editable metadata" desc="Change the name and logo later. The ticker never changes." on={editable} onChange={setEditable} />
            </div>
          </Section>

          <Section
            title="Token address"
            desc="Every Place token address ends in 01. Add up to two characters of your own before it."
            right={
              <button type="button" className="pl-place-icon-btn pl-launch-refresh" aria-label="New address" title="New address" disabled={!predictArgs || prediction.isFetching} onClick={() => {
                salt.current = null;
                setNonce((n) => n + 1);
              }}>
                <RefreshCw size={15} className={prediction.isFetching ? 'spin' : ''} />
              </button>
            }
          >
            <div className="pl-launch-vanity">
              <Field label="Ending" error={suffixErr}>
                <div className="pl-launch-prefixed suffix">
                  <input value={suffix} onChange={(e) => {
                    salt.current = null;
                    setSuffix(e.target.value.replace(/^0x/i, '').slice(0, 2));
                  }} placeholder="ab" className="mono" spellCheck={false} />
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
                {kind === 'erc20' && predicted && (
                  <span className="pl-place-hint">An ERC-20 address depends on the name, logo and links, so it changes while you edit them. B20 addresses stay put.</span>
                )}
              </div>
            </div>
          </Section>
        </form>

        <aside className="pl-launch-new-side">
          <Preview
            kind={kind}
            name={name}
            symbol={symbol}
            logo={logo.preview}
            pair={pair}
            predicted={predicted}
            fee={fee}
            devTokens={devTokens}
            devAmount={devIn ? devAmount : null}
            burn={burn}
            fund={fund}
          />
          <div className="pl-launch-submit">
            {!address ? (
              <ConnectButton size="lg">Connect wallet to launch</ConnectButton>
            ) : (
              <TxButton tx={tx} onClick={launch} size="lg" fullWidth disabled={!ready || Boolean(stage) || !prediction.data} busyLabel="Launching on Base...">
                {stage || `Launch ${symbol ? `$${symbol}` : 'token'} · ${formatAmount(fee + (devIn && quoteAddress(quote) === ETH ? devIn : 0n), 18)} ETH`}
              </TxButton>
            )}
            {address && !ready && <span className="pl-place-hint">Add a name, a ticker and a pair to launch.</span>}
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
        </aside>
      </div>

      {picker && <PairPicker pairs={pairs} value={quote} onPick={(a) => {
        salt.current = null;
        setQuote(a);
      }} onClose={() => setPicker(false)} />}
    </div>
  );
}

function Preview({ kind, name, symbol, logo, pair, predicted, fee, devTokens, devAmount, burn, fund }) {
  const startPrice = pair?.startPrice;
  const startUsd = pair?.usd != null && startPrice != null ? startPrice * pair.usd : null;
  return (
    <Card className="pl-launch-preview">
      <span className="pl-launch-preview-label">Preview</span>
      <div className="pl-launch-preview-head">
        <TokenLogo token={{ symbol: symbol || name || '?', name }} src={logo} size={56} />
        <div className="pl-launch-preview-title">
          <span className="pl-launch-preview-name">{name || 'Token name'}</span>
          <span className="pl-launch-muted">${symbol || 'TICKER'}</span>
          <span className="pl-launch-preview-badges">
            <Badge tone="neutral">{kind === 'b20' ? 'B20' : 'ERC-20'}</Badge>
            {pair && <Badge tone="neutral">{pair.symbol} pair</Badge>}
            <Badge tone="accent">Launched on Place</Badge>
          </span>
        </div>
      </div>
      <dl className="pl-place-kv pl-launch-preview-kv">
        <div>
          <dt>Start price</dt>
          <dd className="mono">{startUsd != null ? usd(startUsd) : startPrice != null ? `${smallNumber(startPrice)} ${pair.symbol}` : '—'}</dd>
        </div>
        <div>
          <dt>Start market cap</dt>
          <dd className="mono">{pair?.startFdvUsd != null ? usd(pair.startFdvUsd) : pair ? `${smallNumber(pair.startFdv)} ${pair.symbol}` : '—'}</dd>
        </div>
        <div>
          <dt>Supply</dt>
          <dd className="mono">1,000,000,000</dd>
        </div>
        <div>
          <dt>Liquidity</dt>
          <dd>All supply, locked for good</dd>
        </div>
        <div>
          <dt>Launch fee</dt>
          <dd className="mono">{formatAmount(fee, 18)} ETH</dd>
        </div>
        {devAmount && (
          <div>
            <dt>Dev buy</dt>
            <dd className="mono">
              {devAmount} {pair?.symbol} → ~{compact(devTokens)} {symbol || ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Your fee</dt>
          <dd>
            {CREATOR_FEE_PCT_TEXT}% of each trade
            <span className="pl-launch-muted">
              {' '}
              ({burn ? `${burn}% burned` : 'no burn'}, {fund ? `${fund}% community fund` : 'no fund'})
            </span>
          </dd>
        </div>
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
      <p className="pl-place-hint">The first 20 seconds after launch a high anti-snipe fee protects your launch from bots; it falls to 1%.</p>
    </Card>
  );
}
