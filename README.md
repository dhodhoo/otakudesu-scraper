# otakudesu-scrape

Scraper Otakudesu untuk metadata anime, episode, dan URL streaming — tersedia sebagai CLI dan modul Node.js.

> **Catatan:** Project ini dibuat untuk keperluan edukasi dan pemakaian pribadi. Hormati ToS Otakudesu. Tanggung jawab penggunaan ada di pihak pengguna. Lihat [Disclaimer](#disclaimer) di bawah.

## Fitur

- Metadata anime lengkap (judul, sinopsis, genre, status, studio, skor, dll.)
- Resolusi URL streaming per episode via pipeline AJAX nonce (paralel, host-tagged)
- Download links per kualitas dengan multi-host (ODFiles, Mega, Acefile, GoFile, dll.) + ukuran file
- Halaman pendukung: home, ongoing/complete (paginated), anime list A–Z, genre, schedule, search
- Auto-detect URL `/anime/` vs `/episode/`
- CLI lengkap + API programmatic
- **HTTP API server** (`server.js`) untuk dikonsumsi frontend, lengkap dengan caching, rate limit, retry, dan CORS
- Opsi `skipMirrors` dan `mirrorConcurrency` untuk performa

## Instalasi

Prasyarat: **Node.js 18+** (butuh `fetch` native).

```bash
git clone <repo>
cd otakudesu-scrape
npm install
```

Dependencies: `cheerio` (scraper), `hono` + `@hono/node-server` + `lru-cache` + `p-limit` (server).

## Pemakaian CLI

```bash
node scrape.js <url>                          # auto-detect /anime/ atau /episode/
node scrape.js --episode <url> [--skip-mirrors]
node scrape.js --anime <url>
node scrape.js --home
node scrape.js --ongoing [--page N]
node scrape.js --complete [--page N]
node scrape.js --list
node scrape.js --genres
node scrape.js --genre <slug-atau-url> [--page N]
node scrape.js --schedule
node scrape.js --search <keyword>
node scrape.js --help
```

Contoh:

```bash
node scrape.js --ongoing --page 2
node scrape.js --genre comedy --page 3
node scrape.js --search "naruto"
node scrape.js "https://otakudesu.blog/anime/nigashita-sakana-sub-indo/"
node scrape.js --episode "https://otakudesu.blog/episode/nsot-episode-8-sub-indo/" --skip-mirrors
```

Output adalah JSON ke stdout. Contoh ringkas (`--genres`):

```json
{
  "genreListUrl": "https://otakudesu.blog/genre-list/",
  "count": 36,
  "genres": [
    { "name": "Action", "url": "https://otakudesu.blog/genres/action/", "slug": "action" },
    { "name": "Comedy", "url": "https://otakudesu.blog/genres/comedy/", "slug": "comedy" }
  ]
}
```

## HTTP API Server

`server.js` membungkus semua fungsi scraper sebagai REST API — cocok untuk dikonsumsi frontend (React/Vue/dst.) tanpa scraping di client.

### Menjalankan

```bash
npm run start:api
# atau
node server.js
```

Default port 3000. Test bahwa server hidup:

```bash
curl http://localhost:3000/        # daftar endpoint
curl http://localhost:3000/healthz # { ok: true, cache: ... }
```

### Endpoint

| Method | Path | Query | Equivalent |
|---|---|---|---|
| GET | `/` | — | Daftar endpoint |
| GET | `/healthz` | — | Health check + ukuran cache |
| GET | `/api/home` | — | `scrapeHome()` |
| GET | `/api/ongoing` | `page` | `scrapeOngoing({page})` |
| GET | `/api/complete` | `page` | `scrapeComplete({page})` |
| GET | `/api/anime-list` | — | `scrapeAnimeList()` |
| GET | `/api/genres` | — | `listGenres()` |
| GET | `/api/genre/:slug` | `page` | `scrapeGenre(slug, {page})` |
| GET | `/api/schedule` | — | `scrapeSchedule()` |
| GET | `/api/search` | `q` *(required)* | `search(q)` |
| GET | `/api/anime/:slug` | — | `scrapeAnime(url)` |
| GET | `/api/episode/:slug` | `skipMirrors=1` | `scrapeEpisode(url, {skipMirrors})` |

Response selalu JSON. Header `X-Cache: HIT` / `MISS` menunjukkan apakah response berasal dari cache.

Contoh dari frontend:

```js
const home = await fetch("http://localhost:3000/api/home").then((r) => r.json());
const anime = await fetch("http://localhost:3000/api/anime/nigashita-sakana-sub-indo")
  .then((r) => r.json());
const search = await fetch(`/api/search?q=${encodeURIComponent("naruto")}`)
  .then((r) => r.json());
```

> **Panduan lengkap untuk frontend** (helper client, React hook, Vue composable, TypeScript types, error handling, pagination, dll.) ada di **[`frontend-guide.md`](frontend-guide.md)**.

### Konfigurasi via env vars

| Var | Default | Fungsi |
|---|---|---|
| `SERVER_PORT` / `PORT` | `3000` | Port server. Pterodactyl pakai `SERVER_PORT`, host lain biasanya `PORT`. Server pilih otomatis. |
| `ALLOWED_ORIGINS` | `*` | CORS whitelist, koma-separated. Untuk production isi domain frontend, mis. `https://app.example.com,https://staging.example.com` |
| `API_KEY` | *(unset)* | Kalau diset, semua `/api/*` butuh header `X-API-Key: <value>` |
| `RATE_LIMIT` | `60` | Max request per IP per menit (inbound) |
| `OUTBOUND_CONCURRENCY` | `3` | Max request paralel ke Otakudesu (global, semua user) |
| `HTTP_PROXY` | *(unset)* | Proxy URL untuk outbound, mis. `http://user:pass@host:port`. Butuh `npm i https-proxy-agent` |

Contoh production:

```bash
PORT=8080 \
ALLOWED_ORIGINS=https://myapp.com \
API_KEY=secret123 \
RATE_LIMIT=120 \
OUTBOUND_CONCURRENCY=2 \
node server.js
```

### Caching

Per-endpoint TTL (otomatis):

| Endpoint | TTL |
|---|---|
| `/api/home`, `/api/episode/*`, `/api/search`, `/api/ongoing` | 5–10 menit |
| `/api/genre/*`, `/api/anime/*` | 30–60 menit |
| `/api/complete`, `/api/schedule` | 1–6 jam |
| `/api/anime-list`, `/api/genres` | 24 jam |

LRU cache in-memory (`lru-cache`), max 1000 entries. Hilang saat restart — kalau butuh persistent, ganti dengan Redis di `server.js`.

### Anti-ban

Server sudah punya:

- **Caching agresif** — sangat mengurangi request ke Otakudesu
- **Outbound concurrency limit** (`p-limit`) — max 3 request paralel ke Otakudesu meski ada ribuan client
- **Retry + exponential backoff** — di `fetchWithRetry` (`scrape.js`), retry pada 429/5xx dan network error
- **Header browser lengkap** — User-Agent, Accept-Language, Sec-Fetch-*, dll. realistis
- **Inbound rate limit** per IP — protect API dari abuse
- **Timeout** 20s per outbound request
- **Proxy support** — set `HTTP_PROXY` kalau IP server mulai di-block

### Manual testing

`test-api.js` adalah smoke test ringan. Pakai:

```bash
# Terminal 1
npm run start:api

# Terminal 2
node test-api.js
# atau dengan custom URL/key:
BASE=http://localhost:8080 API_KEY=secret123 node test-api.js
```

Script ini akan hit tiap endpoint 2x dan cek bahwa call kedua dilayani dari cache (`X-Cache: HIT`).

### Catatan deploy

- **Pterodactyl Node.js egg** — lihat [Deploy ke Pterodactyl](#deploy-ke-pterodactyl) di bawah.
- **Fly.io / Railway** — cocok untuk Node persistent. Set env vars via dashboard, deploy `npm run start:api`.
- **Vercel / Netlify** — works untuk endpoint ringan, tapi awas timeout 10s untuk `/api/episode/*` tanpa `skipMirrors=1` (mirror resolution bisa 5-10s).
- **VPS** — `pm2 start server.js --name otakudesu-api` untuk daemonize.
- **Docker** — Node 20-alpine + `COPY . . && npm ci --omit=dev && CMD ["node","server.js"]`.

### Deploy ke Pterodactyl

Pterodactyl punya egg Node.js generik. Server.js sudah otomatis baca `SERVER_PORT` yang di-inject panel.

**Langkah:**

1. **Upload kode** — via SFTP atau file manager panel, upload semua kecuali `node_modules/` dan `.env`.
2. **Startup command** — di tab Startup, set:
   ```
   npm install --omit=dev && node server.js
   ```
   (atau pisah: install sekali via console, lalu startup tinggal `node server.js`)
3. **Environment Variables** — di tab Variables / Startup, tambahkan:
   - `ALLOWED_ORIGINS` — domain frontend Anda (mis. `https://app.example.com`). Untuk testing awal boleh `*`.
   - `API_KEY` — string random panjang. Generate dengan:
     ```bash
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
     ```
   - `RATE_LIMIT` — `60` (atau sesuai kebutuhan)
   - `OUTBOUND_CONCURRENCY` — `3` (turunkan kalau Otakudesu mulai 429)
4. **Allocation** — pastikan port allocation yang di-assign panel sama dengan `SERVER_PORT` (Pterodactyl otomatis inject).
5. **Start** — klik Start. Cek konsol — harus muncul `API ready on http://0.0.0.0:<port>`.
6. **Test dari luar** — `curl -H "X-API-Key: <your-key>" https://<panel-domain>:<port>/healthz`.

**Tips:**

- Pterodactyl tidak butuh Docker — egg Node.js sudah handle Node runtime.
- Resource: scraper ini ringan, **256-512 MB RAM** cukup untuk personal/small frontend.
- Kalau IP server Pterodactyl di-flag Otakudesu (jarang, tapi mungkin), set `HTTP_PROXY` di Variables + jalankan `npm i https-proxy-agent` lewat konsol panel.
- Log otomatis muncul di console panel.
- Restart otomatis (auto-restart) sudah disediakan Pterodactyl — graceful shutdown tidak wajib untuk setup ini.

## API Programmatic

Semua fungsi adalah ES module export dari `scrape.js`.

```js
import {
  scrapeHome, scrapeOngoing, scrapeComplete,
  scrapeAnimeList, listGenres, scrapeGenre,
  scrapeSchedule, search,
  scrapeAnime, scrapeEpisode,
} from "./scrape.js";
```

### `scrapeHome(homeUrl?)`

Halaman beranda — daftar update ongoing + complete teratas.

Return: `{ homeUrl, ongoing[], complete[], sections[] }`. Item `ongoing` punya `{title, url, slug, image, date, currentEpisode, day}`; item `complete` punya `{title, url, slug, image, date, totalEpisodes, score}`.

```js
const home = await scrapeHome();
console.log(home.ongoing.length, "anime sedang tayang");
```

### `scrapeOngoing({ page })` / `scrapeComplete({ page })`

Daftar lengkap ongoing/complete dengan pagination (~25 anime per halaman).

Return: `{ url, kind, count, items[], pagination: { current, totalPages, nextUrl, prevUrl } }`.

```js
const p1 = await scrapeOngoing({ page: 1 });
const p2 = await scrapeOngoing({ page: 2 });
```

### `scrapeAnimeList(listUrl?)`

Direktori A–Z seluruh anime. Sekali fetch dapat ~1800+ anime, dikelompokkan per huruf.

Return: `{ listUrl, totalAnime, groups: [{letter, count, anime: [{title, url, slug, fullTitle}]}] }`.

```js
const all = await scrapeAnimeList();
console.log("Total:", all.totalAnime);
```

### `listGenres(genreListUrl?)`

Daftar semua genre yang tersedia.

Return: `{ genreListUrl, count, genres: [{name, url, slug}] }`.

### `scrapeGenre(slugOrUrl, { page })`

Daftar anime per genre (paginated, ~15 per halaman). Argumen bisa slug (`"comedy"`) atau URL penuh.

Return: `{ url, slug, count, items[], pagination }`. Tiap item: `{title, url, slug, studio, episodes, rating, genres[], image, synopsis, season}`.

```js
const comedy = await scrapeGenre("comedy", { page: 1 });
```

### `scrapeSchedule(scheduleUrl?)`

Jadwal rilis per hari.

Return: `{ scheduleUrl, days: [{day, count, anime: [{title, url, slug}]}] }`. Selain Senin–Minggu, kadang ada group `"Random"` untuk anime tanpa jadwal tetap.

### `search(keyword, { baseUrl? })`

Cari berdasarkan keyword.

Return: `{ keyword, url, count, items: [{title, url, kind, slug, status, rating, genres}] }`. Field `kind` bernilai `"episode"`, `"anime"`, atau `"other"` — Otakudesu default mengembalikan hasil **episode** (lihat [Limitasi](#catatan--limitasi)).

### `scrapeAnime(animeUrl)`

Metadata anime lengkap + daftar episode.

Return: `{ animeUrl, title, image, info, synopsis, episodeCount, episodes[], batches[] }`.

`info` berisi: `{ judul, japanese, skor, produser, tipe, status, totalEpisode, durasi, tanggalRilis, studio, genres[] }`.

Tiap entry `episodes`/`batches`: `{ title, url, slug, episode, date }`.

```js
const anime = await scrapeAnime("https://otakudesu.blog/anime/nigashita-sakana-sub-indo/");
console.log(anime.info.genres);     // ["Comedy", "Fantasy", "Romance"]
console.log(anime.episodes[0].url); // episode terbaru
```

### `scrapeEpisode(episodeUrl, options?)`

Detail episode: metadata, navigasi, link unduh, dan URL streaming dari semua mirror.

Options:
- `skipMirrors: boolean` — jika `true`, lewati AJAX mirror resolution (hanya kembalikan token mentah). Default `false`.
- `mirrorConcurrency: number` — jumlah request mirror paralel. Default `5`.

Return:

```js
{
  episodeUrl, slug, title,
  animeUrl, animeSlug,
  prevEpisodeUrl, nextEpisodeUrl,
  episodeList: [{ url, slug, label, episode }],
  defaultIframe,
  downloads: [{
    heading,
    items: [{ quality, sizeMB, links: [{ host, url }] }]
  }],
  mirrors: [{ quality, mirrorIndex, host, iframeUrl, directUrl }]
}
```

```js
const ep = await scrapeEpisode(url, { skipMirrors: true });    // cepat, tanpa AJAX
const full = await scrapeEpisode(url, { mirrorConcurrency: 8 }); // lebih cepat
```

## Pipeline Streaming (`scrapeEpisode`)

URL streaming di Otakudesu tidak langsung terlihat di HTML. Pipeline-nya:

1. **Parse token** — halaman episode mengandung `<a data-content="<base64>">` di blok `.mirrorstream`. Tiap token decode jadi `{id, i, q}` (mirror index, quality).
2. **Ambil nonce** — POST `action=aa1208d27f29ca340c92c66d1926f13f` ke `/wp-admin/admin-ajax.php` → `{"data": "<nonce>"}`.
3. **Resolve mirror** — POST `{id, i, q, nonce, action=2a3505c93b0035d3f455df82bf976b84}` ke endpoint yang sama → `{"data": "<base64 iframe HTML>"}`.
4. **Ekstrak URL langsung** — decode iframe HTML, cari `<source src>` atau `<video src>` jika host sederhana (mis. `desustream.info`).

Untuk host yang membangun player via JavaScript runtime (Filemoon, Streamtape, dll.), `directUrl` akan `null` — consumer harus pakai `iframeUrl` sebagai jalur embed.

## Struktur Project

```
otakudesu-scrape/
├── scrape.js          # semua scraper + CLI entrypoint
├── server.js          # HTTP API (Hono) — bungkus scrape.js dengan cache + rate limit
├── test-api.js        # smoke test untuk endpoint API
├── frontend-guide.md  # panduan konsumsi API dari frontend
├── package.json
├── .gitignore
├── .env.example       # contoh konfigurasi env vars
├── samples/           # golden HTML samples untuk verifikasi struktur
│   ├── home.html
│   ├── anime.html
│   ├── episode.html
│   ├── embed.html
│   ├── ongoing.html
│   ├── complete.html
│   ├── animeList.html
│   ├── genreList.html
│   ├── genrePage.html
│   ├── schedule.html
│   └── search.html
└── README.md
```

## Catatan & Limitasi

- **Domain hardcoded** — saat ini default ke `otakudesu.blog`. Otakudesu sering pindah domain (`.blog` → `.cloud` → dst); jika down, fungsi yang punya parameter URL (`scrapeHome(url)`, `scrapeAnimeList(url)`, dll.) bisa di-override.
- **`search()` mengembalikan episode**, bukan anime — ini perilaku default WordPress search di situs. Field `kind` bisa dipakai untuk filter, atau bisa map balik ke anime via `animeSlug` dari `scrapeEpisode`.
- **`directUrl` tidak universal** — host yang merangkai URL via JavaScript runtime tidak ter-extract dengan regex DOM. Untuk host kompleks, jalur `iframeUrl` adalah fallback yang valid.
- **Layout halaman bisa berubah** — semua scraper bergantung pada selector CSS Otakudesu. Jika layout di-update, scraper bisa break sampai selector disesuaikan. Sample HTML di `samples/` berguna untuk reproduksi & perbaikan.
- **Tidak ada rate limiting bawaan** — caller bertanggung jawab atas delay/concurrency saat scrape banyak halaman.

## Disclaimer

Project ini disediakan **apa adanya** untuk tujuan edukasi dan pemakaian pribadi (mempelajari teknik web scraping, eksplorasi struktur situs, automasi metadata untuk koleksi pribadi).

Penggunaan tools ini untuk redistribusi konten, keperluan komersial, atau aktivitas yang melanggar hak cipta pemilik konten **bukan tanggung jawab penulis**. Hormati Terms of Service Otakudesu dan studio anime terkait. Jika Anda pemilik hak cipta dan keberatan dengan keberadaan project ini, hubungi maintainer untuk request penghapusan.

Pengguna bertanggung jawab penuh atas cara mereka menggunakan kode ini.
