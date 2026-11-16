# Place

**All in one place.** Onchain infrastructure on Base for token economies. Anyone can launch a token with its economy
built in, or set one up for any existing token: reward campaigns for token and NFT holders, staking programs and NFT
collections. The community sees every campaign of every project and claims them in one place, by hand or through an
AI agent.

- **Place hub:** holder and NFT-holder reward campaigns for any token on Base (`PlaceHub`), NFT collections
  (`NftFactory`), one "Claim all" across every project.
- **Place Launch:** a token launchpad where the economy is a contract, not a promise. A fixed 1% swap fee: 70% to the
  creator's vault (split into creator, burn and community fund), 30% to the platform. Contracts live in
  [place-contracts](https://github.com/Maksyaka12/place-contracts).

Status: **testnet** (Base Sepolia). Not audited yet.

## Structure

```
contracts/     Hub contracts (Foundry): PlaceConfig, PlaceHub, ClubNFT, NftFactory; see contracts/README.md
frontend/      The app (React + Vite), deployed on Vercel
  api/         Serverless functions: Place API, indexer, snapshot service, launch keeper, agent API
  public/      Static assets and the published agent skills
  src/         UI (src/themes/place, src/launch), hooks, config, snapshot engine
docs/
  DESIGN.md    Design system: one UI, two themes (Dark and Based)
```

## Run locally

```bash
cd frontend
npm install
npm run dev
```

The app runs without any configuration. The variables for the API and agent features are listed in
[frontend/.env.example](frontend/.env.example).

Every transaction the app sends, or asks a wallet to send, carries Place's Base Builder Code (ERC-8021) from
[frontend/src/config/builderCode.js](frontend/src/config/builderCode.js).

## Tests

Every push runs these checks on GitHub.

```bash
cd frontend
npm ci
npm run lint
npm test
npm run build
```

Contracts use Foundry; dependency setup is in [contracts/README.md](contracts/README.md).

```bash
cd contracts
forge test --no-match-contract Fork
```

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
