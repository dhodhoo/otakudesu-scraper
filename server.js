// HTTP API server — bungkus scrape.js dengan Hono + caching + rate limit.
//
// Env vars:
//   PORT             default 3000
//   ALLOWED_ORIGINS  comma-separated, default "*" (jangan untuk production)
//   API_KEY          optional, kalau diset semua /api/* butuh header X-API-Key
//   HTTP_PROXY       optional, http(s) proxy URL untuk outbound (mis. http://user:pass@host:port)
//   OUTBOUND_CONCURRENCY  default 3 — max concurrent requests ke Otakudesu

import crypto from "node:crypto";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { LRUCache } from "lru-cache";
import pLimit from "p-limit";

import {
  scrapeHome,
  scrapeOngoing,
  scrapeComplete,
  scrapeAnimeList,
  listGenres,
  scrapeGenre,
  scrapeSchedule,
  search,
  scrapeAnime,
  scrapeEpisode,
  configureFetch,
} from "./scrape.js";

// ---- Outbound config ----
if (process.env.HTTP_PROXY) {
  try {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    configureFetch({ proxyAgent: new HttpsProxyAgent(process.env.HTTP_PROXY) });
    // Sembunyikan semua credentials (user:pass) dari log, bukan hanya password
    console.log("Proxy configured:", process.env.HTTP_PROXY.replace(/\/\/[^@]+@/, "//*****@"));
  } catch {
    console.warn(
      "HTTP_PROXY set but `https-proxy-agent` not installed. Run: npm i https-proxy-agent"
    );
  }
}

const outboundLimit = pLimit(
  parseInt(process.env.OUTBOUND_CONCURRENCY || "3", 10)
);

// ---- Cache ----
// Per-endpoint TTL. Minimum 1 jam — Otakudesu tidak update setiap menit.
// Endpoint yang lebih stabil (anime-list, genres) TTL lebih panjang.
const TTL = {
  home: 60 * 60_000,          // 1 hour
  ongoing: 60 * 60_000,       // 1 hour
  complete: 60 * 60_000,      // 1 hour
  list: 24 * 60 * 60_000,     // 1 day
  genres: 24 * 60 * 60_000,   // 1 day
  genre: 60 * 60_000,         // 1 hour
  schedule: 6 * 60 * 60_000,  // 6 hours
  search: 60 * 60_000,        // 1 hour
  anime: 60 * 60_000,         // 1 hour
  episode: 60 * 60_000,       // 1 hour
};

const cache = new LRUCache({ max: 1000, ttl: 30 * 60_000 });

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit) return { data: hit, cached: true };
  const data = await outboundLimit(fn);
  cache.set(key, data, { ttl: ttlMs });
  return { data, cached: false };
}

// ---- Inbound rate limit (per IP, sliding window sederhana) ----
// Catatan: state ini in-memory dan RESET saat server restart.
// Untuk rate limit yang persistent, butuh Redis atau store eksternal.
// Untuk production low-traffic, ini sudah cukup.
const rateBuckets = new Map();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "60", 10); // req/menit
const RATE_WINDOW = 60_000;

function checkRate(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < RATE_WINDOW);
  if (fresh.length >= RATE_LIMIT) return false;
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return true;
}

// Cleanup periodically supaya Map tidak membesar
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    const fresh = bucket.filter((t) => now - t < RATE_WINDOW);
    if (fresh.length === 0) rateBuckets.delete(ip);
    else rateBuckets.set(ip, fresh);
  }
}, 60_000).unref();

// ---- Hono app ----
const app = new Hono();

// Request logging middleware. Format:
//   [2026-05-21T13:42:01Z] 192.0.2.10  GET /api/home  200 HIT 2ms
app.use("*", async (c, next) => {
  const start = Date.now();
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "-";
  await next();
  const ms = Date.now() - start;
  const cache = c.res.headers.get("X-Cache") || "-";
  const ts = new Date().toISOString();
  console.log(
    `[${ts}] ${ip.padEnd(15)} ${c.req.method.padEnd(4)} ${c.req.path}  ${
      c.res.status
    } ${cache.padEnd(4)} ${ms}ms`
  );
});

// CORS: default tolak semua cross-origin kalau ALLOWED_ORIGINS tidak diset.
// Jangan default ke "*" — itu mengizinkan semua origin di production.
if (!process.env.ALLOWED_ORIGINS) {
  console.warn(
    "WARNING: ALLOWED_ORIGINS tidak diset — semua request cross-origin akan ditolak. " +
    "Set ALLOWED_ORIGINS=https://domain-anda.com untuk production."
  );
}
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  "*",
  cors({
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Key"],
  })
);

