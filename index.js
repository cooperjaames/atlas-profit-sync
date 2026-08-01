// ATLAS profit sync
// Pulls revenue per store, applies each store's margin and Cooper's
// ownership share, and upserts both the combined total AND a per-store
// breakdown into Supabase's profit_entries table.
//
// Normal mode: processes only "today".
// Backfill mode: set BACKFILL_FROM="YYYY-MM-DD" to reprocess every day
// from that date through today. Unset it again afterward — leaving it set
// means every scheduled run reprocesses the whole range, which is slow
// and hammers the Shopify API for no reason.
//
// All credentials come from environment variables — never hardcode them here,
// this repo is public.

const { STORES_CONFIG, SUPABASE_URL, SUPABASE_SERVICE_KEY, PROFIT_MARGIN, BACKFILL_FROM } = process.env;

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

// ---------- Mountain-Time-aware date helpers ----------
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

// Midnight-to-midnight (Mountain Time) bounds for a given calendar day, as UTC ISO strings.
function dayBoundsFor(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const refInstant = new Date(Date.UTC(y, m - 1, d, 18)); // midday UTC on that date, safely inside the day for offset lookup
  const offsetMin = getOffsetMinutes(refInstant, STORE_TZ);
  const startUTC = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60000;
  const endUTC = startUTC + 24 * 60 * 60 * 1000;
  return { start: new Date(startUTC).toISOString(), end: new Date(endUTC).toISOString() };
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: STORE_TZ }).format(new Date()); // "YYYY-MM-DD"
}

function dateRange(fromKey, toKey) {
  const keys = [];
  let [y, m, d] = fromKey.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const endCursor = (() => { const [ey, em, ed] = toKey.split('-').map(Number); return new Date(Date.UTC(ey, em - 1, ed)); })();
  while (cursor.getTime() <= endCursor.getTime()) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

// ---------- Shopify ----------
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

// Fetches all orders (paginated) within [start, end) and returns total revenue.
async function fetchRevenue(store, token, start, end) {
  let total = 0;
  let url =
    `https://${store.domain}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${encodeURIComponent(start)}&created_at_max=${encodeURIComponent(end)}&limit=250`;

  while (url) {
    const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) {
      throw new Error(`[${store.name}] orders request failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const orders = data.orders || [];
    total += orders.reduce((sum, o) => sum + parseFloat(o.total_price || '0'), 0);

    // Cursor-based pagination via the Link header, for months with >250 orders.
    const link = res.headers.get('link') || res.headers.get('Link');
    const next = link && link.split(',').find((p) => p.includes('rel="next"'));
    if (next) {
      const match = next.match(/<([^>]+)>/);
      url = match ? match[1] : null;
    } else {
      url = null;
    }
  }
  return total;
}

async function saveDay(dayKey, amount, breakdown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profit_entries?on_conflict=day`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ day: dayKey, amount, breakdown }),
  });
  if (!res.ok) {
    throw new Error(`Supabase write failed for ${dayKey}: ${res.status} ${await res.text()}`);
  }
}

async function run() {
  const fromKey = BACKFILL_FROM || todayKey();
  const toKey = todayKey();
  const days = dateRange(fromKey, toKey);
  const mode = BACKFILL_FROM ? `BACKFILL (${fromKey} -> ${toKey}, ${days.length} day(s))` : 'daily sync (today only)';
  console.log(`Running in ${mode} across ${stores.length} store(s)...`);

  // Get one token per store up front, reused for every day in range.
  const tokens = {};
  for (const store of stores) {
    try {
      tokens[store.name] = await getAccessToken(store);
    } catch (err) {
      console.error(`Could not authenticate ${store.name}: ${err.message}`);
    }
  }

  for (const dayKey of days) {
    const { start, end } = dayBoundsFor(dayKey);
    const breakdown = {};
    let dayTotal = 0;

    for (const store of stores) {
      const token = tokens[store.name];
      if (!token) { breakdown[store.name] = 0; continue; }
      try {
        const margin = store.margin !== undefined ? store.margin : defaultMargin;
        const share = store.share !== undefined ? store.share : 1;
        const revenue = await fetchRevenue(store, token, start, end);
        const contribution = Math.round(revenue * margin * share * 100) / 100;
        breakdown[store.name] = contribution;
        dayTotal += contribution;
      } catch (err) {
        console.error(`[${dayKey}] Skipping ${store.name}: ${err.message}`);
        breakdown[store.name] = 0;
      }
    }

    dayTotal = Math.round(dayTotal * 100) / 100;
    try {
      await saveDay(dayKey, dayTotal, breakdown);
      console.log(`${dayKey}: $${dayTotal.toFixed(2)} — ${JSON.stringify(breakdown)}`);
    } catch (err) {
      console.error(`[${dayKey}] Failed to save, skipping: ${err.message}`);
    }
  }

  console.log('Done.');
}

run().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
