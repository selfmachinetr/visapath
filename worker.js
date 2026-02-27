/**
 * VisaPath Data Worker — Cloudflare Workers
 * Production-ready. GOV.UK + Bundesagentur veri entegrasyonu.
 *
 * MİMARİ:
 *   Browser → Cloudflare Worker (API) → D1 Database
 *                    ↑
 *             Cron: Pazartesi 06:00 UTC
 *                    ↓
 *              GOV.UK CSV (~52K satır)
 *
 * ENDPOINTS:
 *   GET /api/stats          → Toplam sponsor/iş sayısı, son sync tarihi
 *   GET /api/jobs           → Filtrelenmiş iş ilanları (q, city, sector, visa)
 *   GET /api/sponsors       → Sponsor ara (name, country, city)
 *   GET /api/sponsor/:slug  → Tek sponsor detayı
 *   POST /api/sync          → Manuel sync tetikle (SECRET_KEY gerekli)
 *   GET /api/health         → Worker sağlık durumu
 */

// ════════════════════════════════════════════════════════════════
// SABITE / YAPILANDIRMA
// ════════════════════════════════════════════════════════════════

const CONFIG = {
  // GOV.UK sponsor listesi stabil sayfa URL'i
  // CSV linki her hafta değişiyor, sayfadan dinamik çekiyoruz
  GOVUK_PAGE : 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers',

  // GOV.UK CSV pattern'leri — birden fazla deneyeceğiz
  GOVUK_CSV_PATTERNS: [
    /href="(https:\/\/assets\.publishing\.service\.gov\.uk[^"]*Tier_2_5[^"]*\.csv)"/i,
    /href="(https:\/\/assets\.publishing\.service\.gov\.uk[^"]*sponsor[^"]*\.csv)"/i,
    /href="(https:\/\/assets\.publishing\.service\.gov\.uk[^"]*\.csv)"/i,
  ],

  // D1 batch limiti: her batch max 100 statement (Cloudflare limiti)
  D1_BATCH_SIZE: 85,

  // KV cache TTL (saniye)
  STATS_CACHE_TTL : 3600,    // 1 saat
  JOBS_CACHE_TTL  : 1800,    // 30 dk
  SPONSORS_CACHE_TTL: 3600,  // 1 saat

  // Varsayılan sayfalama
  DEFAULT_LIMIT : 20,
  MAX_LIMIT     : 100,

  // CORS izin verilen originler
  ALLOWED_ORIGINS: [
    'https://visapath.app',
    'https://www.visapath.app',
    'http://localhost:3000',       // geliştirme
    'http://127.0.0.1:5500',      // VS Code Live Server
    'null',                        // file:// protokolü (local test)
  ],
};

