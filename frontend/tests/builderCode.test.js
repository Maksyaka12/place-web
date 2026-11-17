// Place's Base Builder Code (ERC-8021) on every transaction: the suffix itself, the browser helper, and the
// server wallets (hub publisher, launch keeper) that sign with their own keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction } from 'viem';
import { Attribution } from 'ox/erc8021';
import { BUILDER_CODE, DATA_SUFFIX, appendBuilderSuffix } from '../src/config/builderCode.js';
import { makePublisher } from '../api/_lib/place/publisher.js';
import { makeKeeperWallet } from '../api/_lib/launch/keeper.js';
import { REWARDS_DISTRIBUTOR_ABI } from '../src/launch/abi.js';

const KEY = `0x${'11'.repeat(32)}`; // throwaway test key, never funded
const ADDR = `0x${'22'.repeat(20)}`;

test('the suffix carries the Place Builder Code', () => {
  assert.equal(BUILDER_CODE, 'bc_d8uel2lf');
  assert.equal(DATA_SUFFIX, '0x62635f643875656c326c660b0080218021802180218021802180218021');
  assert.deepEqual(Attribution.fromData(`0xabcdef${DATA_SUFFIX.slice(2)}`)?.codes, ['bc_d8uel2lf']);
});

test('appendBuilderSuffix appends once', () => {
  const once = appendBuilderSuffix('0x1234');
  assert.equal(once, `0x1234${DATA_SUFFIX.slice(2)}`);
  assert.equal(appendBuilderSuffix(once), once);
});

/** Answers the JSON-RPC calls viem makes before sending, and keeps every raw transaction sent. */
function mockRpc(t) {
  const sent = [];
  const answers = {
    eth_chainId: '0x14a34',
    eth_getTransactionCount: '0x0',
    eth_estimateGas: '0x5208',
    eth_maxPriorityFeePerGas: '0x1',
    eth_gasPrice: '0x1',
    eth_getBlockByNumber: { baseFeePerGas: '0x1', number: '0x1', timestamp: '0x1', hash: `0x${'00'.repeat(32)}` },
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    const one = (req) => {
      if (req.method === 'eth_sendRawTransaction') {
        sent.push(parseTransaction(req.params[0]));
        return { jsonrpc: '2.0', id: req.id, result: `0x${'ab'.repeat(32)}` };
      }
      if (!(req.method in answers)) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: req.method } };
      return { jsonrpc: '2.0', id: req.id, result: answers[req.method] };
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  });
  return sent;
}

test('the hub publisher signs publishRoot with the Place suffix', async (t) => {
  const sent = mockRpc(t);
  const publisher = makePublisher({ chainId: 84532, alchemyKey: 'test', privateKey: KEY });
  await publisher.publishRoot({ hub: ADDR, campaignId: 1, root: `0x${'33'.repeat(32)}`, totalAllocated: 10, proofsURI: 'ipfs://x' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].data.endsWith(DATA_SUFFIX.slice(2)), 'publishRoot calldata ends with the Builder Code suffix');
});

test('the launch keeper signs vault calls with the Place suffix', async (t) => {
  const sent = mockRpc(t);
  const readClient = { waitForTransactionReceipt: async () => ({ status: 'success', gasUsed: 21000n }) };
  const keeper = makeKeeperWallet({ chainId: 84532, alchemyKey: 'test', privateKey: KEY, readClient });
  await keeper.send({ address: ADDR, abi: REWARDS_DISTRIBUTOR_ABI, functionName: 'closeStreams', args: [[`0x${'44'.repeat(32)}`]] }, 100_000n);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].data.endsWith(DATA_SUFFIX.slice(2)), 'closeStreams calldata ends with the Builder Code suffix');
});
