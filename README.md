# VisaPath Worker — Deploy Kılavuzu

## Ön Gereksinimler
- Node.js 18+
- Cloudflare hesabı (ücretsiz)
- `npm install -g wrangler`

## İlk Kurulum (tek seferlik ~10 dakika)

```bash
# 1. Wrangler ile Cloudflare'e giriş yap
wrangler login

# 2. D1 database oluştur
wrangler d1 create visapath-db
# → Çıktıdaki database_id'yi wrangler.toml'a yaz

# 3. KV namespace oluştur (cache için)
wrangler kv:namespace create CACHE
# → Çıktıdaki id'yi wrangler.toml'a yaz

# 4. Schema + seed data yükle
wrangler d1 execute visapath-db --file=schema.sql

# 5. Sync secret ayarla
wrangler secret put SYNC_SECRET
# → İstediğin güçlü bir şifre gir (örn: openssl rand -hex 32)

# 6. Deploy et
wrangler deploy
```

## Worker URL'ini Al

Deploy sonrası URL şu formatta olur:
`https://visapath-worker.YOUR_SUBDOMAIN.workers.dev`

Bu URL'i index.html'deki `WORKER_URL` sabitine yaz.

## İlk Veri Sync'i

Worker deploy edildikten sonra GOV.UK sync'ini manuel tetikle:

```bash
curl -X POST https://visapath-worker.YOUR_SUBDOMAIN.workers.dev/api/sync \
  -H "Authorization: Bearer YOUR_SYNC_SECRET"
```

~52.000 sponsor kaydı yüklemek 3-5 dakika sürer.

## API Endpoint'leri

| Endpoint | Açıklama |
|----------|----------|
| `GET /api/health` | Worker + DB sağlık durumu |
| `GET /api/stats` | Toplam sponsor/iş sayısı |
| `GET /api/jobs?q=engineer&city=London&sector=IT` | İş ara |
| `GET /api/sponsors?name=revolut&country=GB` | Sponsor ara |
| `GET /api/sponsor/:slug` | Tek sponsor detayı |
| `POST /api/sync` | Manuel sync (Bearer token gerekli) |

## Otomatik Sync

`wrangler.toml`'da tanımlı cron: **Her Pazartesi 06:00 UTC**

GOV.UK genellikle Pazartesi sabahı listeyi günceller. Sync log'unu kontrol et:

```bash
wrangler d1 execute visapath-db --command="SELECT * FROM sync_log ORDER BY id DESC LIMIT 5"
```

## Frontend Entegrasyonu

`index.html`'de `WORKER_URL` sabitini güncelle:
```js
const WORKER_URL = 'https://visapath-worker.YOUR_SUBDOMAIN.workers.dev';
```

Tüm API çağrıları bu URL üzerinden yapılır.

## Maliyet

Cloudflare Workers **Free Plan** ile tamamen ücretsiz:
- 100.000 istek/gün
- D1: 5GB depolama, 25M okuma/gün
- KV: 100.000 okuma/gün

VisaPath'in tahmini trafiği bu limitler içinde kalır.
