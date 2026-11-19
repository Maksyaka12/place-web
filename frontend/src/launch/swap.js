// Buying and selling a launch token on its pool (Uniswap v4 with the Place hook), the same way the L2 live
// run traded: Universal Router V4_SWAP with SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL,
// ERC-20 input through Permit2. Paying or receiving another asset than the pair (ETH or USDC for a USDC or ETH
// pair, ETH or USDC for a stock pair) runs one multi-hop SWAP_EXACT_IN through the pools the reward-token registry
// lists between that asset and the pair (routeOf), then the launch pool. Quotes come from Uniswap's V4Quoter, which runs the real swap (hook fee and
// anti-snipe included) and reverts, so the quote is what the pool would pay right now.
import { encodeAbiParameters, encodeFunctionData, encodePacked, maxUint256, parseAbi } from 'viem';

export const ETH = '0x0000000000000000000000000000000000000000';
export const POOL_FEE = 0; // the hook takes the fee; the pool itself charges none
export const TICK_SPACING = 200;

const V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = 0x06;
const SWAP_EXACT_IN = 0x07;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const POOL_KEY = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
};

const PATH_KEYS = {
  type: 'tuple[]',
  components: [
    { name: 'intermediateCurrency', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
    { name: 'hookData', type: 'bytes' },
  ],
};

export const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'exactCurrency', type: 'address' },
          { name: 'path', ...PATH_KEYS },
          { name: 'exactAmount', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', ...POOL_KEY },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
];

export const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const lc = (a) => String(a).toLowerCase();
/** The zero address for "eth", else the address itself (API pairs say "eth"). */
export const quoteAddress = (q) => (q === 'eth' || !q ? ETH : lc(q));

/** The pool key of a launch: currencies sorted, fee 0, spacing 200, the Place hook. */
export function poolKey(token, quote, hook) {
  const t = lc(token);
  const q = quoteAddress(quote);
  const [currency0, currency1] = BigInt(t) < BigInt(q) ? [t, q] : [q, t];
  return { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: lc(hook) };
}

/** Which way the swap goes: buying pays the quote, selling pays the token. */
export function swapDirection({ key, side, token }) {
  const input = side === 'buy' ? (lc(key.currency0) === lc(token) ? key.currency1 : key.currency0) : lc(token);
  const output = lc(key.currency0) === lc(input) ? key.currency1 : key.currency0;
  return { input, output, zeroForOne: lc(key.currency0) === lc(input) };
}

/** Amount out for an exact input right now, or throws with the pool's own error. */
export async function quoteExactIn(client, { quoter, key, zeroForOne, amountIn }) {
  const { result } = await client.simulateContract({
    address: quoter,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
  });
  return result[0];
}

/**
 * The path from `from` through `keys` (pool keys in any currency order) as PathKey[], or null when the keys do
 * not lead from `from` to `to`.
 */
export function pathFrom(from, keys, to) {
  let cur = lc(from);
  const path = [];
  for (const k of keys) {
    const c0 = lc(k.currency0);
    const c1 = lc(k.currency1);
    if (cur !== c0 && cur !== c1) return null;
    cur = cur === c0 ? c1 : c0;
    path.push({ intermediateCurrency: cur, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: lc(k.hooks), hookData: '0x' });
  }
  return cur === lc(to) && path.length ? path : null;
}

/**
 * A route for a swap: `single` (the launch pool alone, SWAP_EXACT_IN_SINGLE) or `path` (hops then the launch pool,
 * or the launch pool then hops). `hops` are the registry's pool keys between the asset and the pair (empty = direct).
 * Returns null when the hops do not connect.
 */
export function swapRoute({ key, side, token, pair, asset, hops }) {
  const t = lc(token);
  const p = quoteAddress(pair);
  const a = quoteAddress(asset);
  if (a === p) {
    const dir = swapDirection({ key, side, token: t });
    return { kind: 'single', key, zeroForOne: dir.zeroForOne, input: dir.input, output: dir.output, external: [] };
  }
  if (!hops?.length) return null;
  const launch = [{ intermediateCurrency: t, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: '0x' }];
  if (side === 'buy') {
    const toPair = pathFrom(a, hops, p);
    if (!toPair) return null;
    return { kind: 'path', input: a, output: t, path: [...toPair, ...launch], external: toPair.map((h) => h.fee) };
  }
  const fromPair = pathFrom(p, hops, a);
  if (!fromPair) return null;
  const sell = [{ intermediateCurrency: p, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: '0x' }];
  return { kind: 'path', input: t, output: a, path: [...sell, ...fromPair], external: fromPair.map((h) => h.fee) };
}

