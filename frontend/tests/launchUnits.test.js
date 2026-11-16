// Place Launch pure functions: market math, address prediction (vectors from the L2 run on Base Sepolia),
// and the creator-vault campaign template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFromSqrt, swapSide, fillCandles, change } from '../src/launch/market.js';
import { predictLaunch, scopedSalt, b20Address, mineSalt, requiredEnding } from '../src/launch/vanity.js';
import { launchCampaignRules } from '../src/launch/rules.js';
import { validateRules } from '../src/place/snapshot/rules.js';
import { D, B20, ERC, CREATOR, ETH, USDC, SQRT, TEMPLATE } from './launchFixture.js';


test('price from sqrtPriceX96 in both currency orders matches the ~$4k FDV start', () => {
  // B20/ETH: ETH is currency0, the token currency1
  const b20 = priceFromSqrt(SQRT.b20Init, false, 18);
  assert.ok(Math.abs(b20 - 1.9457e-9) / 1.9457e-9 < 0.01, `b20 ${b20}`);
  // ERC-20/USDC (6 decimals): USDC is currency0
  const erc = priceFromSqrt(SQRT.ercInit, false, 6);
  assert.ok(Math.abs(erc * 1e9 - 4009) < 5, `fdv ${erc * 1e9}`);
  // the same pool seen with the token as currency0 is the inverse
  const inv = priceFromSqrt(SQRT.b20Init, true, 18);
  assert.ok(Math.abs(inv * b20 - 1) < 1e-9);
});

test('swap side and reserves come from the swapper-side signs', () => {
  const buy = swapSide({ amount0: -990n, amount1: 5000n }, false);
  assert.deepEqual(buy, { side: 'buy', tokenAmount: 5000n, quoteAmount: 990n, quoteIn: 990n, tokenOut: 5000n });
  const sell = swapSide({ amount0: 98n, amount1: -2500n }, false);
  assert.deepEqual(sell, { side: 'sell', tokenAmount: 2500n, quoteAmount: 98n, quoteIn: -98n, tokenOut: -2500n });
  const token0 = swapSide({ amount0: 7n, amount1: -3n }, true);
  assert.equal(token0.side, 'buy');
});

test('candles fill gaps flat and start from the previous close', () => {
  const c = fillCandles([{ t: 120, o: 2, h: 3, l: 2, c: 3, v: 1, trades: 1 }], { interval: 60, from: 0, to: 240, prevClose: 1 });
  assert.deepEqual(c.map((x) => [x.t, x.o, x.c, x.trades]), [[0, 1, 1, 0], [60, 1, 1, 0], [120, 2, 3, 1], [180, 3, 3, 0], [240, 3, 3, 0]]);
  assert.deepEqual(fillCandles([], { interval: 60, from: 0, to: 120 }), [], 'no price yet: no candles');
  assert.equal(change(2, 3), 50);
  assert.equal(change(null, 3), null);
});

test('predicted addresses match the L2 launches (B20 precompile, ERC-20 CREATE2, vault clone)', () => {
  const base = { creator: CREATOR, factory: D.factory, tokenDeployer: D.tokenDeployer, vaultImplementation: D.creatorVaultImplementation };
  const b = predictLaunch({ ...base, kind: 'b20', creatorSalt: '0xe5c31a525f0c60f850f75938c67def612cf79a273e83ea7156a79de41ce0e267' });
  assert.equal(b.token, B20.token);
  assert.equal(b.vault, B20.vault);
  const e = predictLaunch({
    ...base,
    kind: 'erc20',
    creatorSalt: '0x2a16c1cc677ea4f21320dda95df13575fe086336114f7e630fc14ad9de631715',
    initCodeHash: '0x7af2866ae608944688adaf9a1a342e4a84a5a731f899a658e58b612a54f5e87b',
  });
  assert.equal(e.token, ERC.token);
  assert.equal(e.vault, ERC.vault);
  // getB20Address(0, factory, keccak256(0x1234)) as the precompile answered it
  assert.equal(b20Address(D.factory, '0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432'), '0xb200000000000000000000ee9d7462a19be18f54');
  assert.equal(scopedSalt(CREATOR, `0x${'0'.repeat(64)}`).length, 66);
});

test('salt mining finds the required ending', () => {
  assert.equal(requiredEnding(''), '01');
  assert.equal(requiredEnding('0xBE'), 'be01');
  assert.equal(requiredEnding('e01'), 'e01');
  assert.throws(() => requiredEnding('xyz'), /hex/);
  const hit = mineSalt({ kind: 'b20', creator: CREATOR, factory: D.factory, tokenDeployer: D.tokenDeployer, vaultImplementation: D.creatorVaultImplementation, ending: 'a01' });
  assert.ok(hit.token.endsWith('a01'));
  assert.equal(predictLaunch({ kind: 'b20', creator: CREATOR, creatorSalt: hit.creatorSalt, factory: D.factory, tokenDeployer: D.tokenDeployer, vaultImplementation: D.creatorVaultImplementation }).token, hit.token);
  assert.equal(mineSalt({ kind: 'b20', creator: CREATOR, factory: D.factory, tokenDeployer: D.tokenDeployer, vaultImplementation: D.creatorVaultImplementation, ending: 'ffffff01', maxTries: 10 }), null);
});

const campaign = (over = {}) => ({
  creator: B20.vault,
  kind: 0,
  target: B20.token,
  rewardToken: ETH,
  pool: 165350700000000n,
  snapshotAt: 1_794_665_333n,
  claimDuration: 2_592_000,
  burnLeftover: true,
  rulesHash: D.launchRules[0].rulesHash,
  ...over,
});
const vault = { address: B20.vault, token: B20.token, quote: ETH };

test('vault campaign template → place.rules/1 with the launch pool excluded', () => {
  const rules = launchCampaignRules(TEMPLATE, { campaign: campaign(), hub: D.hub, chainId: 84532, d: D, vault, createdAt: 1_794_665_333 - 86400 });
  validateRules(rules);
  assert.equal(rules.target, B20.token);
  assert.equal(rules.rewardToken, 'eth');
  assert.equal(rules.pool, '165350700000000');
  assert.equal(rules.leftover, 'burn');
  assert.deepEqual(rules.exclude, [DEADLESS(), D.poolManager, B20.vault, D.feeEscrow, D.hook].sort());
  const usdc = launchCampaignRules(TEMPLATE, { campaign: campaign({ creator: ERC.vault, target: ERC.token, rewardToken: USDC }), hub: D.hub, chainId: 84532, d: D, vault: { address: ERC.vault, token: ERC.token, quote: USDC } });
  assert.equal(usdc.rewardToken, USDC);
});

function DEADLESS() {
  return '0x000000000000000000000000000000000000dead';
}

test('vault campaign template: every mismatch is a rejection', () => {
  const p = { hub: D.hub, chainId: 84532, d: D, vault };
  assert.throws(() => launchCampaignRules(TEMPLATE + ' ', { ...p, campaign: campaign() }), /does not match the on-chain rulesHash/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ claimDuration: 86400 }) }), /claimDuration/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ burnLeftover: false }) }), /leftover/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ target: ERC.token }) }), /target/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ rewardToken: USDC }) }), /rewardToken/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ creator: CREATOR }) }), /creator/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign(), createdAt: 1 }), /snapshotAt/);
  assert.throws(() => launchCampaignRules(TEMPLATE, { ...p, campaign: campaign({ rulesHash: `0x${'0'.repeat(64)}` }) }), /rulesHash/);
});