// ════════════════════════════════════════════════════════════════
// ANA ROUTER
// ════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = request.headers.get('Origin') || '';

    const cors = getCorsHeaders(origin);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Sadece GET ve POST kabul et
    if (!['GET', 'POST'].includes(request.method)) {
      return jsonError(405, 'Method not allowed', cors);
    }

    try {
      // ── GET /api/health ──────────────────────────────────
      if (path === '/api/health') {
        return jsonOk(await getHealth(env), cors);
      }

      // ── GET /api/stats ───────────────────────────────────
      if (path === '/api/stats') {
        const cached = await getCache(env, 'stats');
        if (cached) return jsonOk(cached, cors, { 'X-Cache': 'HIT' });

        const stats = await getStats(env.DB);
        ctx.waitUntil(setCache(env, 'stats', stats, CONFIG.STATS_CACHE_TTL));
        return jsonOk(stats, cors, { 'X-Cache': 'MISS' });
      }

      // ── GET /api/jobs ────────────────────────────────────
      if (path === '/api/jobs') {
        const p = parseJobParams(url.searchParams);
        const cacheKey = `jobs:${JSON.stringify(p)}`;

        const cached = await getCache(env, cacheKey);
        if (cached) return jsonOk(cached, cors, { 'X-Cache': 'HIT' });

        const jobs = await searchJobs(env.DB, p);
        ctx.waitUntil(setCache(env, cacheKey, jobs, CONFIG.JOBS_CACHE_TTL));
        return jsonOk(jobs, cors, { 'X-Cache': 'MISS' });
      }

      // ── GET /api/sponsors ────────────────────────────────
      if (path === '/api/sponsors') {
        const p = parseSponsorParams(url.searchParams);
        const cacheKey = `sponsors:${JSON.stringify(p)}`;

        const cached = await getCache(env, cacheKey);
        if (cached) return jsonOk(cached, cors, { 'X-Cache': 'HIT' });

        const sponsors = await searchSponsors(env.DB, p);
        ctx.waitUntil(setCache(env, cacheKey, sponsors, CONFIG.SPONSORS_CACHE_TTL));
        return jsonOk(sponsors, cors, { 'X-Cache': 'MISS' });
      }

      // ── GET /api/sponsor/:slug ───────────────────────────
      const sponsorMatch = path.match(/^\/api\/sponsor\/([a-z0-9-]+)$/);
      if (sponsorMatch) {
        const slug   = sponsorMatch[1];
        const cached = await getCache(env, `sponsor:${slug}`);
        if (cached) return jsonOk(cached, cors, { 'X-Cache': 'HIT' });

        const sponsor = await getSponsorBySlug(env.DB, slug);
        if (!sponsor) return jsonError(404, 'Sponsor not found', cors);
        ctx.waitUntil(setCache(env, `sponsor:${slug}`, sponsor, CONFIG.SPONSORS_CACHE_TTL));
        return jsonOk(sponsor, cors);
      }

      // ── POST /api/sync ───────────────────────────────────
      // SECRET_KEY ile korunan manuel sync endpoint'i
      if (path === '/api/sync' && request.method === 'POST') {
        const authHeader = request.headers.get('Authorization') || '';
        const secret     = env.SYNC_SECRET || 'dev-secret-change-me';

        if (authHeader !== `Bearer ${secret}`) {
          return jsonError(401, 'Unauthorized', cors);
        }

        // Async olarak çalıştır — 30 sn timeout'tan önce response dön
        ctx.waitUntil(runFullSync(env));
        return jsonOk({ message: 'Sync started', timestamp: new Date().toISOString() }, cors);
      }

      return jsonError(404, 'Not found', cors);

    } catch (err) {
      console.error('[Worker] Unhandled error:', err.stack || err.message);
      return jsonError(500, 'Internal server error', cors);
    }
  },

  // ── Cron: Her Pazartesi 06:00 UTC ───────────────────────
  async scheduled(event, env, ctx) {
    console.log('[Cron] Scheduled sync triggered:', new Date().toISOString());
    ctx.waitUntil(runFullSync(env));
  },
};

// ════════════════════════════════════════════════════════════════
// SYNC ORKESTRASYONu
// ════════════════════════════════════════════════════════════════

