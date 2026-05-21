# Panduan Frontend

Cara mengkonsumsi otakudesu-scrape HTTP API dari frontend (React, Vue, Svelte, vanilla, dst.).

## Konfigurasi dasar

### 1. Environment variable untuk base URL

Jangan hardcode URL API di kode. Pakai env var sesuai framework:

| Framework | File | Variable name |
|---|---|---|
| Vite (React/Vue/Svelte) | `.env.local` | `VITE_API_BASE_URL` |
| Next.js | `.env.local` | `NEXT_PUBLIC_API_BASE_URL` |
| Create React App | `.env.local` | `REACT_APP_API_BASE_URL` |
| Nuxt | `.env` | `NUXT_PUBLIC_API_BASE_URL` |

Contoh isi (`.env.local`):

```env
VITE_API_BASE_URL=https://your-api.xbotzlauncher.site
VITE_API_KEY=8936c63f3246c38e3771a426b598244170a13f663a8715c8
```

> **Peringatan:** API key di frontend = bisa dilihat siapa saja yang inspect network tab. Untuk keamanan asli, route via backend Anda sendiri (BFF pattern). Tapi untuk personal project ini OK sebagai layer "anti-leech" ringan.

### 2. Helper client minimal (framework-agnostic)

Simpan sebagai `src/lib/api.js` (atau `.ts`):

```js
const BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const KEY = import.meta.env.VITE_API_KEY || "";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { params, signal } = {}) {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    headers: KEY ? { "X-API-Key": KEY } : {},
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
```

Pakai:

```js
import { api } from "./lib/api.js";

const home = await api("/api/home");
const ongoing = await api("/api/ongoing", { params: { page: 2 } });
const result = await api("/api/search", { params: { q: "naruto" } });
const anime = await api(`/api/anime/${slug}`);
```

## Endpoint cheatsheet

Semua return JSON. Detail field di [`README.md`](README.md#api-programmatic).

| Path | Query | Output ringkas |
|---|---|---|
| `/api/home` | — | `{ ongoing[], complete[] }` |
| `/api/ongoing` | `page` | `{ items[], pagination }` |
| `/api/complete` | `page` | `{ items[], pagination }` |
| `/api/anime-list` | — | `{ groups: [{letter, anime[]}] }` |
| `/api/genres` | — | `{ genres: [{name, slug}] }` |
| `/api/genre/:slug` | `page` | `{ items[], pagination }` |
| `/api/schedule` | — | `{ days: [{day, anime[]}] }` |
| `/api/search` | `q` *(required)* | `{ items[] }` |
| `/api/anime/:slug` | — | `{ title, info, synopsis, episodes[] }` |
| `/api/episode/:slug` | `skipMirrors=1` | `{ downloads[], mirrors[] }` |

## Error handling

| Status | Arti | Solusi |
|---|---|---|
| `200` | OK | — |
| `400` | Bad request (mis. `q` kosong di search) | Validasi input di client |
| `401` | API key invalid / missing | Cek header `X-API-Key` |
| `429` | Rate limit (60 req/menit per IP) | Slow down, atau cache di client juga |
| `502` | Scrape gagal (Otakudesu down/changed) | Retry atau tampilkan error friendly |

Tangkap pakai `ApiError`:

```js
try {
  const data = await api("/api/anime/some-slug");
} catch (err) {
  if (err.status === 429) {
    showToast("Terlalu banyak request, coba lagi nanti.");
  } else if (err.status === 502) {
    showToast("Sumber data sedang bermasalah.");
  } else {
    showToast("Gagal memuat data: " + err.message);
  }
}
```

## React

### Custom hook `useApi`

```js
// src/hooks/useApi.js
import { useEffect, useState, useRef } from "react";
import { api } from "../lib/api.js";

export function useApi(path, params) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    if (!path) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    api(path, { params, signal: ac.signal })
      .then((d) => setData(d))
      .catch((err) => {
        if (err.name !== "AbortError") setError(err);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [path, paramsKey]);

  return { data, loading, error };
}
```

### Contoh komponen

```jsx
import { useApi } from "./hooks/useApi.js";

export function HomePage() {
  const { data, loading, error } = useApi("/api/home");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;

  return (
    <div>
      <h2>On-going</h2>
      <ul>
        {data.ongoing.map((a) => (
          <li key={a.slug}>
            <img src={a.image} width="80" />
            {a.title} — Episode {a.currentEpisode} ({a.day})
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Paginated list

```jsx
import { useState } from "react";
import { useApi } from "./hooks/useApi.js";

export function OngoingList() {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi("/api/ongoing", { page });

  return (
    <div>
      {loading && <p>Loading…</p>}
      {data?.items.map((a) => (
        <article key={a.slug}>{a.title}</article>
      ))}
      <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
        Prev
      </button>
      <span> Page {page} / {data?.pagination?.totalPages ?? "?"} </span>
      <button
        onClick={() => setPage((p) => p + 1)}
        disabled={!data?.pagination?.nextUrl}
      >
        Next
      </button>
    </div>
  );
}
```

### Search dengan debounce

```jsx
import { useState, useEffect } from "react";
import { api } from "./lib/api.js";

export function SearchBox() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);

  useEffect(() => {
    if (q.length < 3) return;
    const id = setTimeout(async () => {
      const r = await api("/api/search", { params: { q } });
      setResults(r.items);
    }, 350);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari anime…" />
      <ul>
        {results.map((r) => (
          <li key={r.url}>{r.title} ({r.kind})</li>
        ))}
      </ul>
    </div>
  );
}
```

## Vue 3

### Composable `useApi`

```js
// src/composables/useApi.js
import { ref, watch, toValue } from "vue";
import { api } from "../lib/api.js";

