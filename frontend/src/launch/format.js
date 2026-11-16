// Formatting for Place Launch pages (docs/DESIGN.md §11): compact USD, tiny prices with a subscript zero
// count ($0.0₅551), compact token amounts, percent changes and ages. Pure functions, tested in
// tests/launchClient.test.js.

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).split('').map((d) => SUBSCRIPT[Number(d)]).join('');

/** 1234 → "1.23K", 2530000 → "2.53M"; below 1000 up to `decimals` places. */
export function compact(n, { decimals = 2 } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const a = Math.abs(v);
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) if (a >= size) return `${(v / size).toFixed(2).replace(/\.?0+$/, '')}${suffix}`;
  if (a === 0) return '0';
  if (a < 1) return smallNumber(v);
  return v.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * A small number with its leading zeros counted: 0.00000551322 → "0.0₅5513" (4 significant digits).
 * Numbers with at most 3 leading zeros are written out: 0.00123 → "0.00123".
 */
export function smallNumber(n, { digits = 4 } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v === 0) return '0';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1) return sign + a.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : 4 });
  const zeros = Math.floor(-Math.log10(a)) - (Number.isInteger(Math.log10(a)) ? 1 : 0);
  const significant = Math.round(a * 10 ** (zeros + digits)).toString().replace(/0+$/, '') || '0';
  if (zeros <= 3) return `${sign}0.${'0'.repeat(zeros)}${significant}`;
  return `${sign}0.0${sub(zeros)}${significant}`;
}

/** "$55.13K", "$2.53M", "$0.12", "$0.0₅551"; "—" without a value. */
export function usd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v !== 0 && Math.abs(v) < 0.01) return `$${smallNumber(v)}`;
  if (Math.abs(v) < 1000) return `$${v.toFixed(2)}`;
  return `$${compact(v)}`;
}

/** A price in its pair: "0.0₅1945 ETH". */
export function price(n, symbol) {
  if (n == null) return '—';
  return `${smallNumber(n)}${symbol ? ` ${symbol}` : ''}`;
}

/** An amount in whole units with its symbol: "11.65K BPK", "0.0025 ETH". */
export function amount(n, symbol) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${compact(n, { decimals: 4 })}${symbol ? ` ${symbol}` : ''}`;
}

/** "+12.4%", "-3.1%", "0%"; null → "—". */
export function pct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const text = Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(Math.abs(v) >= 10 ? 1 : 2).replace(/\.?0+$/, '');
  return `${v > 0 ? '+' : ''}${text}%`;
}

/** "12s", "5m", "3h", "2d", "3mo", "1y" since `date`. */
export function age(date, now = Date.now()) {
  if (!date) return '—';
  const s = Math.max(0, Math.floor((now - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 365 * 86400) return `${Math.floor(s / (30 * 86400))}mo`;
  return `${Math.floor(s / (365 * 86400))}y`;
}

/** Basis points → "25%", "7.5%". */
export const bpsText = (bps) => `${(Number(bps || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/** A token is "new" for its first 24 hours. */
export const isNew = (createdAt, now = Date.now()) => Boolean(createdAt) && now - new Date(createdAt).getTime() < 86_400_000;
