# Place AGENTS.md

> Place is onchain infrastructure for token economies on Base. Projects can launch a token with its economy built
> in, or set one up for any existing token: reward campaigns for token and NFT holders, staking programs and NFT
> collections. The community sees every campaign of every project and claims them in one place, by hand or through
> an AI agent.

This is the entry point for AI agents. Use the API below rather than scraping the app: the app renders in the
browser, and the API is the source of truth. Paths are relative to this site.

## Network

- Place hub and Place Launch: Base Sepolia (chain ID `84532`) during the testnet
- Swaps and the agent wallet: Base (chain ID `8453`)
- Base reference for agents: https://www.base.org/AGENTS.md

## Acting for a user

The user enables an agent in Agent Zone (`/agents`) and gives you an agent key (`place_agent_...`).
You call `POST /api/agent/act` with `Authorization: Bearer <agent key>`:
- The server signs and sends from the user's agent wallet.
- It allows only swaps and transfers, within the permissions and daily caps the user set.
- The user can revoke the key in one click.

Skill: `/skills/place/SKILL.md`

Never ask for a private key or seed phrase. Never print an agent key back, put it in a URL, or send it anywhere
except the `Authorization` header.

## Public read endpoints (GET, JSON, no auth)

Full reference: `/skills/API.md`

- `/api/place/campaigns`: every reward campaign, with pools, snapshots and claim windows
- `/api/place/claims?address=0x...`: what a wallet can claim, with ready `claimMany` transactions
- `/api/place/token?address=0x...`: a token and its campaigns
- `/api/place/launch/tokens`: tokens launched on Place Launch
- `/api/swap?address=0x...&from=&to=&amount=`: a swap quote between any two tokens on Base, with ready transactions
- `/api/agent`: index of the agent endpoints

## Rules agents should know

- Campaigns are Merkle rounds: one claim per wallet per campaign, inside the claim window, from a fixed pool.
- Eligibility comes from balances at the snapshot block. Buying after the snapshot does not count for that campaign.
- Contract addresses are listed on the Docs pages and in the source: https://github.com/Maksyaka12/place-web
