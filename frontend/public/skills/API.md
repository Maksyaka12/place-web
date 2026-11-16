# Place API reference

Paths are relative to the Place site. Read endpoints are `GET`, public, no auth, JSON.

- **Place hub and Place Launch** run on Base Sepolia (`chain=84532`) during the testnet. `chain` defaults to it.
- **Swaps and the agent wallet** run on Base (`8453`).

A ready transaction is `{ "to": "0x...", "data": "0x...", "value": "<wei>" }`. Send it exactly as returned.

## Campaigns and claims (`/api/place/*`)

### GET /api/place/campaigns?chain=&status=live|upcoming|ended|all[&target=&creator=&kind=&limit=&offset=]
Reward campaigns for token and NFT holders: reward token, pool, target asset, snapshot, claim window, status.

### GET /api/place/campaign?chain=&hub=&id=[&address=]
One campaign. With `address`: whether that wallet is eligible, its amount, proof and whether it has claimed.

### GET /api/place/claims?chain=&address=
Everything a wallet can claim across every campaign.
- `claimable[]` (with `amount` and `proof`), `claimed[]` (with `claimTx`), `expired[]`
- `transactions[]`: one `claimMany` per hub ("Claim all"). Anyone may send it; the rewards always go to `address`.

### GET /api/place/token?chain=&address=
A token or NFT collection: name, symbol, whether it was launched on Place, and its campaigns.

### GET /api/place/collections?chain=[&creator=]
NFT collections created on Place.

### GET /api/place/launch/tokens?chain=
Tokens launched on Place Launch. Also `launch/token`, `launch/candles`, `launch/trades`, `launch/holders`,
`launch/creator`, `launch/stats`.

## Swaps (Base)

### GET /api/swap?address=0x...&from=&to=&amount=[&slippage=1]
Swap any two tokens on Base through KyberSwap.
- `from` / `to`: `ETH`, `USDC`, `WETH`, `cbBTC` or a token address. `amount` = how much of `from` to spend.
- `slippage` in percent (default 1).
- Answer: `tokenIn`, `tokenOut`, `amountIn`, `expectedOut`, `minimumOut`, `router` and `txs`. When paying with a
  token, `txs` starts with an approval for exactly `amount`. The output goes back to `address`. A quote is valid for
  about 20 minutes.

## Agent wallet (Base)

Needs `Authorization: Bearer <agent key>`. The user creates the key in Agent Zone (`/agents`).

### POST /api/agent/act
- `{"action":"swap","from":"ETH","to":"0x...","amount":"0.01","slippage":1}`: swap from the agent wallet.
  Slippage is at most 5%.
- `{"action":"transfer","token":"ETH|USDC|0x...","to":"0x...","amount":"1.5"}`: any token to the user's main
  wallet, with no limit. Only ETH and USDC may go to other addresses, within the user's daily caps.

The answer carries the transaction `hashes` once Base confirms them.

### GET /api/agent
Index of these endpoints.

## Errors
Errors come back as `{ "error": "..." }`:
- 400: bad input
- 401: missing or revoked key
- 403: blocked by the user's settings or caps
- 405: wrong method
- 429: busy, retry in a few seconds
- 5xx: temporary, retry once

Show the message to the user.