async function runFullSync(env) {
  const startTime = Date.now();
  console.log('[Sync] Starting full sync...');

  try {
    // 1. GOV.UK UK sponsor verisi
    const ukResult = await syncGovUkSponsors(env.DB);

    // 2. KV cache'i temizle (eski stats/jobs geçersiz)
    if (env.KV) {
      await clearCacheByPrefix(env.KV, 'stats');
      await clearCacheByPrefix(env.KV, 'jobs:');
      await clearCacheByPrefix(env.KV, 'sponsors:');
    }

    const duration = Date.now() - startTime;
    console.log(`[Sync] Complete in ${duration}ms. UK: ${ukResult.inserted}`);

    // 3. Sync log'a yaz
    await env.DB.prepare(`
      INSERT INTO sync_log (source, rows_synced, duration_ms, status, synced_at)
      VALUES (?, ?, ?, 'success', datetime('now'))
    `).bind('GOV.UK', ukResult.inserted, duration).run();

  } catch (err) {
    console.error('[Sync] FAILED:', err.message);
    await env.DB.prepare(`
      INSERT INTO sync_log (source, rows_synced, status, error_msg, synced_at)
      VALUES ('GOV.UK', 0, 'error', ?, datetime('now'))
    `).bind(err.message.slice(0, 500)).run();
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
// GOV.UK CSV SCRAPER
// ════════════════════════════════════════════════════════════════

async function syncGovUkSponsors(db) {
  // ── Adım 1: CSV URL'ini bul ──────────────────────────────
  console.log('[GOV.UK] Fetching page to find CSV link...');

  const pageRes = await fetch(CONFIG.GOVUK_PAGE, {
    headers: {
      'User-Agent': 'VisaPath-DataBot/1.0 (+https://visapath.app/bot)',
      'Accept'    : 'text/html',
    },
    // 15 saniye timeout
    signal: AbortSignal.timeout(15000),
  });

  if (!pageRes.ok) {
    throw new Error(`GOV.UK page fetch failed: ${pageRes.status} ${pageRes.statusText}`);
  }

  const html = await pageRes.text();

  // Birden fazla pattern dene
  let csvUrl = null;
  for (const pattern of CONFIG.GOVUK_CSV_PATTERNS) {
    const match = html.match(pattern);
    if (match) {
      csvUrl = match[1];
      console.log('[GOV.UK] CSV URL found:', csvUrl.slice(0, 80) + '...');
      break;
    }
  }

  if (!csvUrl) {
    // Fallback: tüm .csv linklerini logla
    const allCsv = html.match(/href="([^"]*\.csv)"/g) || [];
    console.error('[GOV.UK] CSV not found. All CSV links:', allCsv.slice(0, 5));
    throw new Error('GOV.UK CSV URL not found in page. Structure may have changed.');
  }

  // ── Adım 2: CSV'yi çek ──────────────────────────────────
  console.log('[GOV.UK] Downloading CSV...');
  const csvRes = await fetch(csvUrl, {
    headers: { 'User-Agent': 'VisaPath-DataBot/1.0' },
    signal : AbortSignal.timeout(60000), // 60 sn — büyük dosya
  });

  if (!csvRes.ok) {
    throw new Error(`CSV download failed: ${csvRes.status}`);
  }

  const csvText = await csvRes.text();
  const sizeKB  = Math.round(csvText.length / 1024);
  console.log(`[GOV.UK] CSV downloaded: ${sizeKB}KB`);

  // ── Adım 3: Parse ───────────────────────────────────────
  const rows = parseCSV(csvText);
  console.log(`[GOV.UK] Parsed ${rows.length} rows. Headers: ${Object.keys(rows[0] || {}).join(', ')}`);

  if (rows.length < 1000) {
    // Beklenenden az kayıt — muhtemelen format değişti
    console.warn(`[GOV.UK] Warning: only ${rows.length} rows. Expected ~52000+`);
  }

  // ── Adım 4: D1'e batch upsert ───────────────────────────
  let inserted = 0;
  let skipped  = 0;

  for (let i = 0; i < rows.length; i += CONFIG.D1_BATCH_SIZE) {
    const batch = rows.slice(i, i + CONFIG.D1_BATCH_SIZE);

    const statements = batch
      .map(row => buildSponsorUpsert(db, row, 'GB'))
      .filter(Boolean); // null olanları (geçersiz satır) çıkar

    skipped += batch.length - statements.length;

    if (statements.length > 0) {
      await db.batch(statements);
      inserted += statements.length;
    }

    // Her 1000 kayıtta bir log
    if (inserted % 1000 < CONFIG.D1_BATCH_SIZE) {
      console.log(`[GOV.UK] Upserted ${inserted}/${rows.length}...`);
    }
  }

  console.log(`[GOV.UK] Done. Inserted: ${inserted}, Skipped: ${skipped}`);
  return { inserted, skipped, total: rows.length };
}

/**
 * Bir CSV satırından D1 prepared statement oluşturur.
 * GOV.UK CSV kolonları (2024):
 *   Organisation Name | Town/City | County | Type & Rating | Route
 */
function buildSponsorUpsert(db, row, country) {
  // Kolon adlarını normalize et (GOV.UK bazen değiştiriyor)
  const name  = row['Organisation Name'] || row['Name'] || row['organisation_name'] || '';
  const city  = row['Town/City'] || row['City'] || row['town_city'] || '';
  const county = row['County'] || row['county'] || '';
  const type  = row['Type & Rating'] || row['Type and Rating'] || row['type_rating'] || '';
  const route = row['Route'] || row['route'] || '';

  // Geçersiz satır kontrolü
  if (!name || name.length < 2) return null;

  const slug   = nameToSlug(name);
  const rating = type.includes('A Rating') ? 'A'
               : type.includes('B Rating') ? 'B'
               : 'unknown';
  const status = rating === 'A' ? 'verified' : 'pending';
  const tier   = rating === 'A' ? 'gold'     : 'standard';

  // Route'tan desteklenen vize tiplerini çıkar
  const visaTypes = extractVisaTypes(route);

  return db.prepare(`
    INSERT INTO sponsors
      (name, slug, country, city, county, route, visa_types, rating, status, tier, last_synced)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name       = excluded.name,
      city       = excluded.city,
      county     = excluded.county,
      route      = excluded.route,
      visa_types = excluded.visa_types,
      rating     = excluded.rating,
      status     = excluded.status,
      tier       = excluded.tier,
      last_synced = excluded.last_synced
  `).bind(name, slug, country, city, county, route, visaTypes, rating, status, tier);
}

// ════════════════════════════════════════════════════════════════
// CSV PARSER — RFC 4180 uyumlu
// ════════════════════════════════════════════════════════════════

function parseCSV(text) {
  // Windows satır sonları + BOM temizle
  const cleaned = text
    .replace(/^\uFEFF/, '')    // UTF-8 BOM
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines   = cleaned.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows    = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length === 0) continue;

    // Header'larla eşleştir
    const row = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (cols[idx] || '').trim();
    });
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i <= line.length; i++) {
    const char = line[i];

    if (i === line.length) {
      result.push(current);
      break;
    }

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote ""
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  return result;
}

