// Register token: the message a token's creator signs to make an external token a project on Place, and the rules
// the API applies. Shared by the page (src/launch/ui/RegisterTokenPage.jsx) and the API (api/_lib/launch/projects.js).

export const REGISTER_SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;
/** Liquidity a token needs to be a verified project, the same bar as a stock pair. */
export const MIN_PROJECT_LIQUIDITY_USD = 10_000;

/** How the API can tell who created a token: owner() of the token, or admin() (Clanker tokens). */
export const RIGHTS_METHODS = {
  owner: 'owner() of the token contract',
  admin: 'admin() of the token contract (Clanker and similar launchpads)',
  manual: 'checked by hand by the Place team',
};

/** The text the creator's wallet signs. Plain words, so a wallet shows what is being agreed to. */
export function registerMessage({ chainId, token, account, issuedAt }) {
  return [
    'Register a token on Place',
    '',
    `Token: ${String(token).toLowerCase()}`,
    `Creator wallet: ${String(account).toLowerCase()}`,
    `Chain: ${Number(chainId)}`,
    `Issued at: ${issuedAt}`,
    '',
    'This signature costs nothing and sends no transaction.',
  ].join('\n');
}
