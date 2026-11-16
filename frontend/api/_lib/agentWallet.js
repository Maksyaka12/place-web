// Autonomous agent actions from the user's agent wallet (Privy embedded wallet), signed by our server.
//
// The user enables the agent once on the site: their embedded wallet gets our key quorum as an extra signer
// (Privy addSigners, revocable), and the site gets a personal agent key from POST /api/agent/token.
// The agent then calls POST /api/agent/act with `Authorization: Bearer <agent key>` and the server signs
// and sends the transaction with our authorization key: no wallet prompts.
//
// What an agent key can do (everything else is refused):
// - swap any two tokens on Base (the server builds the route, the output always comes back to the wallet);
// - transfer any token to the user's own main wallet, with no limit;
// - transfer ETH and USDC to other addresses, capped per day.
// The user can lower or raise the daily caps and turn swaps and transfers to other addresses off
// (GET / PUT /api/agent/settings); the checks below read those settings.
//
// Env: PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY (private key of the key quorum), optional PRIVY_APP_ID,
// PRIVY_SIGNER_ID, AGENT_DAILY_LIMIT_ETH / _USDC.

import { createHash, randomBytes } from 'node:crypto';
import { encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import { json, store, env } from './common.js';
import { publicClient } from '../../src/config/rpc.js';
import { appendBuilderSuffix } from '../../src/config/builderCode.js';
import { ERC20_ABI, USDC } from '../../src/config/tokens.js';
import { handleSwap, tokenFrom } from './agent.js';

export const PRIVY_APP_ID = env('PRIVY_APP_ID') || 'cmwdlylbc015d0hjq5a5ybnlv';
export const AGENT_SIGNER_ID = env('PRIVY_SIGNER_ID') || '';
export const AGENT_KEY_PREFIX = 'place_agent_';

// Tokens an agent may send to addresses other than the owner's main wallet, each with a daily cap.
const CAPPED = {
  ETH: { address: null, decimals: 18, limit: env('AGENT_DAILY_LIMIT_ETH') || '5' },
  USDC: { address: USDC.address, decimals: 6, limit: env('AGENT_DAILY_LIMIT_USDC') || '10000' },
};

// Highest daily caps a user can set for transfers to other addresses.
const MAX_LIMITS = { ETH: '10', USDC: '100000' };
const DEFAULT_SETTINGS = {
  limits: Object.fromEntries(Object.entries(CAPPED).map(([symbol, t]) => [symbol, t.limit])),
  allow: { swaps: true, transfers: true },
};

const settingsKey = (address) => `agent_settings:${String(address || '').toLowerCase()}`;

/** The user's agent settings over the defaults. */
async function readSettings(address) {
  const saved = (await (await store()).get(settingsKey(address))) || {};
  const known = (defaults, values = {}) => Object.fromEntries(Object.keys(defaults).map((k) => [k, k in values ? values[k] : defaults[k]]));
  return {
    limits: known(DEFAULT_SETTINGS.limits, saved.limits),
    allow: known(DEFAULT_SETTINGS.allow, saved.allow),
  };
}

const EMBEDDED = ['privy', 'privy-v2'];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const lower = (a) => String(a || '').toLowerCase();

let client;
async function privy() {
  if (!env('PRIVY_APP_SECRET') || !env('PRIVY_AUTHORIZATION_KEY')) throw new Error('Agent signing is not configured on the server');
  if (!client) {
    const { PrivyClient } = await import('@privy-io/node');
    client = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: env('PRIVY_APP_SECRET') });
  }
  return client;
}

