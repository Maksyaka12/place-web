// Launch address prediction and vanity salt mining. Pure functions, no network: the same
// code runs in the API and in the browser.
//
// The factory scopes every salt to its creator: scopedSalt = keccak256(abi.encode(creator, creatorSalt)).
//   ERC-20  CREATE2 by the token deployer: keccak256(0xff ‖ deployer ‖ scopedSalt ‖ initCodeHash)[12:]
//           (initCodeHash depends on name, symbol, URI, metadata: ask factory.launchTokenInitCodeHash(params))
//   B20     the precompile: 0xB2 ‖ 9 zero bytes ‖ variant ‖ keccak256(abi.encode(factory, scopedSalt))[0:9]
//   vault   OpenZeppelin Clones.cloneDeterministic(implementation, scopedSalt) deployed by the factory
// The factory only accepts token addresses whose last byte is TOKEN_ADDRESS_SUFFIX (0x01).
import { keccak256, encodeAbiParameters, concat, getAddress, toHex } from 'viem';
import { TOKEN_ADDRESS_SUFFIX } from './deployments.js';

const B20_ASSET_VARIANT = 0;

export function scopedSalt(creator, creatorSalt) {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, creatorSalt]));
}

export function create2Address(deployer, salt, initCodeHash) {
  return `0x${keccak256(concat(['0xff', deployer, salt, initCodeHash])).slice(26)}`;
}

export function b20Address(factory, salt, variant = B20_ASSET_VARIANT) {
  const h = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [factory, salt]));
  return `0xb2${'00'.repeat(9)}${variant.toString(16).padStart(2, '0')}${h.slice(2, 20)}`;
}

/** OpenZeppelin v5 Clones (EIP-1167) init code hash for `implementation`. */
export function cloneInitCodeHash(implementation) {
  return keccak256(
    concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementation.toLowerCase(), '0x5af43d82803e903d91602b57fd5bf3'])
  );
}

/** Token and vault addresses for one creatorSalt. `kind` is 'b20' or 'erc20' (erc20 needs initCodeHash). */
export function predictLaunch({ kind, creator, creatorSalt, factory, tokenDeployer, vaultImplementation, initCodeHash }) {
  const salt = scopedSalt(creator, creatorSalt);
  const token = kind === 'b20' ? b20Address(factory, salt) : create2Address(tokenDeployer, salt, initCodeHash);
  return {
    scopedSalt: salt,
    token: token.toLowerCase(),
    vault: create2Address(factory, salt, cloneInitCodeHash(vaultImplementation)).toLowerCase(),
  };
}

/** Lowercase hex the token address must end with: the desired `suffix` (hex, optional) plus the factory's 01. */
export function requiredEnding(suffix = '') {
  const s = String(suffix).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(s)) throw new Error('suffix must be hex');
  const must = TOKEN_ADDRESS_SUFFIX.toString(16).padStart(2, '0');
  return s.endsWith(must) ? s : `${s}${must}`;
}

/**
 * Tries creatorSalts from `start` until the token address ends with `ending` (requiredEnding). Returns the
 * first hit, or null after `maxTries`. Expected tries: 16^(ending length).
 */
export function mineSalt({ ending, start = 0n, maxTries = 2_000_000, ...p }) {
  const end = ending.toLowerCase();
  let n = BigInt(start);
  for (let i = 0; i < maxTries; i++, n++) {
    const creatorSalt = toHex(n, { size: 32 });
    const r = predictLaunch({ ...p, creatorSalt });
    if (r.token.endsWith(end)) return { creatorSalt, ...r, tries: i + 1, token: r.token, tokenChecksum: getAddress(r.token) };
  }
  return null;
}
