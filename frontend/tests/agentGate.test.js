// The agent API is switched off with FEATURES.agents: its HTTP entry answers 404 on every route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../src/config/features.js';
import handler from '../api/agent.js';

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.end = () => res;
  return res;
}

test('api/agent answers 404 on every route while FEATURES.agents is off', { skip: FEATURES.agents }, async () => {
  for (const [method, route] of [['GET', undefined], ['POST', 'swap'], ['POST', 'act'], ['GET', 'token'], ['PUT', 'settings'], ['OPTIONS', 'act']]) {
    const res = mockRes();
    await handler({ method, query: route ? { route } : {}, headers: {}, body: {} }, res);
    assert.equal(res.statusCode, 404, `${method} ${route || 'index'}`);
    assert.deepEqual(JSON.parse(res.body), { error: 'Not available yet' });
  }
});
