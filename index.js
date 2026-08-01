// ATLAS profit sync
// Pulls today's Shopify orders, estimates profit using a fixed margin,
// and upserts it into Supabase's profit_entries table.
// All credentials come from environment variables — never hardcode them here,
// this repo is public.

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SHOP_DOMAIN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PROFIT_MARGIN,
} = process.env;

const REQUIRED = {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SHOP_DOMAIN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
};
for (const [key, val] of Object.entries(REQUIRED)) {
  if (!val) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const margin = parseFloat(PROFIT_MARGIN || '0.49');
const API_VERSION = '2026-07';

function todayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    start: start.toISOString(),
    end: now.toISOString(),
    dayKey: start.toISOString().slice(0, 10),
  };
}

async function getAccessToken() {
  const res = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchTodaysRevenue(token) {
  const { start, end } = todayBounds();
  const url =
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${encodeURIComponent(start)}&created_at_max=${encodeURIComponent(end)}&limit=250`;

  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  if (!res.ok) {
    throw new Error(`Shopify orders request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const orders = data.orders || [];
  return orders.reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0);
}

async function saveProfit(dayKey, amount) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profit_entries?on_conflict=day`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ day: dayKey, amount }),
  });
  if (!res.ok) {
    throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
  }
}

async function run() {
  const { dayKey } = todayBounds();
  console.log(`Syncing profit for ${dayKey}...`);

  const token = await getAccessToken();
  const revenue = await fetchTodaysRevenue(token);
  const estimatedProfit = Math.round(revenue * margin * 100) / 100;

  await saveProfit(dayKey, estimatedProfit);
  console.log(
    `Done. Revenue: $${revenue.toFixed(2)} × ${(margin * 100).toFixed(0)}% margin ` +
    `-> logged $${estimatedProfit.toFixed(2)} for ${dayKey}.`
  );
}

run().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
