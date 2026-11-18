// The Rewards hub create form, without React: checks the fields and builds the transaction.
//   staking   PlaceStaking.createVault (epochs of whole days), reward + fee paid up front
//   holders   PlaceRewardsDistributor.createStream, kind Holders, criterion = minimum balance (token units)
//   traders   createStream, kind Traders, criterion = minimum daily volume in the pair asset (Place 0.3.0 launches)
//   nft       createStream, kind Holders with the collection address, criterion = minimum NFT count
//             (collections made by the Place NFT factory; the daily table counts ownerOf at the end of the day)
// Paid from a wallet (approve + create) or, for the creator of a Place token, from its Community Pool
// (GET launch/fund-quote returns the fundCampaign / fundStaking call; NFT rewards cannot come from the pool).
import { formatUnits, getAddress, isAddress } from 'viem';
import { parseAmount } from '../place/format.js';
import { REWARDS_DISTRIBUTOR_ABI, PLACE_STAKING_ABI } from './abi.js';

export const EPOCH = 86_400;
export const MAX_DAYS = 365;
export const MAX_START_DELAY_DAYS = 90; // PlaceRewardsDistributor.MAX_START_DELAY_EPOCHS
export const HUB_KIND_ID = { holders: 0, traders: 1, nft: 0 };
export const CREATE_TYPES = ['staking', 'holders', 'traders', 'nft'];
const ETH = '0x0000000000000000000000000000000000000000';

const addr = (v) => (isAddress(String(v || '').trim(), { strict: false }) ? getAddress(String(v).trim()).toLowerCase() : null);
const int = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN);

/** "2026-11-18" → UTC day number, or null. */
export function utcDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000 / EPOCH) : null;
}
export const dayText = (epoch) => new Date(epoch * EPOCH * 1000).toISOString().slice(0, 10);

/** Fee on top, rounded up like the contracts (Math.Rounding.Ceil). */
export const feeOf = (total, bps) => (BigInt(total) * BigInt(bps) + 9_999n) / 10_000n;

/**
 * f: { type, token, funding: 'wallet'|'pool', reward: 'eth'|address, amount, days, startDay, criterion,
 *      epochDays, earlyExit, penaltyPct, slippagePct }
 * ctx: { now (unix s), asset (GET launch/hub/asset or null), rewardMeta ({ decimals, isNft } or null),
 *        streamFeeBps, stakingFeeBps, stakingFeeVersion, distributor, staking }
 * Returns { errors, perEpoch, total, fee, pay, value, rewardToken, spender, call } for a wallet, or
 * { errors, fundQuery } for the Community Pool.
 */
