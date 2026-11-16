// Database schema for Place, as ordered migrations. Applied by `npm run db:migrate` (scripts/migrate.mjs),
// never at request time. Add a new entry to change the schema; never edit an applied one.
//
// Conventions: addresses and hashes are lowercase 0x text; token amounts are numeric(78,0) (any uint256);
// on-chain times are timestamptz.
export const MIGRATIONS = [
  {
    name: '001_init',
    sql: `
create table indexer_cursors (
  chain_id   integer not null,
  contract   text    not null,
  last_block bigint  not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, contract)
);

create table campaigns (
  pk              bigserial primary key,
  chain_id        integer not null,
  hub             text    not null,
  campaign_id     bigint  not null,
  creator         text    not null,
  kind            smallint not null check (kind in (0, 1)),
  target          text    not null,
  reward_token    text    not null,
  pool            numeric(78,0) not null,
  fee             numeric(78,0) not null,
  snapshot_at     timestamptz not null,
  claim_duration  integer not null,
  burn_leftover   boolean not null,
  rules_hash      text,
  rules_uri       text,
  metadata_uri    text,
  merkle_root     text,
  total_allocated numeric(78,0),
  proofs_uri      text,
  claim_end       timestamptz,
  stage           text not null default 'open' check (stage in ('open', 'cancelled', 'refunded', 'finalized')),
  leftover        numeric(78,0),
  created_block   bigint not null,
  created_tx      text   not null,
  created_at      timestamptz not null,
  hidden          boolean not null default false,
  updated_at      timestamptz not null default now(),
  unique (chain_id, hub, campaign_id)
);
create index campaigns_target on campaigns (chain_id, target);
create index campaigns_creator on campaigns (creator);
create index campaigns_waiting_root on campaigns (snapshot_at) where merkle_root is null and stage = 'open';

create table claims (
  campaign_pk bigint not null references campaigns (pk),
  account     text   not null,
  amount      numeric(78,0) not null,
  caller      text   not null,
  tx          text   not null,
  block       bigint not null,
  primary key (campaign_pk, account)
);
create index claims_account on claims (account);

-- The published table: one row per wallet, and the Merkle tree nodes to build proofs without loading it all.
create table allocations (
  campaign_pk bigint  not null references campaigns (pk) on delete cascade,
  account     text    not null,
  amount      numeric(78,0) not null,
  balance     numeric(78,0) not null,
  capped      boolean not null,
  leaf_index  integer not null,
  primary key (campaign_pk, account)
);
create index allocations_account on allocations (account);

create table tree_nodes (
  campaign_pk bigint  not null references campaigns (pk) on delete cascade,
  idx         integer not null,
  hash        text    not null,
  primary key (campaign_pk, idx)
);

create table nft_collections (
  chain_id       integer not null,
  address        text    not null,
  creator        text    not null,
  implementation text    not null,
  fee_paid       numeric(78,0) not null,
  created_block  bigint  not null,
  created_tx     text    not null,
  created_at     timestamptz not null,
  hidden         boolean not null default false,
  primary key (chain_id, address)
);
create index nft_collections_creator on nft_collections (creator);

-- Storefront moderation for whole tokens or collections: hides, never touches funds.
create table hidden_assets (
  chain_id   integer not null,
  address    text    not null,
  reason     text,
  created_at timestamptz not null default now(),
  primary key (chain_id, address)
);
`,
  },
  {
    name: '002_campaign_claimed',
    sql: `
-- Claimed so far, from Claimed events and from the hub's own state (the indexer reconciles both).
alter table campaigns add column claimed numeric(78,0) not null default 0;
`,
  },
  {
    name: '003_snapshot_jobs',
    sql: `
-- One job per campaign: computes the table step by step across cron runs, then publishes the root.
-- Steps: rules → block → transfers → balances → compute → publish → done.
create table snapshot_jobs (
  campaign_pk     bigint primary key references campaigns (pk),
  status          text not null default 'running' check (status in ('running', 'published', 'rejected', 'failed')),
  step            text not null default 'rules',
  rules_json      text,
  snapshot_block  bigint,
  snapshot_time   timestamptz,
  page_key        text,
  balance_cursor  text,
  merkle_root     text,
  total_allocated numeric(78,0),
  wallets         integer,
  proofs_uri      text,
  publish_tx      text,
  attempts        integer not null default 0,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Working sets of a running job, dropped once the root is published.
create table snapshot_candidates (
  campaign_pk bigint not null references snapshot_jobs (campaign_pk) on delete cascade,
  account     text   not null,
  primary key (campaign_pk, account)
);
create table snapshot_token_ids (
  campaign_pk bigint not null references snapshot_jobs (campaign_pk) on delete cascade,
  token_id    numeric(78,0) not null,
  primary key (campaign_pk, token_id)
);
create table snapshot_balances (
  campaign_pk bigint not null references snapshot_jobs (campaign_pk) on delete cascade,
  account     text   not null,
  balance     numeric(78,0) not null,
  primary key (campaign_pk, account)
);

-- A lease so two overlapping cron runs never work on jobs at the same time.
create table job_leases (
  name         text primary key,
  holder       text not null,
  locked_until timestamptz not null
);
`,
  },
  {
    name: '004_api',
    sql: `
-- Name, symbol and decimals of target and reward assets, read once from the chain.
create table token_meta (
  chain_id   integer not null,
  address    text    not null,
  name       text,
  symbol     text,
  decimals   integer,
  is_nft     boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (chain_id, address)
);

-- Uploads to IPFS through /api/place/pin, for a per-IP limit.
create table pin_log (
  ip         text not null,
  kind       text not null,
  uri        text not null,
  created_at timestamptz not null default now()
);
create index pin_log_ip on pin_log (ip, created_at);
`,
  },
  {
    name: '005_launch',
    sql: `
-- Place Launch. Read from the same event cursor as the hub. Rows keyed by (chain_id, block,
-- log_index) are the dedupe keys that keep running totals idempotent when a range is indexed twice.

-- Pairs from the factory's quote registry.
create table launch_quotes (
  chain_id      integer not null,
  quote         text    not null,
  decimals      integer not null,
  start_tick    integer not null,
  registered    boolean not null,
  revision      bigint  not null,
  rewards_min   numeric(78,0),
  updated_block bigint  not null,
  primary key (chain_id, quote)
);

create table launch_tokens (
  chain_id          integer not null,
  token             text    not null,
  kind              text    not null check (kind in ('b20', 'erc20')),
  pool_id           text    not null,
  quote             text    not null,
  token_is_currency0 boolean,
  tick_spacing      integer not null,
  launch_supply     numeric(78,0) not null,
  original_creator  text    not null,
  current_creator   text    not null,
  pending_creator   text,
  vault             text,
  buyback_bps       integer,
  buyback_burn      boolean,
  rewards_bps       integer,
  x_shares          text,
  metadata_editable boolean,
  name              text,
  symbol            text,
  contract_uri      text,
  extra             text not null default '{}',
  dev_buy_funding   text,
  dev_buy_in        numeric(78,0),
  dev_buy_out       numeric(78,0),
  init_sqrt_price   numeric(78,0),
  sqrt_price        numeric(78,0),
  tick              integer,
  price             double precision,
  quote_reserve     numeric(78,0) not null default 0,
  token_out         numeric(78,0) not null default 0,
  swaps             integer not null default 0,
  last_trade_at     timestamptz,
  created_block     bigint  not null,
  created_tx        text    not null,
  created_at        timestamptz not null,
  hidden            boolean not null default false,
  primary key (chain_id, token),
  unique (chain_id, pool_id)
);
create index launch_tokens_created on launch_tokens (chain_id, created_at desc);
create index launch_tokens_creator on launch_tokens (chain_id, current_creator);
create index launch_tokens_vault on launch_tokens (chain_id, vault);

-- Every swap in a launch pool (PoolManager Swap), with the trader (tx sender) and the hook fee (Trade).
create table launch_swaps (
  chain_id     integer not null,
  block        bigint  not null,
  log_index    integer not null,
  token        text    not null,
  tx           text    not null,
  at           timestamptz not null,
  trader       text,
  router       text    not null,
  side         text    not null check (side in ('buy', 'sell')),
  token_amount numeric(78,0) not null,
  quote_amount numeric(78,0) not null,
  fee          numeric(78,0),
  price        double precision not null,
  sqrt_price   numeric(78,0) not null,
  tick         integer not null,
  primary key (chain_id, block, log_index)
);
create index launch_swaps_token_at on launch_swaps (chain_id, token, at);
create index launch_swaps_trader on launch_swaps (chain_id, trader, at);

-- Token transfers (for holders) and the balances they add up to.
create table launch_transfers (
  chain_id  integer not null,
  block     bigint  not null,
  log_index integer not null,
  token     text    not null,
  from_addr text    not null,
  to_addr   text    not null,
  amount    numeric(78,0) not null,
  tx        text    not null,
  primary key (chain_id, block, log_index)
);
create table launch_balances (
  chain_id integer not null,
  token    text    not null,
  account  text    not null,
  balance  numeric(78,0) not null,
  primary key (chain_id, token, account)
);
create index launch_balances_top on launch_balances (chain_id, token, balance desc);

-- Creator vault activity: collected, bought_back, creator_paid, x_paid, payout_set, economics, campaign.
create table launch_vault_events (
  chain_id  integer not null,
  block     bigint  not null,
  log_index integer not null,
  vault     text    not null,
  token     text,
  kind      text    not null,
  amount    numeric(78,0),
  amount2   numeric(78,0),
  account   text,
  ref       text,
  data      text,
  tx        text    not null,
  at        timestamptz not null,
  primary key (chain_id, block, log_index)
);
create index launch_vault_events_vault on launch_vault_events (chain_id, vault, block);

create table launch_announcements (
  chain_id        integer not null,
  token           text    not null,
  announcement_id text    not null,
  creator         text    not null,
  description     text,
  uri             text,
  tx              text    not null,
  at              timestamptz not null,
  primary key (chain_id, token, announcement_id)
);

-- X account → payout wallet (XRecipientRegistry Bound / Moved).
create table x_bindings (
  chain_id integer not null,
  x_id     numeric(78,0) not null,
  wallet   text    not null,
  block    bigint  not null,
  primary key (chain_id, x_id)
);

-- USD prices of pair assets, cached for a minute.
create table quote_prices (
  symbol     text primary key,
  usd        double precision not null,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    name: '006_launch_profiles',
    sql: `
-- Creator profiles for Place Launch (one per wallet, all chains), saved only with the wallet's signature.
create table launch_profiles (
  address    text primary key,
  name       text,
  avatar     text,
  website    text,
  x          text,
  telegram   text,
  bio        text,
  issued_at  timestamptz not null,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    name: '007_launch_economy',
    sql: `
-- Place Launch 0.2.0 economy and PlaceStaking. Only new tables: the 0.1.0
-- columns of launch_tokens (buyback_*, rewards_bps) stay for legacy tokens.

-- Which release a token was launched with, and its baskets (0.2.0+: burn and community fund, in bps of the
-- creator side, the rest goes to X accounts and the creator). Raised later by EconomicsIncreased.
create table launch_economy (
  chain_id      integer not null,
  token         text    not null,
  version       text    not null,
  burn_bps      integer,
  community_bps integer,
  updated_block bigint  not null,
  primary key (chain_id, token)
);

-- Per pair limits of the factory policy (QuoteLimitsUpdated), frozen into each vault at launch.
create table launch_quote_limits (
  chain_id                 integer not null,
  quote                    text    not null,
  max_burn_per_process     numeric(78,0) not null,
  default_campaign_minimum numeric(78,0) not null,
  updated_block            bigint  not null,
  primary key (chain_id, quote)
);

-- PlaceStaking programs (VaultCreated) with running totals.
create table staking_programs (
  chain_id         integer not null,
  staking          text    not null,
  vault_id         text    not null,
  creator          text    not null,
  staking_token    text    not null,
  reward_currency  text    not null,
  start_time       timestamptz not null,
  epoch_duration   bigint  not null,
  epoch_count      integer not null,
  reward_per_epoch numeric(78,0) not null,
  early_exit_mode  integer not null,
  penalty_bps      integer not null,
  total_reward     numeric(78,0) not null,
  protocol_fee     numeric(78,0) not null,
  fee_bps          integer not null,
  total_staked     numeric(78,0) not null default 0,
  claimed          numeric(78,0) not null default 0,
  created_block    bigint  not null,
  created_tx       text    not null,
  created_at       timestamptz not null,
  hidden           boolean not null default false,
  primary key (chain_id, vault_id)
);
create index staking_programs_token on staking_programs (chain_id, staking_token);

-- Deposits, withdrawals and epoch claims, keyed by log for idempotent totals.
create table staking_events (
  chain_id  integer not null,
  block     bigint  not null,
  log_index integer not null,
  vault_id  text    not null,
  account   text    not null,
  kind      text    not null check (kind in ('deposit', 'withdraw', 'claim')),
  amount    numeric(78,0) not null,
  lot_id    bigint,
  epoch     bigint,
  penalty   numeric(78,0),
  unlock_at timestamptz,
  tx        text    not null,
  at        timestamptz not null,
  primary key (chain_id, block, log_index)
);
create index staking_events_account on staking_events (chain_id, account, block);
create index staking_events_vault on staking_events (chain_id, vault_id, block);

create table staking_positions (
  chain_id integer not null,
  vault_id text    not null,
  account  text    not null,
  staked   numeric(78,0) not null default 0,
  claimed  numeric(78,0) not null default 0,
  primary key (chain_id, vault_id, account)
);

-- White list of community-fund swaps (PlaceRewardTokenRegistry RouteSet / RouteRemoved): from -> to with the
-- Uniswap v4 hops as JSON. The registry cannot list its routes, so the site reads them from here.
create table launch_reward_routes (
  chain_id      integer not null,
  registry      text    not null,
  from_token    text    not null,
  to_token      text    not null,
  hops          text,
  active        boolean not null,
  updated_block bigint  not null,
  primary key (chain_id, registry, from_token, to_token)
);

-- Daily process() and startDefaultCampaign() calls of the Place keeper (the cron log).
create table keeper_runs (
  id        bigserial primary key,
  chain_id  integer not null,
  at        timestamptz not null default now(),
  vault     text    not null,
  token     text,
  action    text    not null,
  status    text    not null,
  tx        text,
  gas_used  numeric(78,0),
  detail    text
);
create index keeper_runs_vault on keeper_runs (chain_id, vault, at desc);
`,
  },
];
