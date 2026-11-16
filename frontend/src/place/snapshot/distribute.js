// Turns balances at the snapshot block into allocations, in exact integer math.
// All amounts are bigint in the smallest unit (wei of the reward token; balances in the target's units,
// NFT counts for collections).

/**
 * Wallets that qualify: balance >= minBalance (and > 0), not excluded. Sorted by balance (largest first),
 * then by address, so the result never depends on input order.
 * @param {{account: string, balance: bigint}[]} balances
 * @param {{minBalance: bigint, exclude?: Iterable<string>}} opts
 */
export function selectEligible(balances, { minBalance, exclude = [] }) {
  const skip = new Set([...exclude].map((a) => a.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const { account, balance } of balances) {
    const a = account.toLowerCase();
    if (seen.has(a)) throw new Error(`Duplicate account ${a}`);
    seen.add(a);
    if (skip.has(a) || balance <= 0n || balance < minBalance) continue;
    out.push({ account: a, balance });
  }
  return out.sort(byBalance);
}

function byBalance(x, y) {
  if (x.balance !== y.balance) return x.balance > y.balance ? -1 : 1;
  return x.account < y.account ? -1 : x.account > y.account ? 1 : 0;
}

/**
 * Splits `pool` among eligible wallets.
 * - proportional: by balance; a wallet whose share reaches `maxPerWallet` gets exactly the cap, and what the
 *   cap cuts off is shared again among the rest, until nobody is over the cap.
 * - equal: the same amount per wallet, up to the cap.
 * Rounding dust goes one unit at a time to the largest holders still under the cap, so the whole pool is
 * handed out unless every wallet sits at the cap (then the rest stays unallocated and goes back or is
 * burned by the campaign's leftover rule).
 * Wallets that end up with 0 are left out.
 * @returns {{rows: {account: string, balance: bigint, amount: bigint, capped: boolean}[], totalAllocated: bigint}}
 */
export function allocate(eligible, { pool, distribution, maxPerWallet = null }) {
  if (pool <= 0n) throw new Error('Pool must be positive');
  if (maxPerWallet !== null && maxPerWallet <= 0n) throw new Error('maxPerWallet must be positive');
  const holders = [...eligible].sort(byBalance);
  const amounts = new Map();
  const capped = new Set();
  const cap = maxPerWallet;

  if (distribution === 'equal') {
    const n = BigInt(holders.length);
    if (n > 0n) {
      let each = pool / n;
      if (cap !== null && each >= cap) {
        each = cap;
        holders.forEach((h) => capped.add(h.account));
      }
      holders.forEach((h) => amounts.set(h.account, each));
      let dust = pool - each * n;
      if (!capped.size) {
        for (const h of holders) {
          if (dust === 0n) break;
          amounts.set(h.account, each + 1n);
          dust -= 1n;
        }
      }
    }
  } else if (distribution === 'proportional') {
    let left = pool;
    let rest = holders;
    while (rest.length) {
      const total = rest.reduce((s, h) => s + h.balance, 0n);
      const over = cap === null ? [] : rest.filter((h) => left * h.balance >= cap * total);
      if (over.length) {
        for (const h of over) {
          amounts.set(h.account, cap);
          capped.add(h.account);
        }
        left -= cap * BigInt(over.length);
        rest = rest.filter((h) => !capped.has(h.account));
        continue;
      }
      let given = 0n;
      for (const h of rest) {
        const share = (left * h.balance) / total;
        amounts.set(h.account, share);
        given += share;
      }
      // Each floor loses less than one unit, so dust < rest.length and every share is strictly under the
      // cap here: adding one unit never breaks the cap.
      let dust = left - given;
      for (const h of rest) {
        if (dust === 0n) break;
        amounts.set(h.account, amounts.get(h.account) + 1n);
        dust -= 1n;
      }
      break;
    }
  } else {
    throw new Error(`Unknown distribution ${distribution}`);
  }

  const rows = [];
  let totalAllocated = 0n;
  for (const h of holders) {
    const amount = amounts.get(h.account) ?? 0n;
    if (amount === 0n) continue;
    rows.push({ account: h.account, balance: h.balance, amount, capped: capped.has(h.account) });
    totalAllocated += amount;
  }
  if (totalAllocated > pool) throw new Error('Allocation exceeds the pool'); // cannot happen; guards the math
  if (cap !== null && rows.some((r) => r.amount > cap)) throw new Error('Allocation exceeds the cap');
  return { rows, totalAllocated };
}
