// Profile → Fees as one list: creator revenue of every token this wallet launched, combined by payout asset (the
// pair asset of each token). One row per asset: its logo, ticker and where it comes from ("Legacy fees" for
// tokens before 0.3.0, which claim apart), "Available" with the amount and its USD value, and Claim (one claim
// transaction per token vault, sent one after another). Claim all on top sends every claim of the filtered list.
import { useMemo } from 'react';
import { TokenLogo } from './parts.jsx';
import { TxButton, TxResult } from '../../themes/place/pages/place/parts';
import { usePlaceTx } from '../../place/hooks';
import { formatAmount } from '../../place/format';
import { pairIcon, pairCategory } from '../pairs.js';
import { usd } from '../format.js';

export const FEE_FILTERS = [
  ['all', 'All'],
  ['crypto', 'Crypto'],
  ['stocks', 'Stocks'],
];

const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

/**
 * Creator `tokens` (launch/creator) → rows by payout asset: { key, quote, legacy, total, usd, category, tokens, txs }.
 * Only vaults this wallet controls with something to claim and a ready claim transaction count.
 */
export function feeRows(tokens = []) {
  const rows = new Map();
  for (const item of tokens) {
    const v = item.vault;
    const c = v?.claim;
    if (!v || v.error || !c || c.error || !c.tx) continue;
    const paid = big(c.paid);
    if (paid === 0n) continue;
    const q = item.token.quote;
    const legacy = v.version !== 'v3';
    const key = `${q.address}:${legacy ? 'legacy' : 'current'}`;
    const row = rows.get(key) || { key, quote: q, legacy, total: 0n, category: q.category || pairCategory(q.symbol), tokens: [], txs: [] };
    row.total += paid;
    row.tokens.push(item.token);
    row.txs.push({ label: `Claim ${item.token.symbol} fees`, to: c.tx.to, data: c.tx.data, value: 0n });
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => {
      const units = Number(formatAmount(r.total, r.quote.decimals, { maxDecimals: 8 }).replace(/,/g, ''));
      return { ...r, usd: r.quote.usd == null ? null : units * r.quote.usd };
    })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || Number(a.legacy) - Number(b.legacy));
}

function FeeRow({ row }) {
  const tx = usePlaceTx();
  const q = row.quote;
  const from = row.tokens.map((t) => t.symbol).join(', ');
  return (
    <div className="pl-launch-reward-row pl-fee-row">
      <span className="pl-launch-reward-token">
        <TokenLogo token={{ symbol: q.symbol }} src={pairIcon(q) || undefined} size={36} shape="round" />
        <span className="pl-launch-launch-title">
          <span className="pl-launch-strong">{q.symbol}</span>
          <span className="pl-launch-muted pl-launch-small" title={`From ${from}`}>
            {row.legacy ? 'Legacy fees' : `From ${from}`}
          </span>
        </span>
      </span>
      <span className="pl-launch-reward-amounts">
        <span className="pl-launch-muted pl-launch-small">Available</span>
        <span className="mono pl-launch-strong">
          {formatAmount(row.total, q.decimals, { maxDecimals: 6 })} {q.symbol}
        </span>
        {row.usd != null && <span className="pl-launch-muted pl-launch-small mono">Approx. {usd(row.usd)}</span>}
      </span>
      <TxButton tx={tx} size="sm" busyLabel="Claiming..." onClick={() => tx.send(row.txs)}>
        Claim
      </TxButton>
      {tx.status !== 'idle' && (
        <div className="pl-launch-reward-result">
          <TxResult tx={tx} success="Fees claimed" />
        </div>
      )}
    </div>
  );
}

/** The fee list and its Claim all button (rendered by the caller in the section head). */
export function useFeeList(tokens, filter) {
  const all = useMemo(() => feeRows(tokens), [tokens]);
  const rows = filter === 'all' ? all : all.filter((r) => r.category === filter);
  return { all, rows, txs: rows.flatMap((r) => r.txs) };
}

export function FeeList({ rows }) {
  return (
    <div className="pl-launch-reward-list pl-fee-list">
      {rows.map((r) => (
        <FeeRow key={r.key} row={r} />
      ))}
    </div>
  );
}
