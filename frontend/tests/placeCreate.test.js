// The Launch NFT form logic (src/place/create.js): what the form sends must pass every check NftFactory and
// ClubNFT make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, zeroAddress } from 'viem';
import { planCollection, parseUtcInput, SWAP_ROUTER } from '../src/place/create.js';
import { NFT_FACTORY_ABI } from '../src/place/abi.js';

const NOW = Date.parse('2026-11-12T12:00:00Z') / 1000;
const TOKEN = '0xc2a7d89dfb14663f14220ca6f2cb113dfb53b9b0';

test('UTC input fields read UTC, never local time', () => {
  assert.equal(parseUtcInput('2026-11-20T12:00'), Date.parse('2026-11-20T12:00:00Z') / 1000);
  assert.equal(parseUtcInput('2026-11-20'), null);
  assert.equal(parseUtcInput(''), null);
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