const bearer = (headers = {}) => {
  const h = headers.authorization || headers.Authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** The logged-in Privy user behind a site request: user id, main wallet and the embedded (agent) wallet. */
async function siteUser(headers) {
  const token = bearer(headers);
  if (!token) return { error: json(401, { error: 'Log in on the site first' }) };
  const p = await privy();
  let userId;
  try {
    userId = (await p.utils().auth().verifyAccessToken(token)).user_id;
  } catch {
    return { error: json(401, { error: 'Session expired, log in again' }) };
  }
  const user = await p.users()._get(userId);
  const walletAccounts = (user.linked_accounts || []).filter((a) => a.type === 'wallet' && a.chain_type !== 'solana');
  const main = walletAccounts.find((a) => !EMBEDDED.includes(a.wallet_client_type));
  const embedded = walletAccounts.find((a) => EMBEDDED.includes(a.wallet_client_type));
  if (!embedded) return { error: json(409, { error: 'This account has no agent wallet yet: log out and in again' }) };
  let wallet = null;
  for await (const w of p.wallets().list({ user_id: userId, chain_type: 'ethereum' })) {
    if (lower(w.address) === lower(embedded.address)) wallet = w;
  }
  if (!wallet) return { error: json(409, { error: 'Agent wallet not found' }) };
  return { userId, wallet, mainAddress: main?.address || null };
}

const hasOurSigner = (wallet) => (wallet.additional_signers || []).some((s) => s.signer_id === AGENT_SIGNER_ID);

// ─────────────────────────────── /api/agent/token ───────────────────────────────
// GET: is the agent enabled; POST: issue a new agent key (the old one stops working); DELETE: revoke it.

export async function handleAgentToken({ method, headers = {} }) {
  if (!['GET', 'POST', 'DELETE'].includes(method)) return json(405, { error: 'Method not allowed' }, { Allow: 'GET, POST, DELETE' });
  try {
    const me = await siteUser(headers);
    if (me.error) return me.error;
    const db = await store();
    const userKey = `agent_user:${me.userId}`;
    const current = await db.get(userKey);

    if (method === 'GET') {
      return json(200, { address: me.wallet.address, signer: hasOurSigner(me.wallet), hasKey: Boolean(current?.hash), keyCreatedAt: current?.createdAt || null }, { 'Cache-Control': 'no-store' });
    }
    if (method === 'DELETE') {
      await db.write([...(current?.hash ? [['del', `agent_token:${current.hash}`]] : []), ['del', userKey]]);
      return json(200, { revoked: true });
    }

    if (!hasOurSigner(me.wallet)) return json(409, { error: 'Enable the agent first: the wallet has no Place signer' });
    const token = `${AGENT_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const hash = sha256(token);
    const record = { userId: me.userId, walletId: me.wallet.id, address: getAddress(me.wallet.address), mainAddress: me.mainAddress, createdAt: new Date().toISOString() };
    await db.write([
      ...(current?.hash ? [['del', `agent_token:${current.hash}`]] : []),
      ['set', `agent_token:${hash}`, record],
      ['set', userKey, { hash, createdAt: record.createdAt }],
    ]);
    return json(200, { token, address: record.address }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json(500, { error: e.message || 'Server error' });
  }
}

// ─────────────────────────────── /api/agent/settings ───────────────────────────────
// GET: the agent wallet's settings and what it sent to other addresses today; PUT { limits?, allow? }: change them.

const DECIMAL = /^\d+(\.\d+)?$/;

async function settingsView(me) {
  const settings = await readSettings(me.wallet.address);
  const today = (await (await store()).get(dayKey(me.wallet.address))) || {};
  const spentToday = Object.fromEntries(Object.entries(CAPPED).map(([symbol, t]) => [symbol, formatUnits(BigInt(today[symbol] || '0'), t.decimals)]));
  return { address: getAddress(me.wallet.address), mainAddress: me.mainAddress, ...settings, defaults: DEFAULT_SETTINGS, max: MAX_LIMITS, spentToday };
}

export async function handleAgentSettings({ method, headers = {}, body }) {
  if (!['GET', 'PUT'].includes(method)) return json(405, { error: 'Method not allowed' }, { Allow: 'GET, PUT' });
  try {
    const me = await siteUser(headers);
    if (me.error) return me.error;
    if (method === 'GET') return json(200, await settingsView(me), { 'Cache-Control': 'no-store' });

    const req = body && typeof body === 'object' ? body : {};
    const current = await readSettings(me.wallet.address);
    const next = { limits: { ...current.limits }, allow: { ...current.allow } };
    for (const [symbol, value] of Object.entries(req.limits || {})) {
      const t = CAPPED[symbol];
      const v = String(value).trim();
      if (!t || !DECIMAL.test(v)) return json(400, { error: `Enter a number for the ${symbol} limit` });
      if (parseUnits(v, t.decimals) > parseUnits(MAX_LIMITS[symbol], t.decimals)) return json(400, { error: `The ${symbol} limit can be at most ${MAX_LIMITS[symbol]}` });
      next.limits[symbol] = v.replace(/^0+(?=\d)/, '');
    }
    for (const [name, value] of Object.entries(req.allow || {})) {
      if (!(name in DEFAULT_SETTINGS.allow) || typeof value !== 'boolean') return json(400, { error: `Unknown setting ${name}` });
      next.allow[name] = value;
    }
    // only what differs from the defaults is stored, so a later change of the defaults reaches everyone else
    const differs = (group) => Object.fromEntries(Object.entries(next[group]).filter(([k, v]) => String(v) !== String(DEFAULT_SETTINGS[group][k])));
    await (await store()).write([['set', settingsKey(me.wallet.address), { limits: differs('limits'), allow: differs('allow') }]]);
    return json(200, await settingsView(me), { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json(500, { error: e.message || 'Server error' });
  }
}

// ─────────────────────────────── /api/agent/act ───────────────────────────────

async function agentFromKey(headers) {
  const token = bearer(headers);
  if (!token || !token.startsWith(AGENT_KEY_PREFIX)) return null;
  return (await store()).get(`agent_token:${sha256(token)}`);
}

const dayKey = (address) => `agent_spend:${lower(address)}:${new Date().toISOString().slice(0, 10)}`;

// Transfers to other addresses count against a daily cap. They run one at a time per agent wallet (a lock), and
// the amount is reserved before the transaction is sent, so parallel requests cannot all see "nothing spent yet".
const TRANSFERS_OFF = 'Transfers to other addresses are turned off in your Place settings. Transfers to your own main wallet still work.';
const BUSY = 'Another transfer from this agent wallet is still running. Try again in a few seconds.';
const LOCK_SECONDS = 120;

/** Reserves `amount` in today's spend if it fits under the cap; returns an error message or null. Call under the lock. */
async function reserveSpend(settings, symbol, amount, key) {
  const db = await store();
  const t = CAPPED[symbol];
  const limit = settings.limits[symbol];
  const today = (await db.get(key)) || {};
  const spent = BigInt(today[symbol] || '0');
  const cap = parseUnits(limit, t.decimals);
  if (spent + amount > cap) {
    return `Daily limit for transfers to other addresses is ${limit} ${symbol}; ${formatUnits(cap - spent < 0n ? 0n : cap - spent, t.decimals)} ${symbol} left today. Transfers to your own main wallet have no limit.`;
  }
  today[symbol] = (spent + amount).toString();
  await db.write([['set', key, today]]);
  return null;
}

/** Gives a reservation back when the transfer did not happen. Call under the lock. */
async function releaseSpend(symbol, amount, key) {
  const db = await store();
  const today = (await db.get(key)) || {};
  const left = BigInt(today[symbol] || '0') - amount;
  today[symbol] = (left < 0n ? 0n : left).toString();
  await db.write([['set', key, today]]);
}

const SWAPS_OFF = 'Swaps are turned off in your Place settings';
// A leaked agent key must not be able to bleed the wallet through badly priced swaps
const AGENT_MAX_SLIPPAGE = 5;

async function send(agent, tx) {
  const p = await privy();
  const res = await p.wallets().ethereum().sendTransaction(agent.walletId, {
    caip2: 'eip155:8453',
    params: {
      transaction: {
        to: getAddress(tx.to),
        data: appendBuilderSuffix(tx.data || '0x'),
        value: `0x${BigInt(tx.value || 0).toString(16)}`,
        chain_id: 8453,
      },
    },
    authorization_context: { authorization_private_keys: [env('PRIVY_AUTHORIZATION_KEY')] },
  });
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: res.hash, timeout: 45_000 });
  } catch {
    // it was sent and may still land: the caller must treat it as spent
    throw Object.assign(new Error('Sent, but Base did not confirm it in time. Check the hash on BaseScan before trying again'), { hash: res.hash, pending: true });
  }
  if (receipt.status !== 'success') throw Object.assign(new Error('Transaction reverted on Base'), { hash: res.hash });
  return res.hash;
}

async function sendAll(agent, txs) {
  const hashes = [];
  for (const tx of txs) hashes.push(await send(agent, tx));
  return hashes;
}

const ACT_USAGE = 'Send {"action":"swap","from":"ETH","to":"0x...","amount":"0.01"} or {"action":"transfer","token":"ETH|USDC|0x...","to":"0x...","amount":"1.5"}';

export async function handleAgentAct({ method, headers = {}, body }) {
  if (method !== 'POST') return json(405, { error: 'Method not allowed' }, { Allow: 'POST' });
  try {
    const agent = await agentFromKey(headers);
    if (!agent) return json(401, { error: 'Missing or revoked agent key: enable the agent in Place → Agent Zone and pass Authorization: Bearer <key>' });
    const req = body && typeof body === 'object' ? body : {};
    const settings = await readSettings(agent.address);

    if (req.action === 'transfer') {
      if (!isAddress(req.to || '') || !/^\d+(\.\d+)?$/.test(String(req.amount || ''))) return json(400, { error: ACT_USAGE });
      let t;
      try {
        t = await tokenFrom(req.token);
      } catch (e) {
        return json(400, { error: e.message });
      }
      const amount = parseUnits(String(req.amount), t.decimals);
      if (amount <= 0n) return json(400, { error: 'Amount must be above zero' });
      const tx = t.address
        ? { to: t.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [getAddress(req.to), amount] }), value: 0n }
        : { to: req.to, data: '0x', value: amount };
      const done = (hash) => json(200, { action: 'transfer', from: agent.address, to: getAddress(req.to), token: t.symbol, tokenAddress: t.address, amount: String(req.amount), hashes: [hash] });

      // to the user's own main wallet: any token, no cap, no lock
      if (agent.mainAddress && lower(req.to) === lower(agent.mainAddress)) return done((await sendAll(agent, [tx]))[0]);

      if (!settings.allow.transfers) return json(403, { error: TRANSFERS_OFF });
      const symbol = Object.keys(CAPPED).find((k) => lower(CAPPED[k].address) === lower(t.address));
      if (!symbol) return json(403, { error: `Only ${Object.keys(CAPPED).join(' and ')} can go to other addresses; ${t.symbol} can be sent to your own main wallet` });
      const db = await store();
      const lockKey = `agent_lock:${lower(agent.address)}`;
      if (!(await db.lock(lockKey, LOCK_SECONDS))) return json(429, { error: BUSY });
      try {
        const key = dayKey(agent.address);
        const limitError = await reserveSpend(settings, symbol, amount, key);
        if (limitError) return json(403, { error: limitError });
        try {
          return done((await sendAll(agent, [tx]))[0]);
        } catch (e) {
          if (!e.pending) await releaseSpend(symbol, amount, key); // not sent, or reverted: nothing left the wallet
          throw e;
        }
      } finally {
        await db.write([['del', lockKey]]).catch(() => {});
      }
    }

    if (req.action === 'swap') {
      if (!settings.allow.swaps) return json(403, { error: SWAPS_OFF });
      if (req.slippage !== undefined && !(Number(req.slippage) > 0 && Number(req.slippage) <= AGENT_MAX_SLIPPAGE)) {
        return json(400, { error: `Agent swaps take a slippage above 0 and at most ${AGENT_MAX_SLIPPAGE}%` });
      }
      const quote = await handleSwap({ method: 'GET', query: { address: agent.address, from: req.from, to: req.to, amount: req.amount, slippage: req.slippage } });
      if (quote.status !== 200) return quote;
      const hashes = await sendAll(agent, quote.body.txs);
      const { tokenIn, tokenOut, amountIn, expectedOut, minimumOut } = quote.body;
      return json(200, { action: 'swap', from: agent.address, tokenIn, tokenOut, amountIn, expectedOut, minimumOut, hashes });
    }

    return json(400, { error: ACT_USAGE });
  } catch (e) {
    return json(e.hash ? 409 : 500, { error: e.message || 'Server error', ...(e.hash ? { hash: e.hash } : {}) });
  }
}
