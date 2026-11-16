// Pure helpers of the Place Launch site (src/launch): formatting, pair categories, profiles, contract URIs,
// swap encoding and the anti-snipe curve. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeAbiParameters } from 'viem';
import { compact, smallNumber, usd, pct, age, bpsText, isNew } from '../src/launch/format.js';
import { pairCategory } from '../src/launch/pairs.js';
import { cleanProfile, profileMessage, xHandle, telegramHandle, httpsLink } from '../src/launch/profile.js';
import { buildContractUri, decodeDataUri, readContractUri } from '../src/launch/meta.js';
import { poolKey, swapDirection, encodeSwap, swapCalls, antiSnipe, withSlippage, UNIVERSAL_ROUTER_ABI, ETH, DIRECT_ROUTE } from '../src/launch/swap.js';
import { LAUNCH_DEPLOYMENTS } from '../src/launch/deployments.js';

const d = LAUNCH_DEPLOYMENTS[84532];
const B20 = '0xb200000000000000000000edee389ab594913e01';
const USDC = d.quotes.usdc;

test('numbers: compact, tiny prices with a zero count, USD, percent, age', () => {
  assert.equal(compact(1234), '1.23K');
  assert.equal(compact(2_530_000), '2.53M');
  assert.equal(compact(1_400_000_000), '1.4B');
  assert.equal(compact(12.5), '12.5');
  assert.equal(compact(null), '—');
  assert.equal(smallNumber(0.00000551322), '0.0₅5513');
  assert.equal(smallNumber(0.00123), '0.00123');
  assert.equal(smallNumber(0.5), '0.5');
  assert.equal(usd(55130), '$55.13K');
  assert.equal(usd(0.12), '$0.12');
  assert.equal(usd(0.000003667), '$0.0₅3667');
  assert.equal(usd(null), '—');
  assert.equal(pct(12.345), '+12.3%');
  assert.equal(pct(-3), '-3%');
  assert.equal(pct(0.14), '+0.14%');
  const now = Date.parse('2026-11-14T12:00:00Z');
  assert.equal(age('2026-11-14T11:59:30Z', now), '30s');
  assert.equal(age('2026-11-14T09:00:00Z', now), '3h');
  assert.equal(age('2026-08-01T00:00:00Z', now), '3mo');
  assert.equal(bpsText(2500), '25%');
  assert.equal(bpsText(750), '7.5%');
  assert.ok(isNew('2026-11-14T00:00:00Z', now));
  assert.ok(!isNew('2026-11-12T00:00:00Z', now));
});

test('pairs: majors are crypto, everything else on the list is a stock', () => {
  assert.equal(pairCategory('ETH'), 'crypto');
  assert.equal(pairCategory('USDC'), 'crypto');
  assert.equal(pairCategory('cbBTC'), 'crypto');
  assert.equal(pairCategory('NVDAc'), 'stocks');
});

test('profiles: handles and links are normalized, limits enforced, the signed text quotes every field', () => {
  assert.equal(xHandle('https://x.com/maks_1'), 'maks_1');
  assert.equal(xHandle('@maks'), 'maks');
  assert.equal(xHandle('twitter.com/maks/status/1'), 'maks');
  assert.equal(xHandle(''), null);
  assert.throws(() => xHandle('not a handle!'));
  assert.equal(telegramHandle('t.me/place_chat'), 'place_chat');
  assert.equal(httpsLink('example.com'), 'https://example.com');
  assert.equal(httpsLink('http://example.com/a'), 'https://example.com/a');
  assert.throws(() => httpsLink('javascript:alert(1)'));
  assert.throws(() => cleanProfile({ name: 'x'.repeat(41) }));
  assert.throws(() => cleanProfile({ avatar: 'https://evil/a.png' }));
  const p = cleanProfile({ name: ' Maks ', bio: 'Hi' });
  assert.equal(p.name, 'Maks');
  assert.equal(p.website, null);
  const msg = profileMessage({ address: '0xABC', profile: { name: 'A\nWallet: 0xevil' }, issuedAt: 'now' });
  assert.equal(msg.split('\n').filter((l) => l.startsWith('Wallet:')).length, 1, 'a line break in a field cannot fake a line');
  assert.match(msg, /^Place: save creator profile\nWallet: 0xabc\n/);
});