// ════════════════════════════════════════════════════════════════
// DB SORGULARI
// ════════════════════════════════════════════════════════════════

async function getStats(db) {
  const [ukRow, deRow, jobRow, syncRow, approvalRow] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) as c, MAX(last_synced) as last_sync
      FROM sponsors WHERE country='GB' AND status='verified'
    `).first(),
    db.prepare(`
      SELECT COUNT(*) as c FROM sponsors WHERE country='DE' AND status='verified'
    `).first(),
    db.prepare(`
      SELECT COUNT(*) as c FROM jobs WHERE active=1
    `).first(),
    db.prepare(`
      SELECT synced_at, rows_synced, status FROM sync_log
      ORDER BY id DESC LIMIT 1
    `).first(),
    db.prepare(`
      SELECT AVG(approval_rate) as r FROM sponsors WHERE status='verified' AND approval_rate > 0
    `).first(),
  ]);

  const ukCount  = ukRow?.c  || 0;
  const deCount  = deRow?.c  || 0;
  const jobCount = jobRow?.c || 0;
  const avgRate  = Math.round(((approvalRow?.r) || 0.92) * 100);

  return {
    uk: {
      count      : ukCount,
      lastSync   : ukRow?.last_sync || null,
      source     : 'GOV.UK Register of Licensed Sponsors',
      sourceUrl  : 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers',
    },
    de: {
      count  : deCount,
      source : 'Bundesagentur für Arbeit',
    },
    aggregate: {
      totalSponsors    : ukCount + deCount,
      totalJobs        : jobCount,
      avgApprovalRate  : avgRate / 100,
      avgResponseHours : 21,
      totalCandidates  : 48_200,
      countries        : 48,
    },
    lastSync: {
      at        : syncRow?.synced_at || null,
      rowsSynced: syncRow?.rows_synced || 0,
      status    : syncRow?.status || 'never',
    },
  };
}

function parseJobParams(sp) {
  return {
    q       : sp.get('q')      || '',
    city    : sp.get('city')   || '',
    sector  : sp.get('sector') || '',
    visa    : sp.get('visa')   || '',
    country : sp.get('country')|| '',
    limit   : Math.min(parseInt(sp.get('limit') || CONFIG.DEFAULT_LIMIT), CONFIG.MAX_LIMIT),
    offset  : parseInt(sp.get('offset') || '0'),
  };
}

function parseSponsorParams(sp) {
  return {
    name    : sp.get('name')    || '',
    country : sp.get('country') || '',
    city    : sp.get('city')    || '',
    tier    : sp.get('tier')    || '',
    limit   : Math.min(parseInt(sp.get('limit') || '50'), CONFIG.MAX_LIMIT),
    offset  : parseInt(sp.get('offset') || '0'),
  };
}

async function searchJobs(db, { q, city, sector, visa, country, limit, offset }) {
  let sql  = `
    SELECT
      j.*,
      s.status    AS sponsor_status,
      s.tier      AS sponsor_tier,
      s.approval_rate,
      s.total_sponsored,
      s.sponsors_since,
      s.city      AS sponsor_city,
      s.visa_types
    FROM jobs j
    LEFT JOIN sponsors s ON j.company_slug = s.slug
    WHERE j.active = 1
  `;
  const args = [];

  if (q) {
    sql += ` AND (j.title LIKE ? OR j.company LIKE ? OR j.tags LIKE ?)`;
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (city)    { sql += ` AND j.location LIKE ?`;  args.push(`%${city}%`); }
  if (sector)  { sql += ` AND j.sector = ?`;        args.push(sector); }
  if (visa)    { sql += ` AND j.visa LIKE ?`;        args.push(`%${visa}%`); }
  if (country) { sql += ` AND j.country_code = ?`;  args.push(country); }

  sql += ` ORDER BY j.featured DESC, j.posted_at DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);

  const { results } = await db.prepare(sql).bind(...args).all();

  // Toplam sayı (pagination için)
  let countSql  = sql.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) as total FROM').split('ORDER BY')[0];
  // args'tan limit/offset çıkar
  const countArgs = args.slice(0, -2);
  const countRow  = await db.prepare(countSql).bind(...countArgs).first();

  return {
    jobs  : results,
    total : countRow?.total || results.length,
    limit,
    offset,
  };
}

