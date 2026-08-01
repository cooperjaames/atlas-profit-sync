# atlas-profit-sync

Pulls today's Shopify orders, estimates profit at a fixed margin, and logs it
to Supabase for the ATLAS dashboard. Runs on a Railway cron schedule.

## Required environment variables (set in Railway, never in this repo)

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_SHOP_DOMAIN` — e.g. `evstc1-at.myshopify.com`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` — the `service_role` key, not the anon key
- `PROFIT_MARGIN` — optional, defaults to `0.49`
