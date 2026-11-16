// The site's side of Place: the API client (src/place/api.js) and the formatting every page uses (format.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceApi, PlaceApiError, queryString, fetchIpfsJson } from '../src/place/api.js';
import { formatAmount, formatToken, parseAmount, formatUtc, countdown, ipfsUrl, shortAddress } from '../src/place/format.js';
import { PLACE_CHAIN_ID } from '../src/place/chain.js';

const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function recorder(response = reply(200, { ok: true })) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, fetchFn };
}

test('the portal works on Base Sepolia until mainnet', () => {
  assert.equal(PLACE_CHAIN_ID, 84532);
});

test('queryString skips empty values', () => {
  assert.equal(queryString({ a: 1, b: null, c: undefined, d: '', e: 'x y' }), '?a=1&e=x+y');
  assert.equal(queryString({}), '');
});

test('GET requests carry the chain and the parameters', async () => {
  const { calls, fetchFn } = recorder(reply(200, { campaigns: [], nextOffset: null }));
  const api = createPlaceApi({ base: '/api/place', chainId: 84532, fetchFn });
  await api.campaigns({ status: 'live', kind: 'nft-holders' });
  await api.campaign({ hub: '0xabc', id: '0', address: '0xbeef' });
  await api.claims('0xbeef');
  await api.holders({ target: '0x1', kind: 'token-holders', min: '5' });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      '/api/place/campaigns?chain=84532&status=live&kind=nft-holders',
      '/api/place/campaign?chain=84532&hub=0xabc&id=0&address=0xbeef',
      '/api/place/claims?chain=84532&address=0xbeef',
      '/api/place/holders?chain=84532&target=0x1&kind=token-holders&min=5',
    ]
  );
  assert.equal(calls[0].init.method, 'GET');
});

test('POST requests send JSON: pins and admin moderation', async () => {
  const { calls, fetchFn } = recorder(reply(200, { uri: 'ipfs://cid', rulesHash: '0x12' }));
  const api = createPlaceApi({ base: '/api/place', chainId: 84532, fetchFn });
  const out = await api.pinRules({ schema: 'place.rules/1' });
  assert.deepEqual(out, { uri: 'ipfs://cid', rulesHash: '0x12' });
  await api.hide({ action: 'hide', type: 'campaign', target: '0xhub:1', admin: '0xa', issuedAt: 'now', signature: '0xs' });
  assert.equal(calls[0].url, '/api/place/pin');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { kind: 'rules', content: { schema: 'place.rules/1' } });
  assert.equal(calls[1].url, '/api/place/admin/hide');
  assert.equal(JSON.parse(calls[1].init.body).chainId, 84532);
});

test('an error reply becomes a PlaceApiError with the server message', async () => {
  const api = createPlaceApi({ fetchFn: recorder(reply(404, { error: 'Campaign not found (it may not be indexed yet)' })).fetchFn });
  await assert.rejects(api.campaign({ hub: '0x1', id: '9' }), (e) => e instanceof PlaceApiError && e.status === 404 && /not found/.test(e.message));
  const down = createPlaceApi({
    fetchFn: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(down.claims('0x1'), (e) => e instanceof PlaceApiError && e.status === 0);
  const html = createPlaceApi({ fetchFn: recorder(reply(502, '<html>Bad gateway</html>')).fetchFn });
  await assert.rejects(html.claims('0x1'), (e) => e.status === 502 && /502/.test(e.message));
});

test('IPFS reads fall back to the next gateway', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 504 };
    return { ok: true, json: async () => ({ name: 'Rewards' }) };
  };
  assert.deepEqual(await fetchIpfsJson('ipfs://bafyabc', { fetchFn }), { name: 'Rewards' });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /\/ipfs\/bafyabc$/);
  await assert.rejects(fetchIpfsJson('ipfs://bafyabc', { fetchFn: async () => ({ ok: false, status: 500 }) }), /Could not load/);
});

