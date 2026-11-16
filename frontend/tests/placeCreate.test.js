// The Create form logic (src/place/create.js): what the form sends must pass every check PlaceHub,
// NftFactory and ClubNFT make, and the rules must be exactly what the snapshot service expects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, zeroAddress } from 'viem';
import { planCampaign, planCollection, campaignFee, parseUtcInput, toUtcInput, parseAddressList, cappedLeftover, SWAP_ROUTER } from '../src/place/create.js';
import { encodeRules, validateRules } from '../src/place/snapshot/rules.js';
import { PLACE_HUB_ABI, NFT_FACTORY_ABI } from '../src/place/abi.js';
import { activeHub } from '../src/place/deployments.js';

const HUB = activeHub(84532).address;
const NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
const TOKEN = '0xc2a7d89dfb14663f14220ca6f2cb113dfb53b9b0';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ctx = { chainId: 84532, hub: HUB, now: NOW, feeBps: 500, targetDecimals: 18, rewardDecimals: 6, isNftTarget: false };
const form = {
  kind: 'token-holders',
  target: TOKEN,
  rewardToken: USDC,
  pool: '1,000',
  minBalance: '10',
  distribution: 'proportional',
  maxPerWallet: '',
  snapshotAt: '2026-11-20T12:00',
  claimDays: '14',
  leftover: 'return',
  exclude: '0x000000000000000000000000000000000000dEaD\n0x0000000000000000000000000000000000001234, 0x0000000000000000000000000000000000001234',
  excludeChecked: ['0x00000000000000000000000000000000000ABCDE'],
  name: 'PTEST holders, November',
  description: '',
};

test('UTC input fields read and write UTC, never local time', () => {
  assert.equal(parseUtcInput('2026-11-20T12:00'), Date.parse('2026-11-20T12:00:00Z') / 1000);
  assert.equal(parseUtcInput('2026-11-20'), null);
  assert.equal(parseUtcInput(''), null);
  assert.equal(toUtcInput(Date.parse('2026-11-20T12:30:00Z') / 1000), '2026-11-20T12:30');
});

test('the fee is computed like the hub: floor(pool × bps / 10 000)', () => {
  assert.equal(campaignFee(1000n, 500), 50n);
  assert.equal(campaignFee(999n, 500), 49n);
  assert.equal(campaignFee(10n ** 24n, 0), 0n);
});

test('address lists: one per line or comma, unique, bad entries reported', () => {
  const r = parseAddressList(`${TOKEN}\n${TOKEN.toUpperCase().replace('0X', '0x')}, nope`);
  assert.deepEqual(r.addresses, [TOKEN]);
  assert.deepEqual(r.bad, ['nope']);
});

test('a valid Holder Rewards form gives valid rules and createCampaign params', () => {
  const plan = planCampaign(form, ctx);
  assert.deepEqual(plan.errors, {});
  validateRules(plan.rules);
  assert.equal(plan.rules.hub, HUB);
  assert.equal(plan.rules.pool, '1000000000');
  assert.equal(plan.rules.minBalance, (10n * 10n ** 18n).toString());
  assert.equal(plan.rules.claimDuration, 14 * 86400);
  assert.equal(plan.rules.rewardToken, USDC.toLowerCase());
  assert.deepEqual(plan.rules.exclude, [
    '0x00000000000000000000000000000000000abcde',
    '0x0000000000000000000000000000000000001234',
    '0x000000000000000000000000000000000000dead',
  ].sort());
  assert.equal(plan.rulesHash, encodeRules(plan.rules).rulesHash);
  assert.equal(plan.fee, 50_000_000n);
  assert.equal(plan.due, 1_050_000_000n);
  assert.equal(plan.eth, false);
  // The params encode against the real ABI once the URIs are in.
  const data = encodeFunctionData({ abi: PLACE_HUB_ABI, functionName: 'createCampaign', args: [{ ...plan.params, rulesURI: 'ipfs://r', metadataURI: 'ipfs://m' }] });
  assert.match(data, /^0x/);
  assert.equal(plan.params.snapshotAt, BigInt(Date.parse('2026-11-20T12:00:00Z') / 1000));
  assert.equal(plan.params.burnLeftover, false);
});

test('ETH rewards: zero address on-chain, "eth" in the rules', () => {
  const plan = planCampaign({ ...form, rewardToken: 'eth', pool: '0.5', leftover: 'burn', distribution: 'equal' }, { ...ctx, rewardDecimals: null });
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.params.rewardToken, zeroAddress);
  assert.equal(plan.rules.rewardToken, 'eth');
  assert.equal(plan.rules.leftover, 'burn');
  assert.equal(plan.params.burnLeftover, true);
  assert.equal(plan.due, 525_000_000_000_000_000n);
});