app.use("/api/*", async (c, next) => {
  // API key (optional) — constant-time comparison untuk cegah timing attack
  if (process.env.API_KEY) {
    const key = c.req.header("X-API-Key") || "";
    const expected = process.env.API_KEY;
    const keyBuf = Buffer.from(key);
    const expectedBuf = Buffer.from(expected);
    const valid =
      keyBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(keyBuf, expectedBuf);
    if (!valid) {
      return c.json({ error: "invalid or missing X-API-Key" }, 401);
    }
  }
  // Inbound rate limit
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
    c.req.header("x-real-ip") ||
    "unknown";
  if (!checkRate(ip)) {
    return c.json({ error: "rate limit exceeded" }, 429);
  }
  await next();
});

function respond(c, key, ttlMs, fn) {
  return cached(key, ttlMs, fn)
    .then(({ data, cached }) => {
      c.header("X-Cache", cached ? "HIT" : "MISS");
      return c.json(data);
    })
    .catch((err) => {
      // Log detail ke server saja; jangan bocorkan internal path/struktur ke client
      console.error("scrape error:", err.message);
      return c.json({ error: "upstream service error" }, 502);
    });
}

// ---- Routes ----
app.get("/", (c) =>
  c.json({
    name: "otakudesu-scrape API",
    endpoints: [
      "GET /api/home",
      "GET /api/ongoing?page=1",
      "GET /api/complete?page=1",
      "GET /api/anime-list",
      "GET /api/genres",
      "GET /api/genre/:slug?page=1",
      "GET /api/schedule",
      "GET /api/search?q=keyword",
      "GET /api/anime/:slug",
      "GET /api/episode/:slug?skipMirrors=1",
      "GET /healthz",
    ],
  })
);

app.get("/healthz", (c) => c.json({ ok: true, cache: cache.size }));

app.get("/api/home", (c) => respond(c, "home", TTL.home, () => scrapeHome()));

app.get("/api/ongoing", (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  return respond(c, `ongoing:${page}`, TTL.ongoing, () => scrapeOngoing({ page }));
});

app.get("/api/complete", (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  return respond(c, `complete:${page}`, TTL.complete, () =>
    scrapeComplete({ page })
  );
});

app.get("/api/anime-list", (c) =>
  respond(c, "list", TTL.list, () => scrapeAnimeList())
);

app.get("/api/genres", (c) => respond(c, "genres", TTL.genres, () => listGenres()));

app.get("/api/genre/:slug", (c) => {
  const slug = c.req.param("slug");
  // Validasi slug: hanya izinkan a-z, 0-9, dan dash (cegah SSRF via :// prefix)
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: "invalid genre slug" }, 400);
  }
  const page = parseInt(c.req.query("page") || "1", 10);
  return respond(c, `genre:${slug}:${page}`, TTL.genre, () =>
    scrapeGenre(slug, { page })
  );
});

app.get("/api/schedule", (c) =>
  respond(c, "schedule", TTL.schedule, () => scrapeSchedule())
);

app.get("/api/search", (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ error: "q parameter required" }, 400);
  return respond(c, `search:${q.toLowerCase()}`, TTL.search, () => search(q));
});

app.get("/api/anime/:slug", (c) => {
  const slug = c.req.param("slug");
  const url = `https://otakudesu.blog/anime/${slug}/`;
  return respond(c, `anime:${slug}`, TTL.anime, () => scrapeAnime(url));
});

app.get("/api/episode/:slug", (c) => {
  const slug = c.req.param("slug");
  const skipMirrors = c.req.query("skipMirrors") === "1";
  const url = `https://otakudesu.blog/episode/${slug}/`;
  return respond(c, `episode:${slug}:${skipMirrors ? "skip" : "full"}`, TTL.episode, () =>
    scrapeEpisode(url, { skipMirrors })
  );
});

// ---- Boot ----
// Pterodactyl Node.js egg memberikan SERVER_PORT, generic hosts pakai PORT.
const port = parseInt(
  process.env.SERVER_PORT || process.env.PORT || "3000",
  10
);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`API ready on http://0.0.0.0:${info.port}`);
  console.log(
    `CORS origins: ${allowedOrigins.join(", ")} | rate: ${RATE_LIMIT}/min | outbound: ${
      parseInt(process.env.OUTBOUND_CONCURRENCY || "3", 10)
    }`
  );
  if (process.env.API_KEY) console.log("API key: required (X-API-Key header)");
});