/** { amountOut, gasEstimate } for an exact input along a route, or throws with the pool's own error. */
export async function quoteRoute(client, { quoter, route, amountIn }) {
  if (route.kind === 'single') {
    const { result } = await client.simulateContract({
      address: quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: route.key, zeroForOne: route.zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    });
    return { amountOut: result[0], gasEstimate: result[1] };
  }
  const { result } = await client.simulateContract({
    address: quoter,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [{ exactCurrency: route.input, path: route.path, exactAmount: amountIn }],
  });
  return { amountOut: result[0], gasEstimate: result[1] };
}

/** minOut after slippage (bps). */
export const withSlippage = (amountOut, slippageBps) => (BigInt(amountOut) * BigInt(10_000 - slippageBps)) / 10_000n;

/** Calldata for UniversalRouter.execute: one exact-in single-pool swap. */
export function encodeSwap({ key, zeroForOne, amountIn, minOut, input, output, deadline }) {
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const params = [
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'poolKey', ...POOL_KEY },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }]
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input, amountIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [output, minOut]),
  ];
  const inputs = [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])];
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [V4_SWAP, inputs, BigInt(deadline)] });
}

/** Calldata for UniversalRouter.execute: one exact-in multi-hop swap along `path` (PathKey[]). */
export function encodeSwapPath({ path, amountIn, minOut, input, output, deadline }) {
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL]);
  const params = [
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currencyIn', type: 'address' },
            { name: 'path', ...PATH_KEYS },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
          ],
        },
      ],
      [{ currencyIn: input, path, amountIn, amountOutMinimum: minOut }]
    ),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input, amountIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [output, minOut]),
  ];
  const inputs = [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params])];
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: [V4_SWAP, inputs, BigInt(deadline)] });
}

/**
 * Calls a swap needs, in order: for an ERC-20 input, approve Permit2 once and give the router a Permit2
 * allowance; then the swap. `allowances` = {erc20ToPermit2, permit2Amount, permit2Expiration} read from chain.
 */
export function swapCalls({ d, key, zeroForOne, path, amountIn, minOut, input, output, deadline, allowances, now, label }) {
  const calls = [];
  if (lc(input) !== ETH) {
    if (BigInt(allowances?.erc20ToPermit2 ?? 0n) < amountIn) {
      calls.push({ label: 'Allow Permit2 to move the token', to: input, abi: ERC20_ABI, functionName: 'approve', args: [d.permit2, maxUint256] });
    }
    const expired = Number(allowances?.permit2Expiration ?? 0) <= now + 60;
    if (expired || BigInt(allowances?.permit2Amount ?? 0n) < amountIn) {
      calls.push({
        label: 'Allow the router to swap this amount',
        to: d.permit2,
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [input, d.universalRouter, amountIn, now + 30 * 86400],
      });
    }
  }
  calls.push({
    label,
    to: d.universalRouter,
    data: path ? encodeSwapPath({ path, amountIn, minOut, input, output, deadline }) : encodeSwap({ key, zeroForOne, amountIn, minOut, input, output, deadline }),
    value: lc(input) === ETH ? amountIn : 0n,
  });
  return calls;
}

/**
 * Anti-snipe: the total fee starts at `startRate` and falls linearly to 1% over `window`
 * seconds after launch. Returns the fee in percent at `now` and the seconds left, or null once it is over.
 */
export function antiSnipe({ launchTime, startRate, windowSeconds, rateScale, baseRatePct = 1 }, now) {
  const end = Number(launchTime) + Number(windowSeconds);
  if (!launchTime || !windowSeconds || now >= end) return null;
  const start = (Number(startRate) / Number(rateScale)) * 100;
  const done = Math.max(0, now - Number(launchTime)) / Number(windowSeconds);
  return { feePct: start - (start - baseRatePct) * done, secondsLeft: end - now };
}

/** routeData for a dev buy paid in the pair asset itself (no hops before the launch pool). */
export const DIRECT_ROUTE = encodeAbiParameters([{ type: 'tuple[]', components: POOL_KEY.components }], [[]]);