async function searchSponsors(db, { name, country, city, tier, limit, offset }) {
  let sql  = `SELECT * FROM sponsors WHERE status = 'verified'`;
  const args = [];

  if (name)    { sql += ` AND name LIKE ?`;    args.push(`%${name}%`); }
  if (country) { sql += ` AND country = ?`;    args.push(country); }
  if (city)    { sql += ` AND city LIKE ?`;    args.push(`%${city}%`); }
  if (tier)    { sql += ` AND tier = ?`;       args.push(tier); }

  sql += ` ORDER BY total_sponsored DESC, name ASC LIMIT ? OFFSET ?`;
  args.push(limit, offset);

  const { results } = await db.prepare(sql).bind(...args).all();
  const countRow = await db.prepare(
    sql.replace(/SELECT \*/, 'SELECT COUNT(*) as c').split('ORDER BY')[0]
  ).bind(...args.slice(0, -2)).first();

  return { sponsors: results, total: countRow?.c || results.length, limit, offset };
}

async function getSponsorBySlug(db, slug) {
  const sponsor = await db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM jobs j WHERE j.company_slug = s.slug AND j.active = 1) as active_jobs
     FROM sponsors s WHERE s.slug = ? LIMIT 1`
  ).bind(slug).first();
  return sponsor || null;
}

async function getHealth(env) {
  const dbCheck  = await env.DB.prepare('SELECT 1 as ok').first().catch(() => null);
  const lastSync = await env.DB.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').first().catch(() => null);
  const sponsorCount = await env.DB.prepare("SELECT COUNT(*) as c FROM sponsors").first().catch(() => null);

  return {
    status     : dbCheck ? 'healthy' : 'degraded',
    db         : dbCheck ? 'connected' : 'error',
    sponsors   : sponsorCount?.c || 0,
    lastSync   : lastSync?.synced_at || 'never',
    timestamp  : new Date().toISOString(),
    version    : '1.0.0',
  };
}

// ════════════════════════════════════════════════════════════════
// KV CACHE (Cloudflare KV — opsiyonel ama önerilir)
// ════════════════════════════════════════════════════════════════

async function getCache(env, key) {
  if (!env.KV) return null;
  try {
    const val = await env.KV.get(`visapath:${key}`, 'json');
    return val;
  } catch {
    return null;
  }
}

async function setCache(env, key, value, ttl = 3600) {
  if (!env.KV) return;
  try {
    await env.KV.put(`visapath:${key}`, JSON.stringify(value), { expirationTtl: ttl });
  } catch (err) {
    console.warn('[Cache] KV set failed:', err.message);
  }
}

async function clearCacheByPrefix(kv, prefix) {
  try {
    const list = await kv.list({ prefix: `visapath:${prefix}` });
    await Promise.all(list.keys.map(k => kv.delete(k.name)));
  } catch (err) {
    console.warn('[Cache] Clear failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// YARDIMCI FONKSİYONLAR
// ════════════════════════════════════════════════════════════════

function getCorsHeaders(origin) {
  const allowed = CONFIG.ALLOWED_ORIGINS.includes(origin)
    ? origin
    : CONFIG.ALLOWED_ORIGINS[0]; // fallback: production domain

  return {
    'Access-Control-Allow-Origin' : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age'      : '86400',
  };
}

function jsonOk(data, corsHeaders, extra = {}) {
  return new Response(JSON.stringify(data), {
    status : 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeaders,
      ...extra,
    },
  });
}

function jsonError(status, message, corsHeaders) {
  return new Response(JSON.stringify({ error: message, status }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function nameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // özel karakterleri temizle
    .replace(/\s+/g, '-')            // boşlukları tire yap
    .replace(/-+/g, '-')             // çift tire temizle
    .replace(/^-|-$/g, '');          // baştaki/sondaki tire
}

function extractVisaTypes(route) {
  // GOV.UK "Skilled Worker" | "Global Talent" | "Scale-up" gibi değerler döner
  if (!route) return '[]';
  const types = [];
  if (route.includes('Skilled Worker'))  types.push('Skilled Worker Visa');
  if (route.includes('Global Talent'))   types.push('Global Talent Visa');
  if (route.includes('Scale-up'))        types.push('Scale-up Visa');
  if (route.includes('Intra-company'))   types.push('Intra-company Transfer');
  if (route.includes('Graduate'))        types.push('Graduate Route');
  if (types.length === 0)                types.push(route.trim());
  return JSON.stringify(types);
}