test('NFT holders: the minimum is a count of NFTs, and the target must be a collection', () => {
  const nft = { ...form, kind: 'nft-holders', minBalance: '2' };
  const plan = planCampaign(nft, { ...ctx, isNftTarget: true });
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.rules.minBalance, '2');
  assert.equal(plan.params.kind, 1);
  assert.match(planCampaign(nft, ctx).errors.target, /not an ERC-721/);
  assert.match(planCampaign(form, { ...ctx, isNftTarget: true }).errors.target, /NFT collection/);
  assert.match(planCampaign({ ...nft, minBalance: '1.5' }, { ...ctx, isNftTarget: true }).errors.minBalance, /NFT/);
});

test('the form explains what the hub would reject', () => {
  const errs = (patch, c = ctx) => planCampaign({ ...form, ...patch }, c).errors;
  assert.ok(errs({ target: 'x' }).target);
  assert.ok(errs({ pool: '0' }).pool);
  assert.ok(errs({ pool: '1.0000001' }).pool, 'more decimals than the token has');
  assert.ok(errs({ snapshotAt: '2026-11-12T11:00' }).snapshotAt, 'in the past');
  assert.ok(errs({ snapshotAt: '2027-12-01T00:00' }).snapshotAt, 'too far ahead');
  assert.ok(errs({ claimDays: '0' }).claimDays);
  assert.ok(errs({ claimDays: '366' }).claimDays);
  assert.ok(errs({ maxPerWallet: '2000' }).maxPerWallet, 'cap above the pool');
  assert.ok(errs({ exclude: 'hello' }).exclude);
  assert.ok(errs({ name: ' ' }).name);
  assert.ok(errs({}, { ...ctx, rewardDecimals: null }).rewardToken);
  assert.ok(errs({}, { ...ctx, feeBps: null }).form);
});

test('the leftover warning: only when every wallet hits the cap', () => {
  assert.equal(cappedLeftover({ pool: 1000n, maxPerWallet: 100n, wallets: 5 }), 500n);
  assert.equal(cappedLeftover({ pool: 1000n, maxPerWallet: 100n, wallets: 10 }), 0n);
  assert.equal(cappedLeftover({ pool: 1000n, maxPerWallet: null, wallets: 1 }), 0n);
});

test('NFT Collection: params for NftFactory.createCollection', () => {
  const me = '0x0851b25d5d5b38ba260258a1520aff53e72c757d';
  const f = { name: 'Place Club', symbol: 'PCLUB', maxSupply: '333', maxPerWallet: '', paymentToken: 'eth', price: '0.001', mintStart: '', payout: me, burnPct: '', royaltyPct: '5', baseURI: 'ipfs://bafy/' };
  const plan = planCollection(f, { chainId: 84532, now: NOW, deployFee: 700000000000000n });
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.params.price, 10n ** 15n);
  assert.equal(plan.params.maxPerWallet, 0);
  assert.equal(plan.params.mintStart, BigInt(NOW));
  assert.equal(plan.params.royaltyReceiver, me);
  assert.equal(plan.params.royaltyBps, 500n);
  assert.equal(plan.params.burnBps, 0);
  assert.equal(plan.fee, 700000000000000n);
  assert.match(encodeFunctionData({ abi: NFT_FACTORY_ABI, functionName: 'createCollection', args: [plan.params] }), /^0x/);

  // Buyback with a different token needs the swap router; paying with the burn token itself does not.
  const burn = planCollection({ ...f, burnPct: '80', burnToken: TOKEN }, { chainId: 84532, now: NOW, deployFee: 0n });
  assert.equal(burn.params.burnBps, 8000);
  assert.equal(burn.params.swapRouter, SWAP_ROUTER[84532]);
  const same = planCollection({ ...f, burnPct: '50', burnToken: TOKEN, paymentToken: TOKEN }, { chainId: 84532, now: NOW, deployFee: 0n, paymentDecimals: 18 });
  assert.equal(same.params.swapRouter, zeroAddress);

  const errs = (patch) => planCollection({ ...f, ...patch }, { chainId: 84532, now: NOW, deployFee: 0n }).errors;
  assert.ok(errs({ symbol: '' }).symbol);
  assert.ok(errs({ maxSupply: '0' }).maxSupply);
  assert.ok(errs({ royaltyPct: '11' }).royaltyPct);
  assert.ok(errs({ burnPct: '10' }).burnToken);
  assert.ok(errs({ baseURI: 'ftp://x' }).baseURI);
});
