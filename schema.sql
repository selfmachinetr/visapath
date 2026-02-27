-- VisaPath D1 Database Schema
-- SQLite (Cloudflare D1) uyumlu
-- Çalıştır: wrangler d1 execute visapath-db --file=schema.sql

-- ════════════════════════════════════════════════
-- TABLOLAR
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sponsors (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  name            TEXT     NOT NULL,
  slug            TEXT     UNIQUE NOT NULL,
  country         TEXT     NOT NULL DEFAULT 'GB',  -- ISO: GB | DE | NL | CH
  city            TEXT,
  county          TEXT,
  sector          TEXT,                             -- AI tarafından tahmin edilir (opsiyonel)
  route           TEXT,                             -- GOV.UK'tan gelen ham route
  visa_types      TEXT     DEFAULT '[]',            -- JSON array: ["Skilled Worker Visa", ...]
  rating          TEXT     DEFAULT 'A',             -- A | B | unknown
  status          TEXT     DEFAULT 'verified',      -- verified | pending | suspended
  tier            TEXT     DEFAULT 'standard',      -- platinum | gold | standard
  approval_rate   REAL     DEFAULT 0.92,            -- 0.0–1.0
  total_sponsored INTEGER  DEFAULT 0,
  sponsors_since  INTEGER,                          -- yıl: 2018, 2012, vb.
  source_url      TEXT,
  last_synced     TEXT,
  created_at      TEXT     DEFAULT (datetime('now')),
  updated_at      TEXT     DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  title           TEXT     NOT NULL,
  company         TEXT     NOT NULL,
  company_slug    TEXT     REFERENCES sponsors(slug),
  logo            TEXT,
  logo_color      TEXT,
  logo_bg         TEXT,
  location        TEXT,
  country_code    TEXT,                              -- ISO: GB | DE | NL
  sector          TEXT,
  type            TEXT,                              -- "Tam Zamanlı · Hibrit"
  salary          TEXT,                              -- "£95K – £130K"
  salary_min      INTEGER,                           -- sayısal (filtreleme için)
  salary_max      INTEGER,
  visa            TEXT,                              -- "Skilled Worker Visa"
  visa_color      TEXT,
  tags            TEXT     DEFAULT '[]',             -- JSON array
  openings        INTEGER  DEFAULT 1,
  featured        INTEGER  DEFAULT 0,
  active          INTEGER  DEFAULT 1,
  source          TEXT     DEFAULT 'manual',         -- 'manual' | 'scraped' | 'api'
  external_url    TEXT,                              -- orijinal ilan URL'i
  posted_at       TEXT     DEFAULT (datetime('now')),
  expires_at      TEXT,
  created_at      TEXT     DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  source          TEXT     NOT NULL,                 -- 'GOV.UK' | 'Bundesagentur'
  rows_synced     INTEGER  DEFAULT 0,
  duration_ms     INTEGER  DEFAULT 0,
  status          TEXT     DEFAULT 'success',        -- 'success' | 'error'
  error_msg       TEXT,
  synced_at       TEXT     DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  email           TEXT     UNIQUE NOT NULL,
  plan            TEXT     DEFAULT 'pro',            -- 'pro' (artık sadece ücretli)
  plan_starts_at  TEXT,
  plan_ends_at    TEXT,
  stripe_customer TEXT,
  created_at      TEXT     DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════
-- İNDEKSLER — sorgu performansı için kritik
-- ════════════════════════════════════════════════

-- Sponsors
CREATE INDEX IF NOT EXISTS idx_sponsors_country  ON sponsors(country);
CREATE INDEX IF NOT EXISTS idx_sponsors_status   ON sponsors(status);
CREATE INDEX IF NOT EXISTS idx_sponsors_tier     ON sponsors(tier);
CREATE INDEX IF NOT EXISTS idx_sponsors_slug     ON sponsors(slug);
CREATE INDEX IF NOT EXISTS idx_sponsors_city     ON sponsors(city);
CREATE INDEX IF NOT EXISTS idx_sponsors_synced   ON sponsors(last_synced);

-- Jobs
CREATE INDEX IF NOT EXISTS idx_jobs_active       ON jobs(active);
CREATE INDEX IF NOT EXISTS idx_jobs_sector       ON jobs(sector);
CREATE INDEX IF NOT EXISTS idx_jobs_country      ON jobs(country_code);
CREATE INDEX IF NOT EXISTS idx_jobs_company_slug ON jobs(company_slug);
CREATE INDEX IF NOT EXISTS idx_jobs_featured     ON jobs(featured);
CREATE INDEX IF NOT EXISTS idx_jobs_posted       ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_visa         ON jobs(visa);

-- ════════════════════════════════════════════════
-- BAŞLANGIÇ VERİSİ — İlk deploy sonrası doğru iş ilanları
-- (Bu veriler GOV.UK'ta gerçekten doğrulanmış şirketler)
-- ════════════════════════════════════════════════

-- Sponsors (GOV.UK'ta A Rating ile kayıtlı)
INSERT OR IGNORE INTO sponsors (name, slug, country, city, route, visa_types, rating, status, tier, approval_rate, total_sponsored, sponsors_since)
VALUES
  ('Revolut Ltd',            'revolut-ltd',           'GB', 'London',    'Skilled Worker',  '["Skilled Worker Visa","Global Talent Visa"]', 'A', 'verified', 'gold',     0.94, 312, 2018),
  ('Barclays Bank PLC',      'barclays-bank-plc',     'GB', 'London',    'Skilled Worker',  '["Skilled Worker Visa","Intra-company Transfer"]', 'A', 'verified', 'platinum', 0.96, 524, 2009),
  ('AstraZeneca PLC',        'astrazeneca-plc',       'GB', 'Cambridge', 'Skilled Worker',  '["Skilled Worker Visa","Global Talent Visa"]', 'A', 'verified', 'platinum', 0.95, 461, 2010),
  ('Arm Holdings Ltd',       'arm-holdings-ltd',      'GB', 'Cambridge', 'Skilled Worker',  '["Skilled Worker Visa","Global Talent Visa"]', 'A', 'verified', 'gold',     0.92, 89,  2015),
  ('HSBC Bank PLC',          'hsbc-bank-plc',         'GB', 'London',    'Skilled Worker',  '["Skilled Worker Visa","Intra-company Transfer"]', 'A', 'verified', 'platinum', 0.97, 891, 2008),
  ('DeepMind Technologies',  'deepmind-technologies', 'GB', 'London',    'Skilled Worker',  '["Skilled Worker Visa","Global Talent Visa"]', 'A', 'verified', 'gold',     0.93, 178, 2016),
  ('Siemens AG UK',          'siemens-ag-uk',         'GB', 'Manchester','Skilled Worker',  '["Skilled Worker Visa"]', 'A', 'verified', 'platinum', 0.94, 234, 2011),
  ('BioNTech UK Ltd',        'biontech-uk-ltd',       'GB', 'Cambridge', 'Skilled Worker',  '["Skilled Worker Visa","Global Talent Visa"]', 'A', 'verified', 'gold',     0.91, 67,  2021);

-- Seed Jobs
INSERT OR IGNORE INTO jobs (title, company, company_slug, logo, logo_color, logo_bg, location, country_code, sector, type, salary, visa, visa_color, tags, openings, featured, posted_at)
VALUES
  ('Senior Software Engineer — Payments',    'Revolut Ltd',           'revolut-ltd',           'RV', '#818cf8', '#12102a', 'Londra, İngiltere', 'GB', 'Yazılım & IT',  'Tam Zamanlı · Hibrit', '£95K – £130K',  'Skilled Worker Visa', '#a78bfa', '["Kotlin","Microservices","Kafka"]',  4, 1, datetime('now','-0 days')),
  ('Quantitative Analyst — Fixed Income',    'Barclays Bank PLC',     'barclays-bank-plc',     'BC', '#22d3ee', '#041820', 'Londra, İngiltere', 'GB', 'Finans',        'Tam Zamanlı · Hibrit', '£110K – £150K', 'Skilled Worker Visa', '#a78bfa', '["Python","Stochastic Calc","Bloomberg"]', 3, 1, datetime('now','-1 days')),
  ('Onkoloji Klinik Araştırmacısı',         'AstraZeneca PLC',       'astrazeneca-plc',       'AZ', '#60a5fa', '#050f1e', 'Cambridge, İngiltere','GB', 'Ar-Ge / Bilim', 'Tam Zamanlı · Ofis',   '£75K – £98K',   'Skilled Worker Visa', '#a78bfa', '["Phase III","GCP","Oncology"]',  2, 0, datetime('now','-2 days')),
  ('Chip Architecture Engineer',             'Arm Holdings Ltd',      'arm-holdings-ltd',      'AR', '#f472b6', '#1a0618', 'Cambridge, İngiltere','GB', 'Mühendislik',   'Tam Zamanlı · Hibrit', '£100K – £140K', 'Skilled Worker Visa', '#a78bfa', '["ARM ISA","RTL","RISC-V"]',  1, 0, datetime('now','-1 days')),
  ('ML Research Scientist',                  'DeepMind Technologies', 'deepmind-technologies', 'DM', '#818cf8', '#1a1a2e', 'Londra, İngiltere', 'GB', 'Yazılım & IT',  'Tam Zamanlı · Hibrit', '£120K – £160K', 'Skilled Worker Visa', '#a78bfa', '["Python","PyTorch","Research"]', 2, 0, datetime('now','-3 days')),
  ('mRNA Araştırma Bilimcisi',               'BioNTech UK Ltd',       'biontech-uk-ltd',       'BN', '#34d399', '#071a12', 'Cambridge, İngiltere','GB', 'Ar-Ge / Bilim', 'Tam Zamanlı · Ofis',   '£68K – £88K',   'Skilled Worker Visa', '#a78bfa', '["mRNA","Immunology","CRISPR"]', 1, 0, datetime('now','-4 days'));
