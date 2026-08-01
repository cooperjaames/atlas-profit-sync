// ATLAS profit sync
// Pulls today's revenue from every connected store, applies each store's
// profit margin and Cooper's ownership share, and upserts the combined
// total into Supabase's profit_entries table.
// All credentials come from environment variables — never hardcode them here,
// this repo is public.

const { STORES_CONFIG, SUPABASE_URL, SUPABASE_SERVICE_KEY, PROFIT_MARGIN } = process.env;

if (!STORES_CONFIG) {
  console.error('Missing required environment variable: STORES_CONFIG');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required Supabase environment variables.');
  process.exit(1);
}

let stores;
try {
  stores = JSON.parse(STORES_CONFIG);
} catch (e) {
  console.error('STORES_CONFIG is not valid JSON:', e.message);
  process.exit(1);
}

const defaultMargin = parseFloat(PROFIT_MARGIN || '0.49');
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

async function getAccessToken(store) {
  const res = await fetch(`https://${store.domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: store.clientId,
      client_secret: store.secret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    throw new Error(`[${store.name}] token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function fetchTodaysRevenue(store, token) {
  const { start, end } = todayBounds();
  const url =
    `https://${store.domain}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${encodeURIComponent(start)}&created_at_max=${encodeURIComponent(end)}&limit=250`;

  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token },
  });
  if (!res.ok) {
    throw new Error(`[${store.name}] orders request failed: ${res.status} ${await res.text()}`);
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
  console.log(`Syncing profit for ${dayKey} across ${stores.length} store(s)...`);

  let totalProfit = 0;
  const breakdown = [];

  for (const store of stores) {
    try {
      const margin = store.margin !== undefined ? store.margin : defaultMargin;
      const share = store.share !== undefined ? store.share : 1;
      const token = await getAccessToken(store);
      const revenue = await fetchTodaysRevenue(store, token);
      const contribution = revenue * margin * share;
      totalProfit += contribution;
      breakdown.push(`${store.name}: revenue $${revenue.toFixed(2)} × ${(margin * 100).toFixed(0)}% margin × ${(share * 100).toFixed(0)}% share = $${contribution.toFixed(2)}`);
    } catch (err) {
      console.error(`Skipping ${store.name} due to error: ${err.message}`);
    }
  }

  totalProfit = Math.round(totalProfit * 100) / 100;
  await saveProfit(dayKey, totalProfit);

  console.log(breakdown.join('\n'));
  console.log(`Done. Logged combined profit $${totalProfit.toFixed(2)} for ${dayKey}.`);
}

run().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
