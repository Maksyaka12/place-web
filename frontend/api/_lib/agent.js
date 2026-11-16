// Public agent API (no login, read-only), shared by the Vercel function and the Vite dev server.
//
// GET /api/agent                     what an agent can do on Place, and where
// GET /api/swap?address=&from=&to=&amount=[&slippage=1]
//                                    swap any two tokens on Base through KyberSwap: quote and ready txs
//
// Campaigns, eligibility and claims live in the Place API (/api/place/*); the agent wallet endpoints are in
// ./agentWallet.js.

import { encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import { json } from './common.js';
import { publicClient } from '../../src/config/rpc.js';
import { appendBuilderSuffix } from '../../src/config/builderCode.js';
import { BASE_TOKENS, ERC20_ABI, resolveToken } from '../../src/config/tokens.js';

// Ready txs carry the Base Builder Code themselves, so agents that send them from their own wallet are attributed too.
const encodeTx = (call) => appendBuilderSuffix(encodeFunctionData(call));

function readAddress(query) {
  const raw = String(query.address || '');
  return isAddress(raw) ? getAddress(raw) : null;
}

/** A token by symbol from the default list (ETH, USDC, …) or by address. */
export async function tokenFrom(raw) {
  const s = String(raw || '').trim();
  if (isAddress(s)) return resolveToken(s, publicClient);
  const known = BASE_TOKENS.find((t) => t.symbol.toLowerCase() === s.replace('$', '').toLowerCase());
  if (!known) throw new Error(`Unknown token "${s}": use ${BASE_TOKENS.map((t) => t.symbol).join(', ')} or a token address`);
  return known;
}

/** A positive decimal amount in the token's units, or null. */
export const parseAmount = (raw, decimals) => {
  const s = String(raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    const v = parseUnits(s, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

// ─────────────────────────────── /api/agent ───────────────────────────────

/** Entry point for agents: what they can do, where, and how transactions are returned. */
export async function handleAgentIndex({ method }) {
  if (method !== 'GET') return json(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  return json(200, {
    name: 'Place agent API',
    chain: { name: 'Base', chainId: 8453 },
    howItWorks: 'Read endpoints need no login and return state plus ready transactions { to, data, value, sender } that the agent signs and sends from its own wallet on Base.',
    endpoints: {
      'GET /api/place/campaigns?chain=': 'Every reward campaign on Place: token and NFT holder rewards, pools, snapshots and claim windows.',
      'GET /api/place/claims?chain=&address=': 'What a wallet can claim across every campaign, with ready claim txs.',
      'GET /api/place/token?chain=&address=': 'A token and its campaigns.',
      'GET /api/place/launch/tokens?chain=': 'Tokens launched on Place Launch.',
      'GET /api/swap?address=&from=&to=&amount=[&slippage=1]': 'Swap any two tokens on Base through KyberSwap: quote and ready txs (an approval first when paying with a token). from / to: ETH, USDC, WETH, cbBTC or a token address.',
    },
    agentWallet: {
      howItWorks: 'Every Place account has an agent wallet. After the user enables the agent (Place → Agent Zone) they get an agent key; with it the agent acts from that wallet with no signatures: the server signs and sends, and answers with the tx hashes once mined.',
      auth: 'Authorization: Bearer <agent key>',
      endpoints: {
        'POST /api/agent/act {"action":"swap","from":"ETH","to":"0x…","amount":"0.01","slippage":1}': 'Swap any two tokens; the output comes back to the agent wallet. Slippage is in percent: default 1, at most 5.',
        'POST /api/agent/act {"action":"transfer","token":"ETH|USDC|0x…","to":"0x…","amount":"1.5"}': 'Transfer from the agent wallet: any token, unlimited, to the owner\'s main wallet; ETH and USDC, capped per day, to other addresses.',
      },
    },
  }, { 'Cache-Control': 'public, max-age=300' });
}

// ─────────────────────────────── /api/swap ───────────────────────────────

const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1';
const KYBER_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const KYBER_HEADERS = { 'x-client-id': 'place' };
// The KyberSwap router on Base. A route that points anywhere else is refused, so a bad API answer can never
// receive our users' ETH or a token approval.
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

const SWAP_USAGE = 'Use /api/swap?address=0x...&from=ETH&to=0x...&amount=<amount of `from` to spend>[&slippage=1]';

export async function handleSwap({ method, query = {} }) {
  if (method !== 'GET') return json(405, { error: 'Method not allowed' }, { Allow: 'GET' });
  const account = readAddress(query);
  const slippage = query.slippage !== undefined ? Number(query.slippage) : 1;
  if (!account || !query.from || !query.to || !(slippage > 0 && slippage <= 50)) return json(400, { error: SWAP_USAGE });

  let tokenIn;
  let tokenOut;
  try {
    [tokenIn, tokenOut] = await Promise.all([tokenFrom(query.from), tokenFrom(query.to)]);
  } catch (e) {
    return json(400, { error: e.message });
  }
  if ((tokenIn.address || 'eth').toLowerCase() === (tokenOut.address || 'eth').toLowerCase()) return json(400, { error: 'from and to are the same token' });
  const amountWei = parseAmount(query.amount, tokenIn.decimals);
  if (!amountWei) return json(400, { error: SWAP_USAGE });

  try {
    const inAddr = tokenIn.address || KYBER_ETH;
    const outAddr = tokenOut.address || KYBER_ETH;
    const route = await fetch(`${KYBER}/routes?tokenIn=${inAddr}&tokenOut=${outAddr}&amountIn=${amountWei}`, { headers: KYBER_HEADERS }).then((r) => r.json());
    if (route?.code !== 0 || !route.data?.routeSummary) return json(502, { error: `No swap route: ${route?.message || 'KyberSwap did not answer'}` });
    const built = await fetch(`${KYBER}/route/build`, {
      method: 'POST',
      headers: { ...KYBER_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeSummary: route.data.routeSummary,
        sender: account,
        recipient: account,
        slippageTolerance: Math.round(slippage * 100),
        deadline: Math.floor(Date.now() / 1000) + 20 * 60,
      }),
    }).then((r) => r.json());
    if (built?.code !== 0 || !built.data?.data) return json(502, { error: `Could not build the swap: ${built?.message || 'KyberSwap did not answer'}` });

    const router = built.data.routerAddress || route.data.routerAddress;
    if (String(router || '').toLowerCase() !== KYBER_ROUTER.toLowerCase()) return json(502, { error: 'KyberSwap returned an unknown router, so the swap was not built. Try again later' });
    const txs = [];
    if (tokenIn.address) {
      const allowance = await publicClient.readContract({ address: tokenIn.address, abi: ERC20_ABI, functionName: 'allowance', args: [account, router] });
      if (allowance < amountWei) txs.push({ to: tokenIn.address, data: encodeTx({ abi: ERC20_ABI, functionName: 'approve', args: [router, amountWei] }), value: '0', sender: account });
    }
    txs.push({ to: router, data: appendBuilderSuffix(built.data.data), value: tokenIn.address ? '0' : amountWei.toString(), sender: account });

    const out = BigInt(built.data.amountOut || route.data.routeSummary.amountOut);
    const minOut = out - (out * BigInt(Math.round(slippage * 100))) / 10000n;
    return json(200, {
      address: account,
      tokenIn: { symbol: tokenIn.symbol, address: tokenIn.address },
      tokenOut: { symbol: tokenOut.symbol, address: tokenOut.address },
      amountIn: formatUnits(amountWei, tokenIn.decimals),
      expectedOut: formatUnits(out, tokenOut.decimals),
      minimumOut: formatUnits(minOut, tokenOut.decimals),
      slippagePercent: slippage,
      router,
      txs,
      notes: 'Send the txs in order from this wallet on Base (8453). The quote is valid for about 20 minutes; request a new one after that.',
    }, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json(500, { error: e.message || 'Server error' });
  }
}