test('amounts: commas, cut decimals, tiny values, compact form', () => {
  assert.equal(formatAmount('1000000000000000000000', 18), '1,000');
  assert.equal(formatAmount('1234567890000000000', 18), '1.2345');
  assert.equal(formatAmount('1500000', 6, { maxDecimals: 2 }), '1.5');
  assert.equal(formatAmount('1', 18), '0.000000000000000001');
  assert.equal(formatAmount('20000000000000', 18), '0.00002');
  assert.equal(formatAmount('12345678900000', 18), '0.0000123');
  assert.equal(formatAmount('0', 18), '0');
  assert.equal(formatAmount('31500000000000000000000000', 18, { compact: true }), '31.50M');
  assert.equal(formatAmount(null), '—');
  assert.equal(formatToken('200000000000000000000', { symbol: 'PLT', decimals: 18 }), '200 PLT');
  assert.equal(formatToken('5000000000000000', null), '0.005 tokens');
});

test('parseAmount reads form input into raw units', () => {
  assert.equal(parseAmount('1,000.5', 18), 1000500000000000000000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.equal(parseAmount('0.0000001', 6), null);
  assert.equal(parseAmount('abc', 18), null);
  assert.equal(parseAmount('', 18), null);
  assert.equal(parseAmount('-1', 18), null);
});

test('dates in UTC and countdowns in the design format', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.equal(formatUtc('2026-10-25T00:00:00Z', { now }), '25 Oct, 00:00 UTC');
  assert.equal(formatUtc('2027-01-02T03:04:00Z', { now }), '2 Jan 2027, 03:04 UTC');
  assert.equal(formatUtc(null), '—');
  const t0 = Date.parse('2026-11-12T00:00:00Z');
  assert.equal(countdown('2026-12-01T01:04:01Z', t0), '19d 01h 04m 01s');
  assert.equal(countdown('2026-11-12T00:05:07Z', t0), '5m 07s');
  assert.equal(countdown('2026-11-11T00:00:00Z', t0), '0s');
});

test('ipfs links and short addresses', () => {
  assert.equal(ipfsUrl('ipfs://bafy/x.json'), 'https://gateway.pinata.cloud/ipfs/bafy/x.json');
  assert.equal(ipfsUrl('ipfs://ipfs/bafy', 1), 'https://ipfs.io/ipfs/bafy');
  assert.equal(ipfsUrl('https://example.org/a.png'), 'https://example.org/a.png');
  assert.equal(ipfsUrl('javascript:alert(1)'), null);
  assert.equal(shortAddress('0x9E92307Dbec2d0aE4BBF14cA93E1cA00edC4b886'), '0x9E92...b886');
});

test('viewStatus follows the clock like PlaceHub.statusOf', async () => {
  const { viewStatus } = await import('../src/place/status.js');
  const c = { status: 'scheduled', merkleRoot: null, snapshotAt: '2026-11-12T12:00:00Z', claimEnd: null };
  const t = (iso) => Date.parse(iso) / 1000;
  assert.equal(viewStatus(c, t('2026-11-12T11:59:59Z')), 'scheduled');
  assert.equal(viewStatus(c, t('2026-11-12T12:00:00Z')), 'snapshotting');
  assert.equal(viewStatus(c, t('2026-11-15T12:00:00Z')), 'refundable');
  const live = { status: 'live', merkleRoot: '0x01', snapshotAt: '2026-11-12T12:00:00Z', claimEnd: '2026-11-13T12:00:00Z' };
  assert.equal(viewStatus(live, t('2026-11-13T11:00:00Z')), 'live');
  assert.equal(viewStatus(live, t('2026-11-13T12:00:00Z')), 'ended');
  assert.equal(viewStatus({ ...live, status: 'closed' }, t('2026-11-14T00:00:00Z')), 'closed');
  assert.equal(viewStatus({ ...c, status: 'cancelled' }, t('2026-11-12T00:00:00Z')), 'cancelled');
});
