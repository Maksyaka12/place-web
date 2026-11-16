// API guards: requests that must be refused before anything touches the chain, a wallet or the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSwap, handleAgentIndex } from '../api/_lib/agent.js';
import { handleAgentAct, handleAgentToken, handleAgentSettings } from '../api/_lib/agentWallet.js';

const WALLET = '0x4c91d3bed372c11795b9ce9a9017dfe447bf050a';

for (const [name, handle] of Object.entries({ handleSwap })) {
  test(`${name} is read-only`, async () => {
    const res = await handle({ method: 'POST', query: { address: WALLET } });
    assert.equal(res.status, 405);
  });

  test(`${name} refuses a missing or invalid wallet`, async () => {
    assert.equal((await handle({ method: 'GET', query: {} })).status, 400);
    assert.equal((await handle({ method: 'GET', query: { address: 'not-a-wallet' } })).status, 400);
  });
}

test('the agent cannot act with a GET request', async () => {
  const res = await handleAgentAct({ method: 'GET', headers: {}, body: {} });
  assert.equal(res.status, 405);
});

test('the agent cannot act without a key', async () => {
  const res = await handleAgentAct({ method: 'POST', headers: {}, body: { action: 'swap' } });
  assert.equal(res.status, 401);
});

test('the agent cannot act with a made-up key', async () => {
  const res = await handleAgentAct({ method: 'POST', headers: { authorization: 'Bearer place_agent_fake' }, body: { action: 'swap' } });
  assert.ok([401, 403, 503].includes(res.status), `status ${res.status}`);
});

test('agent keys and settings need a login', async () => {
  assert.equal((await handleAgentToken({ method: 'GET', headers: {} })).status, 401);
  assert.equal((await handleAgentSettings({ method: 'GET', headers: {} })).status, 401);
});

test('the agent index is read-only and names Place', async () => {
  assert.equal((await handleAgentIndex({ method: 'POST' })).status, 405);
  const res = await handleAgentIndex({ method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Place agent API');
});
