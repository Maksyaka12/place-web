# Place cron: external scheduler

`GET /api/place-cron` runs one tick of the Place background work:

1. index new events (launches, NFT collections, campaigns);
2. keeper: closes yesterday's reward days right after 00:00 UTC (`closeStreams`), retries deferred conversions,
   processes NFT launchpad collections (buyback & burn, royalties, payouts), starts default campaigns;
3. index again, so the days just closed are in the database;
4. rewards publisher: builds the day's holder / trader tables and publishes their Merkle roots;
5. hub campaigns and snapshot jobs.

Rewards therefore appear a few minutes after 00:00 UTC, as long as something calls the endpoint often enough.
Vercel Hobby runs it once a day (`vercel.json`, 00:05 UTC) and GitHub Actions schedules are delayed by hours, so
the main scheduler is an external one, every 5 minutes.

## cron-job.org (free)

1. Sign up at <https://cron-job.org> and open **Cronjobs → Create cronjob**.
2. **Title**: `Place cron`.
3. **URL**: `https://<your-site>/api/place-cron?async=1`
   (for the testnet site: `https://place-blond.vercel.app/api/place-cron?async=1`).
4. **Execution schedule**: every 5 minutes (`*/5 * * * *`).
5. **Advanced**:
   - Request method: `GET`.
   - Headers: add `Authorization` with the value `Bearer <CRON_SECRET>`, where `<CRON_SECRET>` is the
     `CRON_SECRET` environment variable of the Vercel project (Settings → Environment Variables). Paste it only into
     cron-job.org; never put it in the repository, an issue or a chat.
   - Request timeout: the maximum offered (30 s is enough).
   - Treat 3xx redirects as success: off.
6. **Notifications**: turn on "execution of the cronjob fails", so a broken secret or a down site is noticed.
7. Save, then press **Test run**. The expected answer is `202` with `{"started":true,...}`.

`?async=1` makes the endpoint answer at once and finish the tick in the background (up to 5 minutes), so the
scheduler's short timeout never cuts a tick. Calls that arrive while a tick is still running are skipped (one tick
at a time, a lease in the database), so overlapping schedulers are harmless.

Any other scheduler works the same way: `GET` the URL above every 5 minutes with the `Authorization` header.

## Fallbacks

- `.github/workflows/place-cron.yml` calls the endpoint (synchronously) on its own schedule. It needs the
  `CRON_SECRET` secret and the `PLACE_URL` variable in the GitHub repository settings.
- Vercel cron calls it once a day at 00:05 UTC.

## Checking that it works

- `GET https://<your-site>/api/place/launch/keeper?chain=84532` is the keeper's public log: every action with its
  time, status (`success`, `nothing`, `reverted-dry-run`, `skipped-gas`, `error`), transaction and gas. After
  00:00 UTC a `close_streams` row with `success` (or `nothing`) should appear within a few minutes.
- Without `PLACE_KEEPER_PRIVATE_KEY` in Vercel the keeper is off: indexing and the publisher still run, but days are
  not closed. The keeper wallet only pays gas; keep a little ETH on it (about 0.01 ETH on Base Sepolia).

## Keeper settings (Vercel environment variables, all optional)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLACE_KEEPER_MAX_GAS` | 800000 | Gas cap per call (`closeStreams`: per stream in the batch) |
| `PLACE_KEEPER_MAX_CALLS` | 20 | Transactions per tick |
| `PLACE_KEEPER_INTERVAL_S` | 86400 | Seconds between conversions / default campaign checks per vault |
| `PLACE_KEEPER_NFT_MIN_ETH` | 0.0005 | Smallest ETH amount (buyback, royalties, payouts) worth a transaction |
| `PLACE_KEEPER_NFT_MIN_TOKENS` | 1 | Smallest token amount, in whole tokens |
| `PLACE_KEEPER_NFT_INTERVAL_S` | 21600 | Seconds between looks at one NFT collection |
