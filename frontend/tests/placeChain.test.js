// Place chain data: the snapshot block search and Alchemy transfer paging, against fakes (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { custom } from 'viem';
import { chainClient, blockAtTime, transfersPage, collectTransfers, alchemyUrl } from '../api/_lib/place/chain.js';

// A fake chain: block n has timestamp 1000 + 2n, except a 10 s gap after block 500 (a stall).
const ts = (n) => 1000n + 2n * n + (n > 500n ? 10n : 0n);
function fakeChain(latest) {
  let calls = 0;
  const transport = custom({
    async request({ method, params }) {
      if (method !== 'eth_getBlockByNumber') throw new Error(`unexpected ${method}`);
      calls++;
      const n = params[0] === 'latest' ? latest : BigInt(params[0]);
      return {
        number: `0x${n.toString(16)}`,
        timestamp: `0x${ts(n).toString(16)}`,
        hash: `0x${n.toString(16).padStart(64, '0')}`,
        parentHash: `0x${'0'.repeat(64)}`,
        transactions: [],
        uncles: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        miner: `0x${'0'.repeat(40)}`,
        difficulty: '0x0',
        gasLimit: '0x0',
        gasUsed: '0x0',
        extraData: '0x',
        nonce: '0x0000000000000000',
        sha3Uncles: `0x${'0'.repeat(64)}`,
        stateRoot: `0x${'0'.repeat(64)}`,
        receiptsRoot: `0x${'0'.repeat(64)}`,
        transactionsRoot: `0x${'0'.repeat(64)}`,
        size: '0x0',
        totalDifficulty: '0x0',
      };
    },
  });
  return { client: chainClient({ chainId: 8453, transport }), calls: () => calls };
}

test('blockAtTime: last block at or before the time', async () => {
  const { client } = fakeChain(100_000n);
  assert.equal((await blockAtTime(client, 1000 + 2 * 300)).number, 300n); // exact
  assert.equal((await blockAtTime(client, 1000 + 2 * 300 + 1)).number, 300n); // between blocks
  assert.equal((await blockAtTime(client, Number(ts(501n)) - 1)).number, 500n); // inside the stall
  assert.equal((await blockAtTime(client, Number(ts(90_000n)))).number, 90_000n);
  // At the head's own second more blocks may still come with the same timestamp: not final yet.
  await assert.rejects(blockAtTime(client, Number(ts(100_000n))), /not reached/);
});

test('blockAtTime: 200 ms blocks share timestamps, and the last of them is the snapshot block', async () => {
  // Five blocks per second, like Base since 2026: blocks 5k…5k+4 all have timestamp 1000 + k.
  const t = (n) => 1000n + n / 5n;
  const transport = custom({
    async request({ params }) {
      const n = params[0] === 'latest' ? 1_000_000n : BigInt(params[0]);
      return { number: `0x${n.toString(16)}`, timestamp: `0x${t(n).toString(16)}`, hash: `0x${'1'.padStart(64, '0')}`, transactions: [] };
    },
  });
  const client = chainClient({ chainId: 8453, transport });
  assert.equal((await blockAtTime(client, 1000 + 12_345)).number, 12_345n * 5n + 4n);
  assert.equal((await blockAtTime(client, 1000 + 150_000)).number, 150_000n * 5n + 4n);
});

test('blockAtTime: the estimate can be far off and it still converges', async () => {
  // Real chains drift from 2 s blocks; here the first 50k blocks were 1 s apart, so the estimate overshoots.
  const odd = (n) => (n < 50_000n ? 1000n + n : 51_000n + 2n * (n - 50_000n));
  const transport = custom({
    async request({ params }) {
      const n = params[0] === 'latest' ? 200_000n : BigInt(params[0]);
      return { number: `0x${n.toString(16)}`, timestamp: `0x${odd(n).toString(16)}`, hash: `0x${'1'.padStart(64, '0')}`, transactions: [] };
    },
  });
  const client = chainClient({ chainId: 8453, transport });
  assert.equal((await blockAtTime(client, 10_000)).number, 9_000n);
});

test('blockAtTime: refuses a time in the future', async () => {
  const { client } = fakeChain(10n);
  await assert.rejects(blockAtTime(client, 10_000_000), /not reached/);
});

function fakeAlchemy(pages) {
  const seen = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, params: body.params[0] });
    const i = body.params[0].pageKey ? Number(body.params[0].pageKey) : 0;
    return { ok: true, json: async () => ({ result: { transfers: pages[i], pageKey: i + 1 < pages.length ? String(i + 1) : undefined } }) };
  };
  return { fetchFn, seen };
}

const t = (to, block, tokenId) => ({ to, blockNum: `0x${block.toString(16)}`, ...(tokenId != null ? { tokenId: `0x${tokenId.toString(16)}` } : {}) });

test('transfersPage: one request, receivers lowercased, ids for NFTs', async () => {
  const { fetchFn, seen } = fakeAlchemy([[t('0xAbC0000000000000000000000000000000000001', 5, 7), t(null, 6, 8)]]);
  const p = await transfersPage({ chainId: 84532, key: 'k', contract: '0x1', category: 'erc721', toBlock: 99n, fetchFn });
  assert.deepEqual(p.receivers, ['0xabc0000000000000000000000000000000000001']);
  assert.deepEqual(p.tokenIds, [7n, 8n]);
  assert.equal(p.lastBlock, 6n);
  assert.equal(p.pageKey, null);
  assert.equal(seen[0].url, alchemyUrl(84532, 'k'));
  assert.equal(seen[0].params.toBlock, '0x63');
  assert.deepEqual(seen[0].params.category, ['erc721']);
  assert.equal(seen[0].params.order, 'asc');
});

test('collectTransfers: pages through, and can stop and resume', async () => {
  const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const pages = [[t(a(1), 1), t(a(2), 2)], [t(a(2), 3), t(a(3), 4)], [t(a(4), 5)]];
  const { fetchFn } = fakeAlchemy(pages);
  const into = { receivers: new Set() };
  const base = { chainId: 8453, key: 'k', contract: '0x1', category: 'erc20', toBlock: 10n, fetchFn };

  const next = await collectTransfers({ into, maxPages: 2, ...base });
  assert.equal(next, '2');
  assert.equal(into.receivers.size, 3);
  assert.equal(await collectTransfers({ into, pageKey: next, ...base }), null);
  assert.deepEqual([...into.receivers].sort(), [a(1), a(2), a(3), a(4)]);
});

test('transfersPage: Alchemy errors surface after retries', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
  };
  await assert.rejects(transfersPage({ chainId: 8453, key: 'k', contract: '0x1', category: 'erc20', toBlock: 1n, fetchFn }), /rate limited/);
  assert.equal(n, 4);
});

test('alchemyUrl needs a key and a known chain', () => {
  assert.throws(() => alchemyUrl(8453, ''), /ALCHEMY_API_KEY/);
  assert.throws(() => alchemyUrl(1, 'k'), /Unsupported chain/);
});
