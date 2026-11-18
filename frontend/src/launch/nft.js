// NFT launchpad on the site: the Launch NFT form's checks and the createCollection parameters, the mint economy
// (platform 20%, then creator / NFT holders / buyback & burn), the 30-day holders pool in plain numbers, and the
// metadata of a Unique collection. Pure functions, shared by the form, the collection page and the tests.
import { isAddress, parseEther } from 'viem';

export const ETH = '0x0000000000000000000000000000000000000000';
export const NFT_PLATFORM_PCT = 20;
export const MAX_ROYALTY_PCT = 10;
export const POOL_DAYS = 30;
/** Files the site uploads for one Unique collection; larger collections point to a metadata folder of their own. */
export const MAX_UPLOAD_FILES = 1000;
/** Decoded bytes per folder upload (the request carries them as base64, under the 4.5 MB serverless limit). */
export const UPLOAD_BATCH_BYTES = 2_800_000;
export const KIND_ID = { unique: 0, edition: 1 };

/** The three buckets of what is left after the platform, in the order the form and the charts show them. */
export const NFT_BUCKETS = [
  { id: 'creator', label: 'Creator', short: 'Creator', tone: 'creator', desc: 'Paid to the collection owner' },
  { id: 'holders', label: 'NFT holders', short: 'Holders', tone: 'holders', desc: 'Goes into the 30-day holders pool, paid out every day to every NFT' },
  { id: 'burn', label: 'Buyback & burn', short: 'Burn', tone: 'burn', desc: 'Buys the pair token in the same transaction and burns it' },
];
export const DEFAULT_NFT_ECONOMY = { creator: 60, holders: 30, burn: 10 };
export const nftEconomyTotal = (e) => NFT_BUCKETS.reduce((s, b) => s + (Number(e[b.id]) || 0), 0);

/** Percent → basis points. */
const bps = (pct) => Math.round(Number(pct) * 100);

/** What one payment of `amount` (bigint, any asset) pays each side, exactly as the collection splits it. */
export function mintSplit(amount, economy) {
  const a = BigInt(amount || 0);
  const platform = (a * BigInt(NFT_PLATFORM_PCT * 100)) / 10_000n;
  const rest = a - platform;
  const holders = (rest * BigInt(bps(economy.holders))) / 10_000n;
  const burn = (rest * BigInt(bps(economy.burn))) / 10_000n;
  return { platform, creator: rest - holders - burn, holders, burn };
}

/** Each bucket in % of a whole payment (the platform's 20% included): { platform, creator, holders, burn }. */
export function paymentPct(economy) {
  const rest = 100 - NFT_PLATFORM_PCT;
  return { platform: NFT_PLATFORM_PCT, creator: (rest * economy.creator) / 100, holders: (rest * economy.holders) / 100, burn: (rest * economy.burn) / 100 };
}

/** The economy of an API collection ({ creatorBps, holdersBps, burnBps }) in percent. */
export const economyPct = (e) => ({ creator: (e?.creatorBps ?? 10_000) / 100, holders: (e?.holdersBps ?? 0) / 100, burn: (e?.burnBps ?? 0) / 100 });

/** Unix seconds from a datetime-local value read as UTC ('' → 0). */
export function utcSeconds(value) {
  if (!value) return 0;
  const t = Date.parse(String(value).length === 16 ? `${value}:00Z` : `${value}Z`);
  return Number.isNaN(t) ? NaN : Math.floor(t / 1000);
}

const intOf = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN);

/**
 * Checks the Launch NFT form and builds PlaceNftCollection.InitParams. `f`: the form's strings and choices
 * ({ name, symbol, kind, supply, maxPerWallet, mintStart, mintEnd, price, tokenPayments, royalty, economy, baseURI,
 * uriSuffix, contractURI, files }); `pair`: the picked pair option ({ address, launchPool }); `rewardToken`: 'eth' or
 * an address. Returns { errors, params } (params null while anything is wrong).
 */