export function useApi(pathGetter, paramsGetter) {
  const data = ref(null);
  const loading = ref(true);
  const error = ref(null);

  let abort;
  async function load() {
    const path = toValue(pathGetter);
    const params = toValue(paramsGetter);
    if (!path) return;
    abort?.abort();
    abort = new AbortController();
    loading.value = true;
    error.value = null;
    try {
      data.value = await api(path, { params, signal: abort.signal });
    } catch (err) {
      if (err.name !== "AbortError") error.value = err;
    } finally {
      loading.value = false;
    }
  }

  watch([() => toValue(pathGetter), () => toValue(paramsGetter)], load, {
    immediate: true,
    deep: true,
  });

  return { data, loading, error, reload: load };
}
```

### Komponen Vue

```vue
<script setup>
import { ref } from "vue";
import { useApi } from "./composables/useApi.js";

const page = ref(1);
const { data, loading, error } = useApi(
  () => "/api/ongoing",
  () => ({ page: page.value })
);
</script>

<template>
  <p v-if="loading">Loading…</p>
  <p v-else-if="error">Error: {{ error.message }}</p>
  <div v-else>
    <article v-for="a in data.items" :key="a.slug">
      <img :src="a.image" width="80" />
      <h3>{{ a.title }}</h3>
      <p>Episode {{ a.currentEpisode }} — {{ a.day }}</p>
    </article>
    <button @click="page--" :disabled="page <= 1">Prev</button>
    <span> Page {{ page }} </span>
    <button @click="page++">Next</button>
  </div>
</template>
```

## TypeScript types

Simpan sebagai `src/types/api.ts`:

```ts
export interface OngoingItem {
  title: string;
  url: string;
  slug: string;
  image: string;
  date: string;
  currentEpisode: string;
  day: string;
}

export interface CompleteItem {
  title: string;
  url: string;
  slug: string;
  image: string;
  date: string;
  totalEpisodes: string;
  score: string;
}

export interface Pagination {
  current: number;
  totalPages: number;
  nextUrl: string | null;
  prevUrl: string | null;
}

export interface HomeResponse {
  homeUrl: string;
  ongoing: OngoingItem[];
  complete: CompleteItem[];
}

export interface ListResponse<T> {
  url: string;
  kind?: string;
  count: number;
  items: T[];
  pagination: Pagination | null;
}

export interface Genre {
  name: string;
  url: string;
  slug: string;
}

export interface GenreCardItem {
  title: string;
  url: string;
  slug: string;
  studio: string | null;
  episodes: string | null;
  rating: string | null;
  genres: string[];
  image: string | null;
  synopsis: string | null;
  season: string | null;
}

export interface AnimeInfo {
  judul: string;
  japanese: string;
  skor: string | null;
  produser: string;
  tipe: string;
  status: string;
  totalEpisode: string;
  durasi: string;
  tanggalRilis: string;
  studio: string;
  genres: string[];
}

export interface EpisodeRef {
  title: string;
  url: string;
  slug: string;
  episode: string | null;
  date: string;
}

export interface AnimeResponse {
  animeUrl: string;
  title: string;
  image: string;
  info: AnimeInfo;
  synopsis: string;
  episodeCount: number;
  episodes: EpisodeRef[];
  batches: EpisodeRef[];
}

