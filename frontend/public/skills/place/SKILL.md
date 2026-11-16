---
name: place
description: Use Place on Base for the user. Find reward campaigns, check eligibility, get claim transactions, swap any token and send funds from the user's agent wallet within the limits they set.
---

# Place

Place is onchain infrastructure for token economies on Base. Projects run reward campaigns for token and NFT holders,
launch tokens with an economy built in, and run staking programs. Users see every campaign in one place and claim
them all at once.

Every path below is relative to the Place site the user sent you this skill from. Full reference: `/skills/API.md`.

## Setup

1. The user enables the agent in Agent Zone (`/agents`) and gives you an agent key (`place_agent_...`).
2. Keep the key private. Send it only in the `Authorization: Bearer <key>` header. Never print it back, put it in a
   URL or store it anywhere the user did not ask for.
3. Never ask for a private key or seed phrase.

## Read (no key)

- Campaigns: `GET /api/place/campaigns?status=live`
- What a wallet can claim: `GET /api/place/claims?address=0x...`. It includes ready `claimMany` transactions.
- A token and its campaigns: `GET /api/place/token?address=0x...`
- Tokens launched on Place: `GET /api/place/launch/tokens`
- A swap quote: `GET /api/swap?address=0x...&from=ETH&to=0x...&amount=0.01`

## Act from the agent wallet (key needed)

`POST /api/agent/act` with `Authorization: Bearer <agent key>` and a JSON body:

- Swap: `{"action":"swap","from":"ETH","to":"0x...","amount":"0.01"}`. Optional `slippage` in percent: 1 by
  default, at most 5.
- Send any token to the user's main wallet: `{"action":"transfer","token":"0x...","to":"<main wallet>","amount":"10"}`
- Send ETH or USDC to another address: the same body with `"token":"ETH"` or `"USDC"`. This is capped per day.

The server signs and sends the transaction, then answers with the hashes. If the user turned an action off, or a
cap is reached, you get a 403 with the reason: tell the user as it is.

## Rules

- Confirm amounts and recipients with the user before you swap or send.
- Campaign rewards always go to the wallet that is eligible, whoever sends the claim.
- Snapshots decide eligibility. Buying after a snapshot does not count for that campaign.