export function planHubCreate(f, ctx) {
  const errors = {};
  const type = CREATE_TYPES.includes(f.type) ? f.type : null;
  if (!type) errors.type = 'Pick what to reward';
  const token = addr(f.token);
  const asset = ctx.asset;
  if (!token) errors.token = type === 'nft' ? 'Enter the collection address' : 'Enter the token address';
  else if (asset && type && !asset.allowed?.[type]) errors.token = asset.reasons?.[type] || 'Not available for this token';
  const pool = f.funding === 'pool';
  if (pool) {
    if (type === 'nft') errors.funding = 'NFT holder rewards are paid from a wallet, not from a Community Pool';
    else if (asset && !asset.pool?.available) errors.funding = 'This token has no Community Pool';
    else if (asset && !asset.pool?.isCreator) errors.funding = 'Only the token’s creator can spend its Community Pool';
    else if (asset && type && !asset.pool.types.includes(type)) errors.funding = 'The Community Pool cannot fund this type';
  }

  const staking = type === 'staking';
  const count = int(f.days);
  if (!(count >= 1 && count <= MAX_DAYS)) errors.days = staking ? `1 to ${MAX_DAYS} epochs` : `1 to ${MAX_DAYS} days`;
  const epochDays = staking ? int(f.epochDays || 1) : 1;
  if (staking && !(epochDays >= 1 && epochDays <= 30)) errors.epochDays = '1 to 30 days';

  const current = Math.floor(ctx.now / EPOCH);
  const startEpoch = utcDay(f.startDay);
  if (startEpoch == null) errors.startDay = 'Pick a start day';
  else if (staking ? startEpoch * EPOCH <= ctx.now : startEpoch < current) errors.startDay = staking ? 'Staking starts at 00:00 UTC of a future day' : 'The start day has passed';
  else if (startEpoch > current + MAX_START_DELAY_DAYS) errors.startDay = `At most ${MAX_START_DELAY_DAYS} days ahead`;

  // The condition, in the units the contract stores.
  let criterion = 0n;
  if (type === 'nft') {
    const n = f.criterion === '' || f.criterion == null ? 1 : int(f.criterion);
    if (!(n >= 1 && n <= 10_000)) errors.criterion = 'A whole number of NFTs, at least 1';
    else criterion = BigInt(n);
  } else if (type === 'holders' || type === 'traders') {
    const decimals = type === 'traders' ? asset?.place?.quote?.decimals ?? 18 : asset?.decimals ?? 18;
    const v = String(f.criterion ?? '').trim() === '' ? 0n : parseAmount(f.criterion, decimals);
    if (v == null) errors.criterion = 'Enter a number';
    else criterion = v;
  }

  let earlyExitMode = 0;
  let penaltyBps = 0;
  if (staking && f.earlyExit) {
    const pct = Number(f.penaltyPct);
    if (!(pct > 0 && pct < 100)) errors.penaltyPct = 'Between 0 and 100%';
    else {
      earlyExitMode = 1;
      penaltyBps = Math.round(pct * 100);
    }
  }

  const reward = f.reward === 'eth' ? 'eth' : addr(f.reward);
  if (!reward) errors.reward = 'Pick the reward token';
  else if (ctx.rewardMeta?.isNft) errors.reward = 'Rewards are paid in ETH or an ERC-20 token';

  if (pool) {
    const quote = asset?.place?.quote;
    const amountIn = parseAmount(f.amount, quote?.decimals ?? 18);
    if (!amountIn) errors.amount = 'Enter how much of the pool to spend';
    const slippageBps = Math.round(Number(f.slippagePct || 1) * 100);
    if (!(slippageBps >= 10 && slippageBps <= 2000)) errors.slippagePct = '0.1 to 20%';
    const fundQuery =
      Object.keys(errors).length || !token
        ? null
        : {
            token,
            rewardToken: reward,
            amountIn: amountIn.toString(),
            kind: type,
            epochCount: String(count),
            slippageBps: String(slippageBps),
            ...(staking
              ? { startTime: String(startEpoch * EPOCH), epochDuration: String(epochDays * EPOCH), earlyExit: earlyExitMode ? '1' : '0', penaltyBps: String(penaltyBps) }
              : { startEpoch: String(startEpoch), criterion: criterion.toString() }),
          };
    return { errors, fundQuery };
  }

  const decimals = reward === 'eth' ? 18 : ctx.rewardMeta?.decimals;
  const units = decimals == null ? null : parseAmount(f.amount, decimals);
  if (!units) errors.amount = decimals == null && reward ? 'Waiting for the reward token' : 'Enter the reward pool';
  const perEpoch = units && count >= 1 ? units / BigInt(count) : 0n;
  if (units && count >= 1 && perEpoch === 0n) errors.amount = 'Too small to split over these days';
  const total = perEpoch * BigInt(count >= 1 ? count : 0);
  const feeBps = staking ? ctx.stakingFeeBps : ctx.streamFeeBps;
  if (feeBps == null) errors.form = 'Reading the Place fee...';
  if (staking && ctx.stakingFeeVersion == null) errors.form = 'Reading the Place fee...';
  const fee = feeBps == null ? 0n : feeOf(total, feeBps);
  const pay = total + fee;
  const rewardToken = reward === 'eth' ? ETH : reward;
  const spender = staking ? ctx.staking : ctx.distributor;
  if (!spender) errors.form = staking ? 'Staking is not deployed on this network' : 'Rewards are not deployed on this network';
  const value = reward === 'eth' ? pay : 0n;
  let call = null;
  if (!Object.keys(errors).length) {
    call = staking
      ? {
          label: 'Create staking vault',
          to: spender,
          abi: PLACE_STAKING_ABI,
          functionName: 'createVault',
          args: [
            { stakingToken: token, rewardCurrency: rewardToken, startTime: BigInt(startEpoch * EPOCH), epochDuration: BigInt(epochDays * EPOCH), epochCount: BigInt(count), rewardPerEpoch: perEpoch, earlyExitMode, penaltyBps },
            BigInt(ctx.stakingFeeVersion),
          ],
          value,
        }
      : {
          label: type === 'nft' ? 'Create NFT holder rewards' : type === 'traders' ? 'Create trader rewards' : 'Create holder rewards',
          to: spender,
          abi: REWARDS_DISTRIBUTOR_ABI,
          functionName: 'createStream',
          args: [{ token, kind: HUB_KIND_ID[type], rewardToken, startEpoch: BigInt(startEpoch), epochCount: BigInt(count), rewardPerEpoch: perEpoch, criterion, metadataURI: '' }],
          value,
        };
  }
  return { errors, perEpoch, total, fee, pay, value, rewardToken, spender, call, startEpoch, count, epochDays };
}

