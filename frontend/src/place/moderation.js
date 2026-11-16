// The text an admin signs to hide or show something on the Place storefront (moderation never
// touches funds). The API rebuilds it from the request, so the site and the server must use this function.
export function moderationMessage({ admin, chainId, action, type, target, issuedAt }) {
  return [
    'Place: storefront moderation',
    `Admin: ${String(admin).toLowerCase()}`,
    `Chain: ${chainId}`,
    `Action: ${action} ${type}`,
    `Target: ${String(target).toLowerCase()}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

// Wallets allowed to moderate when the server has no PLACE_ADMINS env. The site uses the same list to show
// the Admin page; the API checks the signature, so showing the page grants nothing.
export const DEFAULT_ADMINS = ['0x4c91d3bed372c11795b9ce9a9017dfe447bf050a'];

export const isPlaceAdmin = (address, admins = DEFAULT_ADMINS) =>
  Boolean(address) && admins.includes(String(address).toLowerCase());
