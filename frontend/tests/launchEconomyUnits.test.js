// The site side of the 0.2.0 economy (src/launch/economy.js): templates, nested sliders, the $100 sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_TEMPLATES, templateOf, basketsFromNested, nestedFromBaskets, toBps, feeFlow, flowSentence, tokenShares } from '../src/launch/economy.js';

test('70/30: from every $100 of volume, $0.30 to Place and $0.70 split into the baskets', () => {
  const f = feeFlow({ burn: 25, fund: 25 });
  assert.equal(f.fee, 1);
  assert.ok(Math.abs(f.platform - 0.3) < 1e-12);
  assert.ok(Math.abs(f.burn - 0.175) < 1e-12 && Math.abs(f.fund - 0.175) < 1e-12 && Math.abs(f.creator - 0.35) < 1e-12);
  assert.equal(flowSentence(f), 'From every $100 of volume: $0.30 to Place, $0.35 to you, $0.175 is burned, $0.175 goes to the community');
  const x = feeFlow({ burn: 0, fund: 0, xPct: 50 });
  assert.ok(Math.abs(x.x - 0.35) < 1e-12 && Math.abs(x.creator - 0.35) < 1e-12);
});

test('nested sliders round-trip to the three baskets and to bps', () => {
  assert.deepEqual(basketsFromNested(50, 50), { burn: 25, fund: 25 });
  assert.deepEqual(basketsFromNested(60, 0), { burn: 0, fund: 60 });
  assert.deepEqual(nestedFromBaskets(25, 25), { giveBack: 50, burnOfGiveBack: 50 });
  assert.equal(Math.round(nestedFromBaskets(50, 10).burnOfGiveBack), 83);
  for (const t of ECONOMY_TEMPLATES) {
    const n = nestedFromBaskets(t.burn, t.fund);
    assert.deepEqual(basketsFromNested(n.giveBack, n.burnOfGiveBack), { burn: t.burn, fund: t.fund });
    assert.equal(templateOf(t.burn, t.fund).id, t.id);
    assert.ok(toBps(t.burn) + toBps(t.fund) <= 10_000);
  }
  assert.equal(toBps(12.5), 1250);
  assert.equal(templateOf(5, 5), null);
});

test('token shares: 0.2.0 economics in percent, legacy tokens none', () => {
  assert.deepEqual(tokenShares({ legacy: false, burnBps: 2500, communityBps: 5000, creatorBps: 2500 }), { burn: 25, fund: 50, creator: 25 });
  assert.equal(tokenShares({ legacy: true, buybackBps: 2000 }), null);
});
