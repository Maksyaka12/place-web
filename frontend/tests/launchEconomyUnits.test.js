// The site side of the launch economics (src/launch/economy.js): the 0.3.0 tax split of the form and
// tokenEconomy, the one shape the token page and the profile read for 0.2.0 and 0.3.0 tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenEconomy, taxSplit, allocationTotal, pctToBps, tradePct, DEFAULT_ALLOCATION } from '../src/launch/economy.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('0.3.0: Place takes 30% of each tax, the buckets split the rest', () => {
  const t = taxSplit(1, DEFAULT_ALLOCATION);
  assert.ok(near(t.protocol, 0.3) && near(t.rest, 0.7));
  assert.ok(near(t.creator, 0.28));
  assert.equal(allocationTotal(DEFAULT_ALLOCATION), 100);
  assert.ok(near(taxSplit(5, DEFAULT_ALLOCATION).protocol, 1.5));
  assert.equal(pctToBps(2.5), 250);
  assert.equal(tradePct(0.175), '0.175%');
});

test('tokenEconomy: 0.1.0 has none, 0.2.0 is 1% with burn and fund buckets', () => {
  assert.equal(tokenEconomy({ generation: 1, economics: { generation: 1, buybackBps: 2000 } }), null);
  assert.equal(tokenEconomy({}), null);
  const e = tokenEconomy({ generation: 2, economics: { generation: 2, burnBps: 2500, communityBps: 2500, creatorBps: 5000, xShares: [{ bps: 1000 }] } });
  assert.equal(e.type, 'standard');
  assert.deepEqual(e.shares, { creator: 50, holders: 0, traders: 0, burn: 25, community: 25 });
  assert.equal(e.xPct, 10);
  assert.ok(near(e.perTrade.buy.protocol, 0.3) && near(e.perTrade.buy.burn, 0.175) && near(e.perTrade.sell.creator, 0.35));
});

test('tokenEconomy: 0.3.0 Standard is 1% to the creator, Economy keeps the API split', () => {
  const s = tokenEconomy({ generation: 3, economics: { generation: 3, launchType: 'standard', buyTax: 1, sellTax: 1, shares: {} } });
  assert.equal(s.type, 'standard');
  assert.equal(s.shares.creator, 100);
  assert.ok(near(s.perTrade.sell.creator, 0.7));
  const api = { protocol: 0.9, creator: 0.63, holders: 0.63, traders: 0.42, burn: 0.21, community: 0.21, total: 3 };
  const e = tokenEconomy({
    generation: 3,
    economics: {
      generation: 3,
      launchType: 'economy',
      buyTax: 3,
      sellTax: 5,
      shares: { creator: 30, holders: 30, traders: 20, burn: 10, community: 10 },
      perTrade: { buy: api, sell: null },
      minHolding: '25000000000000000000000',
      rewardToken: 'eth',
      antiSnipe: false,
    },
  });
  assert.equal(e.type, 'economy');
  assert.equal(e.perTrade.buy.holders, 0.63);
  assert.ok(near(e.perTrade.buy.rest, 2.1));
  assert.ok(near(e.perTrade.sell.protocol, 1.5) && near(e.perTrade.sell.traders, 0.7)); // computed when the API has none
  assert.equal(e.antiSnipe, false);
  assert.equal(e.minHolding, '25000000000000000000000');
});
