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
const STORE_TZ = 'America/Denver'; // Mountain Time — handles DST automatically

// The server this runs on keeps UTC time, not Mountain Time, so "today"
// has to be computed against STORE_TZ explicitly or the day boundary drifts.
function getOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { if (p.type !== 'literal') parts[p.type] = p.value; });
  const hour = parts.hour === '24' ? '0' : parts.hour;
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function todayBounds() {
  const now = new Date();
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TZ }).format(now); // "YYYY-MM-DD" in Mountain Time
  const [y, m, d] = dayKey.split('-').map(Number);
  const guessUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetMin = getOffsetMinutes(now, STORE_TZ);
  const startMs = guessUTC - offsetMin * 60000; // midnight Mountain Time, expressed in UTC
  return {
    start: new Date(startMs).toISOString(),
    end: now.toISOString(),
    dayKey,
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
