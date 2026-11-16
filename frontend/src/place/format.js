// Formatting for the Place portal (docs/DESIGN.md §11): amounts with commas, short addresses, UTC dates,
// countdowns. Pure functions, shared by every page and tested in tests/placeClient.test.js.
import { formatUnits, parseUnits } from 'viem';

export const shortAddress = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');

/** Raw integer amount (string or bigint) → "1,234.56": `maxDecimals` places (3 significant digits below 1), trailing zeros cut. */
export function formatAmount(raw, decimals = 18, { maxDecimals = 4, compact = false } = {}) {
  if (raw == null || raw === '') return '—';
  const value = BigInt(raw);
  const text = formatUnits(value < 0n ? -value : value, Number(decimals ?? 18));
  const [int, frac = ''] = text.split('.');
  if (compact && int.length > 6) {
    const n = Number(int);
    const units = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
    ];
    for (const [size, suffix] of units) if (n >= size) return `${value < 0n ? '-' : ''}${(n / size).toFixed(2)}${suffix}`;
  }
  // Below 1, keep the first significant digits so small rewards (0.00002 ETH) stay readable.
  const places = int === '0' ? Math.max(maxDecimals, (frac.match(/^0*/)[0].length || 0) + 3) : maxDecimals;
  const cut = frac.slice(0, places).replace(/0+$/, '');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0n ? '-' : ''}${grouped}${cut ? `.${cut}` : ''}`;
}

/** "1,000 USDC" from an API amount and its token meta ({symbol, decimals}). */
export function formatToken(raw, meta, opts) {
  const symbol = meta?.symbol || 'tokens';
  return `${formatAmount(raw, meta?.decimals ?? 18, opts)} ${symbol}`;
}

/** Decimal text from a form ("1,000.5") → raw bigint, or null when it is not a valid positive amount. */
export function parseAmount(text, decimals = 18) {
  const clean = String(text ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [, frac = ''] = clean.split('.');
  if (frac.length > decimals) return null;
  try {
    return parseUnits(clean, Number(decimals));
  } catch (e) {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "25 Oct 2026, 00:00 UTC" (the year only when it is not this year). */
export function formatUtc(date, { now = new Date() } = {}) {
  if (date == null) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const year = d.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "19d 01h 04m 01s" until `date`; "0s" once it has passed. */
export function countdown(date, now = Date.now()) {
  let s = Math.max(0, Math.floor((new Date(date).getTime() - now) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  if (h) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

/** ipfs://cid[/path] → https URL on a public gateway (`gateway` picks one of them). */
export function ipfsUrl(uri, gateway = 0) {
  if (!uri) return null;
  const m = String(uri).match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/);
  if (!m) return /^https?:\/\//.test(uri) ? uri : null;
  return `${GATEWAYS[gateway % GATEWAYS.length]}${m[1]}`;
}
export const IPFS_GATEWAY_COUNT = GATEWAYS.length;

/** Name of a token for headings: symbol, then name, then the short address. */
/** "1 day", "7 days" from seconds. */
export const days = (seconds) => {
  const n = Math.round(Number(seconds) / 86400);
  return `${n} day${n === 1 ? '' : 's'}`;
};

export const assetLabel = (meta, address) => meta?.symbol || meta?.name || shortAddress(address);

export const STATUS_LABEL = {
  scheduled: 'Upcoming',
  snapshotting: 'Snapshotting',
  refundable: 'Refundable',
  live: 'Live',
  ended: 'Ended',
  closed: 'Closed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/** StatusPill tone for a campaign status (DESIGN.md §7). */
export const STATUS_TONE = {
  scheduled: 'neutral',
  snapshotting: 'accent',
  refundable: 'warn',
  live: 'success',
  ended: 'danger',
  closed: 'neutral',
  cancelled: 'neutral',
  refunded: 'neutral',
};
