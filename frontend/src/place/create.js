// The Launch NFT form's logic, without React: form input into ClubNFT.InitParams for NftFactory.createCollection,
// with the checks the contracts make done up front so the form can explain a problem before the wallet signs.
import { isAddress, getAddress, zeroAddress } from 'viem';
import { parseAmount } from './format.js';

export const DAY = 86400;
/** Uniswap v3 SwapRouter02 for NFT buyback-and-burn, per chain. */
export const SWAP_ROUTER = {
  8453: '0x2626664c2603336E57B271c5C0b26F421741e481',
  84532: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
};

/** "2026-11-20T12:00" from an <input type="datetime-local">, read as UTC → unix seconds (or null). */
export function parseUtcInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(value || ''))) return null;
  const ms = Date.parse(`${value}${value.length === 16 ? ':00' : ''}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

const addr = (v) => (isAddress(String(v || '').trim(), { strict: false }) ? getAddress(String(v).trim()).toLowerCase() : null);

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
