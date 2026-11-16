// The Create form's logic, without React: turning form input into the rules document, the createCampaign
// parameters and the createCollection parameters, with every check the contracts make done up front, so
// the form can explain a problem before the wallet is asked to sign (§4.3, §4.5).
import { isAddress, getAddress, zeroAddress } from 'viem';
import { buildRules, encodeRules, KIND_ID } from './snapshot/rules.js';
import { parseAmount } from './format.js';

export const DAY = 86400;
export const MAX_CLAIM_DAYS = 365;
export const MAX_SCHEDULE_AHEAD = 365 * DAY;
/** Uniswap v3 SwapRouter02 for NFT buyback-and-burn, per chain. */
export const SWAP_ROUTER = {
  8453: '0x2626664c2603336E57B271c5C0b26F421741e481',
  84532: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
};

/** Fee exactly as PlaceHub computes it: floor(pool × bps / 10 000). */
export const campaignFee = (pool, feeBps) => (BigInt(pool) * BigInt(feeBps)) / 10000n;

/** "2026-11-20T12:00" from an <input type="datetime-local">, read as UTC → unix seconds (or null). */
export function parseUtcInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(value || ''))) return null;
  const ms = Date.parse(`${value}${value.length === 16 ? ':00' : ''}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** The value for an <input type="datetime-local"> showing `seconds` in UTC. */
export function toUtcInput(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}

/** One address per line, comma or space; returns { addresses (lowercase, unique), bad (the rest) }. */
export function parseAddressList(text) {
  const parts = String(text || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const addresses = [];
  const bad = [];
  for (const p of parts) {
    if (isAddress(p, { strict: false })) addresses.push(p.toLowerCase());
    else bad.push(p);
  }
  return { addresses: [...new Set(addresses)], bad };
}

const addr = (v) => (isAddress(String(v || '').trim(), { strict: false }) ? getAddress(String(v).trim()).toLowerCase() : null);

/**
 * Checks the Holder Rewards form and builds what goes on-chain.
 * @param {object} f   form values (strings), see CreateCampaignForm
 * @param {object} ctx { chainId, hub, now (unix s), feeBps, targetDecimals, rewardDecimals, isNftTarget }
 * @returns {{ errors: Record<string,string>, rules?, params?, pool?, fee?, due? }}
 */
export function planCampaign(f, ctx) {
  const errors = {};
  const kind = f.kind === 'nft-holders' ? 'nft-holders' : 'token-holders';
  const target = addr(f.target);
  if (!target) errors.target = 'Enter the token or collection address';
  else if (kind === 'nft-holders' && ctx.isNftTarget === false) errors.target = 'This contract is not an ERC-721 collection';
  else if (kind === 'token-holders' && ctx.isNftTarget === true) errors.target = 'This is an NFT collection: choose NFT Holder Rewards';

  const eth = !f.rewardToken || f.rewardToken === 'eth';
  const rewardToken = eth ? 'eth' : addr(f.rewardToken);
  if (!rewardToken) errors.rewardToken = 'Enter the reward token address, or pick ETH';
  const rewardDecimals = eth ? 18 : ctx.rewardDecimals;
  if (rewardToken && !eth && rewardDecimals == null) errors.rewardToken = 'Could not read this token: is it an ERC-20 on this network?';

  const pool = rewardDecimals != null ? parseAmount(f.pool, rewardDecimals) : null;
  if (pool == null || pool <= 0n) errors.pool = 'Enter the pool amount';

  let minBalance = null;
  if (kind === 'nft-holders') {
    minBalance = /^\d+$/.test(String(f.minBalance || '').trim()) ? BigInt(f.minBalance.trim()) : null;
    if (minBalance == null || minBalance < 1n) errors.minBalance = 'At least 1 NFT';
  } else {
    minBalance = ctx.targetDecimals != null ? parseAmount(f.minBalance, ctx.targetDecimals) : null;
    if (minBalance == null || minBalance <= 0n) errors.minBalance = 'Enter the minimum balance to qualify';
  }

  let maxPerWallet = null;
  if (String(f.maxPerWallet || '').trim()) {
    maxPerWallet = rewardDecimals != null ? parseAmount(f.maxPerWallet, rewardDecimals) : null;
    if (maxPerWallet == null || maxPerWallet <= 0n) errors.maxPerWallet = 'Enter an amount, or leave empty for no limit';
    else if (pool && maxPerWallet > pool) errors.maxPerWallet = 'The limit is bigger than the whole pool';
  }

  const snapshotAt = parseUtcInput(f.snapshotAt);
  if (!snapshotAt) errors.snapshotAt = 'Pick the snapshot date and time (UTC)';
  else if (snapshotAt <= ctx.now + 60) errors.snapshotAt = 'The snapshot must be in the future';
  else if (snapshotAt > ctx.now + MAX_SCHEDULE_AHEAD) errors.snapshotAt = 'At most 365 days ahead';

  const days = Number(f.claimDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_CLAIM_DAYS) errors.claimDays = 'From 1 to 365 days';

  const excl = parseAddressList(f.exclude);
  if (excl.bad.length) errors.exclude = `Not an address: ${excl.bad.slice(0, 3).join(', ')}`;
  const exclude = [...new Set([...excl.addresses, ...(f.excludeChecked || []).map((a) => a.toLowerCase())])];

  if (!String(f.name || '').trim()) errors.name = 'Give the campaign a name';
  else if (f.name.trim().length > 80) errors.name = 'At most 80 characters';
  if (String(f.description || '').length > 2000) errors.description = 'At most 2,000 characters';
  if (ctx.feeBps == null) errors.form = 'Reading the Place fee from the network...';

  if (Object.keys(errors).length) return { errors };

  const rules = buildRules({
    chainId: ctx.chainId,
    hub: ctx.hub,
    kind,
    target,
    rewardToken,
    pool,
    snapshotAt,
    claimDuration: days * DAY,
    minBalance,
    distribution: f.distribution === 'equal' ? 'equal' : 'proportional',
    maxPerWallet,
    exclude,
    leftover: f.leftover === 'burn' ? 'burn' : 'return',
  });
  const { rulesHash } = encodeRules(rules);
  const fee = campaignFee(pool, ctx.feeBps);
  return {
    errors,
    rules,
    rulesHash,
    pool,
    fee,
    due: pool + fee,
    eth,
    params: {
      kind: KIND_ID[kind],
      target,
      rewardToken: eth ? zeroAddress : rewardToken,
      pool,
      snapshotAt: BigInt(snapshotAt),
      claimDuration: days * DAY,
      burnLeftover: rules.leftover === 'burn',
      rulesHash,
      // rulesURI and metadataURI are filled in after the uploads
    },
  };
}

/**
 * A pool that cannot be handed out: every eligible wallet hits the per-wallet limit. Returns the
 * raw amount that would be left over, or 0n.
 */
export function cappedLeftover({ pool, maxPerWallet, wallets }) {
  if (!maxPerWallet || !wallets) return 0n;
  const most = BigInt(maxPerWallet) * BigInt(wallets);
  return most < BigInt(pool) ? BigInt(pool) - most : 0n;
}

/** Checks the NFT Collection form and builds ClubNFT.InitParams for NftFactory.createCollection. */
export function planCollection(f, ctx) {
  const errors = {};
  const name = String(f.name || '').trim();
  const symbol = String(f.symbol || '').trim();
  if (!name) errors.name = 'Enter the collection name';
  if (!symbol) errors.symbol = 'Enter a short symbol';
  else if (symbol.length > 11) errors.symbol = 'At most 11 characters';
  const maxSupply = Number(f.maxSupply);
  if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 4_294_967_295) errors.maxSupply = 'A whole number of NFTs, at least 1';
  const maxPerWallet = String(f.maxPerWallet || '').trim() === '' ? 0 : Number(f.maxPerWallet);
  if (!Number.isInteger(maxPerWallet) || maxPerWallet < 0) errors.maxPerWallet = 'A whole number, or empty for no limit';

  const eth = !f.paymentToken || f.paymentToken === 'eth';
  const paymentToken = eth ? zeroAddress : addr(f.paymentToken);
  if (!paymentToken) errors.paymentToken = 'Enter the payment token address, or pick ETH';
  const decimals = eth ? 18 : ctx.paymentDecimals;
  if (!eth && paymentToken && decimals == null) errors.paymentToken = 'Could not read this token on this network';
  const price = decimals != null ? parseAmount(f.price || '0', decimals) : null;
  if (price == null) errors.price = 'Enter the mint price (0 for a free mint)';

  const mintStart = String(f.mintStart || '').trim() ? parseUtcInput(f.mintStart) : ctx.now;
  if (mintStart == null) errors.mintStart = 'Pick the date and time (UTC), or leave empty to start now';

  const payout = addr(f.payout);
  if (!payout) errors.payout = 'Where mint revenue goes';

  const burnPct = String(f.burnPct || '').trim() === '' ? 0 : Number(f.burnPct);
  if (!(burnPct >= 0 && burnPct <= 100)) errors.burnPct = 'From 0 to 100%';
  const burnBps = Math.round(burnPct * 100);
  let burnToken = zeroAddress;
  let swapRouter = zeroAddress;
  if (burnBps > 0) {
    burnToken = addr(f.burnToken);
    if (!burnToken) errors.burnToken = 'The token to buy back and burn';
    else if (burnToken !== paymentToken) {
      swapRouter = SWAP_ROUTER[ctx.chainId] || null;
      if (!swapRouter) errors.burnToken = 'No swap router on this network: pay with the burn token itself';
    }
  }
  const swapPoolFee = [100, 500, 3000, 10000].includes(Number(f.swapPoolFee)) ? Number(f.swapPoolFee) : 3000;

  const royaltyPct = String(f.royaltyPct || '').trim() === '' ? 0 : Number(f.royaltyPct);
  if (!(royaltyPct >= 0 && royaltyPct <= 10)) errors.royaltyPct = 'From 0 to 10%';
  const royaltyReceiver = royaltyPct > 0 ? addr(f.royaltyReceiver || f.payout) : zeroAddress;
  if (royaltyPct > 0 && !royaltyReceiver) errors.royaltyReceiver = 'Who receives royalties';

  const baseURI = String(f.baseURI || '').trim();
  if (baseURI && !/^(ipfs|https?):\/\//.test(baseURI)) errors.baseURI = 'An ipfs:// or https:// address';
  if (ctx.deployFee == null) errors.form = 'Reading the deploy fee from the network...';

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    fee: BigInt(ctx.deployFee),
    params: {
      name,
      symbol,
      maxSupply,
      maxPerWallet,
      paymentToken,
      price,
      mintStart: BigInt(mintStart),
      payout,
      burnBps,
      burnToken,
      swapRouter,
      swapPoolFee,
      baseURI,
      contractURI: f.contractURI || '',
      royaltyReceiver,
      royaltyBps: BigInt(Math.round(royaltyPct * 100)),
    },
  };
}