export function planNftCollection(f, { pair, rewardToken, now = Math.floor(Date.now() / 1000) } = {}) {
  const errors = {};
  const name = String(f.name || '').trim();
  const symbol = String(f.symbol || '').trim();
  if (!name) errors.name = 'Enter a name';
  else if (name.length > 64) errors.name = 'At most 64 characters';
  if (!symbol) errors.symbol = 'Enter a symbol';
  else if (!/^[A-Za-z0-9]{1,10}$/.test(symbol)) errors.symbol = 'Up to 10 letters or digits';
  const unique = f.kind === 'unique';
  const supply = String(f.supply ?? '').trim() === '' ? 0 : intOf(f.supply);
  if (unique && !(supply >= 1 && supply <= 100_000)) errors.supply = 'Between 1 and 100,000';
  else if (!unique && !(supply >= 0 && supply <= 1_000_000)) errors.supply = 'Up to 1,000,000, or empty for an open edition';
  if (unique && f.files && f.files.length && f.files.length !== supply) errors.files = `Pick exactly ${supply || 'supply'} files: one per NFT (now ${f.files.length})`;
  const perWallet = String(f.maxPerWallet ?? '').trim() === '' ? 0 : intOf(f.maxPerWallet);
  if (!(perWallet >= 0 && perWallet <= 4_294_967_295)) errors.maxPerWallet = 'A whole number, or empty for no limit';
  const start = utcSeconds(f.mintStart);
  const end = utcSeconds(f.mintEnd);
  if (Number.isNaN(start)) errors.mintStart = 'Not a date';
  if (Number.isNaN(end)) errors.mintEnd = 'Not a date';
  else if (end && end <= Math.max(start || 0, now)) errors.mintEnd = 'The mint must end after it opens';
  let price = 0n;
  try {
    price = String(f.price ?? '').trim() === '' ? 0n : parseEther(String(f.price).trim());
  } catch {
    errors.price = 'Enter a price in ETH';
  }
  if (price < 0n) errors.price = 'Enter a price in ETH';
  const royalty = Number(f.royalty);
  if (!(royalty >= 0 && royalty <= MAX_ROYALTY_PCT)) errors.royalty = `Between 0% and ${MAX_ROYALTY_PCT}%`;
  const e = f.economy || DEFAULT_NFT_ECONOMY;
  if (nftEconomyTotal(e) !== 100) errors.economy = 'Creator, NFT holders and burn must add up to 100%';
  const token = pair?.address && pair.address !== 'eth' ? pair.address : null;
  if (!token) errors.pair = 'Choose the pair token';
  else if (!isAddress(token)) errors.pair = 'Not a token address';
  const reward = !rewardToken || rewardToken === 'eth' ? ETH : rewardToken;
  if (!f.baseURI) errors.media = unique ? 'Upload the NFT files or give the metadata folder' : 'Upload the image or give a link';
  else if (unique && !/^(ipfs|https):\/\/\S+\/$/.test(f.baseURI)) errors.media = 'The metadata folder link must end with /';
  if (Object.keys(errors).length) return { errors, params: null };
  return {
    errors,
    params: {
      name,
      symbol: symbol.toUpperCase(),
      kind: KIND_ID[unique ? 'unique' : 'edition'],
      baseURI: f.baseURI,
      uriSuffix: unique ? f.uriSuffix ?? '.json' : '',
      contractURI: f.contractURI || '',
      maxSupply: supply,
      maxPerWallet: perWallet,
      mintStart: BigInt(start || 0),
      mintEnd: BigInt(end || 0),
      mintPrice: price,
      token,
      tokenPayments: Boolean(f.tokenPayments) && price > 0n,
      rewardToken: reward,
      royaltyBps: bps(royalty),
      economy: { creatorBps: 10_000 - bps(e.holders) - bps(e.burn), holdersBps: bps(e.holders), burnBps: bps(e.burn) },
      launchPool: pair?.launchPool || { currency0: ETH, currency1: ETH, fee: 0, tickSpacing: 0, hooks: ETH },
    },
  };
}

/** Sorts picked files by name the way people number them: 2.png before 10.png. */
export const byFileName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true, sensitivity: 'base' });

/** Groups files (each with `size`) into upload batches of at most `maxBytes` and `maxFiles`. */
export function batches(files, maxBytes = UPLOAD_BATCH_BYTES, maxFiles = 200) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const f of files) {
    if (cur.length && (size + f.size > maxBytes || cur.length >= maxFiles)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += f.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The metadata JSON of NFT `id` of a Unique collection. */
export const uniqueMetadata = ({ name, description, image, id }) => ({
  name: `${name} #${id}`,
  description: description || null,
  image,
  attributes: [{ trait_type: 'Number', value: String(id) }],
});

/** What a holders pool pays, from the API's pool fields: per day, per NFT per day, left, end date. */
export function poolNumbers(pool, decimals = 18) {
  const unit = 10 ** Number(decimals);
  const n = (v) => Number(BigInt(v || 0)) / unit;
  return {
    active: Boolean(pool?.active),
    perDay: n(pool?.perDay),
    perNftPerDay: n(pool?.perNftPerDay),
    accruedToday: n(pool?.accruedToday),
    left: n(pool?.left),
    funded: n(pool?.funded),
    claimed: n(pool?.claimed),
    daysLeft: pool?.daysLeft ?? 0,
    endsAt: pool?.endsAt ? new Date(pool.endsAt) : null,
    nextAt: pool?.nextAccrualAt ? new Date(pool.nextAccrualAt) : null,
  };
}

/** Status of a collection's mint, with the label and tone the pages show. */
export const MINT_STATUS = {
  live: { label: 'Minting', tone: 'success' },
  upcoming: { label: 'Upcoming', tone: 'accent' },
  'sold-out': { label: 'Sold out', tone: 'neutral' },
  ended: { label: 'Ended', tone: 'danger' },
};

export const collectionPath = (address) => `/collection/${address}`;