test('contract URI: the logo as an inline JSON data URI, read back without the network', async () => {
  const uri = buildContractUri({ image: 'ipfs://bafyabc' });
  assert.match(uri, /^data:application\/json;base64,/);
  assert.deepEqual(decodeDataUri(uri), { image: 'ipfs://bafyabc' });
  assert.deepEqual(await readContractUri(uri), { image: 'ipfs://bafyabc' });
  assert.deepEqual(decodeDataUri(buildContractUri({ image: null })), {});
  assert.equal(decodeDataUri('https://example.com/a.json'), null);
  assert.equal(await readContractUri(''), null);
});

test('swap: pool key, direction, Universal Router calldata and Permit2 steps', () => {
  const key = poolKey(B20, 'eth', d.hook);
  assert.equal(key.currency0, ETH);
  assert.equal(key.currency1, B20);
  assert.equal(key.fee, 0);
  assert.equal(key.tickSpacing, 200);
  const buy = swapDirection({ key, side: 'buy', token: B20 });
  assert.deepEqual([buy.input, buy.output, buy.zeroForOne], [ETH, B20, true]);
  const sell = swapDirection({ key, side: 'sell', token: B20 });
  assert.deepEqual([sell.input, sell.output, sell.zeroForOne], [B20, ETH, false]);

  const data = encodeSwap({ key, ...buy, amountIn: 200000000000000n, minOut: 5n, deadline: 1800000000 });
  const call = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data });
  assert.equal(call.args[0], '0x10', 'V4_SWAP');
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], call.args[1][0]);
  assert.equal(actions, '0x060c0f', 'SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL');
  assert.equal(params.length, 3);
  assert.equal(call.args[2], 1800000000n);

  const now = 1_800_000_000;
  const ethBuy = swapCalls({ d, key, ...buy, amountIn: 10n, minOut: 1n, deadline: now, allowances: null, now, label: 'Buy' });
  assert.equal(ethBuy.length, 1);
  assert.equal(ethBuy[0].value, 10n);
  const sellFresh = swapCalls({ d, key, ...sell, amountIn: 10n, minOut: 1n, deadline: now, allowances: { erc20ToPermit2: 0n, permit2Amount: 0n, permit2Expiration: 0 }, now, label: 'Sell' });
  assert.deepEqual(sellFresh.map((c) => c.functionName || 'swap'), ['approve', 'approve', 'swap']);
  assert.equal(sellFresh[2].value, 0n);
  const sellReady = swapCalls({ d, key, ...sell, amountIn: 10n, minOut: 1n, deadline: now, allowances: { erc20ToPermit2: 10n ** 30n, permit2Amount: 100n, permit2Expiration: now + 3600 }, now, label: 'Sell' });
  assert.equal(sellReady.length, 1);
  const usdcKey = poolKey('0xb4f38e468f983611a1fb5574989be0e6a94efe01', USDC, d.hook);
  assert.equal(usdcKey.currency0, USDC, 'USDC sorts below this token');
  assert.equal(withSlippage(1000n, 300), 970n);
  assert.equal(DIRECT_ROUTE.length, 2 + 128, 'abi.encode(PoolKey[0]): offset and length');
});

test('anti-snipe: 99% falling linearly to 1% over 20 s, then nothing', () => {
  const cfg = { launchTime: 1000, startRate: 990_000, windowSeconds: 20, rateScale: 1_000_000 };
  assert.equal(antiSnipe(cfg, 1000).feePct, 99);
  assert.equal(antiSnipe(cfg, 1010).feePct, 50);
  assert.equal(antiSnipe(cfg, 1010).secondsLeft, 10);
  assert.equal(antiSnipe(cfg, 1020), null);
  assert.equal(antiSnipe({ ...cfg, windowSeconds: 0 }, 1001), null);
});
