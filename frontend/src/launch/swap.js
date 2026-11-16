// Buying and selling a launch token on its pool (Uniswap v4 with the Place hook), the same way the L2 live
// run traded: Universal Router V4_SWAP with SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL,
// ERC-20 input through Permit2. Quotes come from Uniswap's V4Quoter, which runs the real swap (hook fee and
// anti-snipe included) and reverts, so the quote is what the pool would pay right now.
import { encodeAbiParameters, encodeFunctionData, encodePacked, maxUint256, parseAbi } from 'viem';

export const ETH = '0x0000000000000000000000000000000000000000';
export const POOL_FEE = 0; // the hook takes the fee; the pool itself charges none
export const TICK_SPACING = 200;

const V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = 0x06;
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

export const V4_QUOTER_ABI = [
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

/**
 * Calls a swap needs, in order: for an ERC-20 input, approve Permit2 once and give the router a Permit2
 * allowance; then the swap. `allowances` = {erc20ToPermit2, permit2Amount, permit2Expiration} read from chain.
 */
export function swapCalls({ d, key, zeroForOne, amountIn, minOut, input, output, deadline, allowances, now, label }) {
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
    data: encodeSwap({ key, zeroForOne, amountIn, minOut, input, output, deadline }),
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