export interface DownloadLink {
  host: string;
  url: string;
}

export interface DownloadItem {
  quality: string;
  sizeMB: number | null;
  links: DownloadLink[];
}

export interface Mirror {
  quality: string;
  mirrorIndex: number;
  host: string | null;
  iframeUrl?: string | null;
  directUrl?: string | null;
  error?: string;
  resolved?: boolean;
}

export interface EpisodeResponse {
  episodeUrl: string;
  slug: string;
  title: string;
  animeUrl: string;
  animeSlug: string;
  prevEpisodeUrl: string | null;
  nextEpisodeUrl: string | null;
  episodeList: { url: string; slug: string; label: string; episode: string }[];
  defaultIframe: string | null;
  downloads: { heading: string; items: DownloadItem[] }[];
  mirrors: Mirror[];
}

export interface SearchItem {
  title: string;
  url: string;
  kind: "episode" | "anime" | "other";
  slug: string | null;
  status: string | null;
  rating: string | null;
  genres: string | null;
}

export interface ScheduleDay {
  day: string;
  count: number;
  anime: { title: string; url: string; slug: string }[];
}
```

Pakai dengan helper:

```ts
import type { HomeResponse, AnimeResponse } from "./types/api";

const home = await api<HomeResponse>("/api/home");
const anime = await api<AnimeResponse>(`/api/anime/${slug}`);
```

(Tambahkan generic ke `api()`: `export async function api<T>(...): Promise<T>`.)

## Tips performa di frontend

1. **Server sudah caching agresif** — tidak perlu cache di frontend untuk endpoint yang sama dalam window pendek. Tapi untuk SPA dengan navigasi cepat, library seperti **TanStack Query** / **SWR** / **VueQuery** sangat membantu — auto-cache, refetch on focus, dst.

2. **Pre-fetch episode detail** saat hover di list anime — UX terasa instan.

3. **`skipMirrors=1` untuk listing episode** — jangan resolve mirror untuk semua episode di halaman daftar. Cuma resolve saat user benar-benar klik mau nonton.

4. **Image lazy loading** — pakai `loading="lazy"` di `<img>` untuk thumbnail anime.

5. **Optimistic UI untuk pagination** — keep previous data saat fetching next page, hindari flash kosong.

## CORS gotchas

Server mengirim `Access-Control-Allow-Origin` berdasarkan env `ALLOWED_ORIGINS`. Kalau Anda dapat error CORS:

- **Development**: pastikan `ALLOWED_ORIGINS=*` atau include `http://localhost:5173` (Vite default), `http://localhost:3000` (Next.js), dst.
- **Production**: isi exact frontend domain Anda, mis. `https://myapp.com`. Wildcard `*` **tidak boleh** kalau pakai `credentials: "include"` (tapi default `fetch` tidak pakai credentials, jadi aman).
- **Preflight**: browser auto-OPTIONS untuk request dengan header custom (`X-API-Key`). Server sudah handle ini lewat middleware `cors()`.

## Contoh struktur project frontend minimal

```
my-frontend/
├── src/
│   ├── lib/
│   │   └── api.js          # helper di atas
│   ├── hooks/              # atau composables/ untuk Vue
│   │   └── useApi.js
│   ├── types/
│   │   └── api.ts          # kalau pakai TS
│   ├── pages/
│   │   ├── Home.jsx
│   │   ├── AnimePage.jsx
│   │   └── EpisodePage.jsx
│   └── App.jsx
├── .env.local              # VITE_API_BASE_URL + VITE_API_KEY
└── package.json
```

## Tanya-jawab cepat

**Q: Bisa pakai Server-Side Rendering (Next.js SSR / Nuxt)?**
Bisa. Panggil `api()` di `getServerSideProps` / `useFetch` server-side. Pastikan env `API_KEY` di-set di server, bukan public env.

**Q: Bisa cache hasil di IndexedDB / localStorage?**
Bisa. Tapi server sudah caching, dan TTL-nya pas — caching di client cuma jadi 2nd layer. Pakai TanStack Query yang sudah handle ini elegan.

**Q: API_KEY ketahuan saat dipakai dari browser, gimana?**
Untuk public app: route lewat backend Anda sendiri (Anda jadi proxy ke API ini). Untuk personal app: API key sudah cukup deter casual scraping orang lain.

**Q: Bisa subscribe perubahan (websocket)?**
Tidak — API ini stateless polling. Untuk "notif episode baru", polling `/api/home` tiap 5-10 menit dari frontend cukup.