// ─────────────────────────────── form helpers (preview and pickers) ───────────────────────────────

/**
 * The schedule the form previews: start and end at 00:00 UTC, the number of epochs and their length in days.
 * Holders, traders and NFT holders run in one-day epochs; staking epochs last `epochDays`. Null until the fields
 * make sense.
 */
export function createSchedule({ type, startDay, days, epochDays }) {
  const start = utcDay(startDay);
  const count = int(days);
  const length = type === 'staking' ? int(epochDays || 1) : 1;
  if (start == null || !(count >= 1 && count <= MAX_DAYS) || !(length >= 1)) return null;
  const end = start + count * length;
  return { startEpoch: start, endEpoch: end, epochs: count, epochDays: length, startsAt: start * EPOCH * 1000, endsAt: end * EPOCH * 1000, totalDays: count * length };
}

/** "Reward per epoch" of a staking vault as the pool the form sends: per epoch × epochs, in plain units ('' when unknown). */
export function poolFromPerEpoch(perEpoch, epochs, decimals) {
  const n = int(epochs);
  if (decimals == null || !(n >= 1)) return '';
  const per = parseAmount(perEpoch, decimals);
  if (!per) return '';
  return formatUnits(per * BigInt(n), decimals);
}

/** Picker tab of a pair asset: ETH, USDC and other main assets under Majors, tokenized stocks under Stocks. */
const pairTab = (p) => (p.category === 'stocks' ? 'stocks' : 'majors');

/**
 * Reward currencies a wallet can pay in, in the shape of the reward token picker: ETH, every launch pair asset and
 * the token itself (not for NFT collections). Any other ERC-20 is added by pasting its address in the picker.
 */
export function walletRewardOptions({ pairs = [], token = null, asset = null }) {
  const list = [{ address: 'eth', symbol: 'ETH', name: 'Ether', decimals: 18, source: 'pair', category: 'majors' }];
  for (const p of pairs) {
    if (!p?.symbol || p.address === 'eth' || list.some((x) => x.address === p.address)) continue;
    list.push({ address: p.address, symbol: p.symbol, name: p.name, decimals: p.decimals, source: 'pair', category: pairTab(p) });
  }
  const self = token && asset && !asset.isNft ? String(token).toLowerCase() : null;
  if (self && !list.some((x) => x.address === self)) {
    list.push({ address: self, symbol: asset.symbol, name: asset.name, decimals: asset.decimals, source: 'token', category: 'crypto', contractURI: asset.place?.contractURI ?? null, placeLaunch: Boolean(asset.place) });
  }
  return list;
}

/**
 * Reward currencies the Community Pool can pay in (`launch/reward-tokens` of the token's pair): the pair asset with
 * no swap, the token itself bought in its own pool, and every listed route. 'self' becomes the token's address.
 */
export function poolRewardOptions(tokens = [], token = null, asset = null) {
  const self = token ? String(token).toLowerCase() : null;
  return tokens
    .map((t) => (t.source === 'self' ? (self ? { ...t, address: self, symbol: asset?.symbol ?? null, name: asset?.name ?? null, decimals: asset?.decimals ?? 18, source: 'token', category: 'crypto', placeLaunch: true } : null) : t))
    .filter(Boolean);
}
