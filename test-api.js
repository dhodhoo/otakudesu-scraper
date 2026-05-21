// Manual smoke test untuk semua endpoint server.js.
//
// Pakai:
//   1. Terminal A: npm run start:api    (default port 3000)
//   2. Terminal B: node test-api.js
//
// Optional env:
//   BASE      default http://localhost:3000
//   API_KEY   kalau server dijalankan dengan API_KEY
//
// Output: tabel ringkas (status, cache, ms, ringkasan response).
// Tiap endpoint dipanggil 2x — call kedua harus X-Cache: HIT dan lebih cepat.

const BASE = process.env.BASE || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

const tests = [
  { name: "root",        path: "/" },
  { name: "health",      path: "/healthz" },
  { name: "home",        path: "/api/home" },
  { name: "ongoing p1",  path: "/api/ongoing?page=1" },
  { name: "complete p1", path: "/api/complete?page=1" },
  { name: "anime-list",  path: "/api/anime-list" },
  { name: "genres",      path: "/api/genres" },
  { name: "genre comedy",path: "/api/genre/comedy" },
  { name: "schedule",    path: "/api/schedule" },
  { name: "search",      path: "/api/search?q=naruto" },
  { name: "anime",       path: "/api/anime/nigashita-sakana-sub-indo" },
  { name: "episode skip",path: "/api/episode/nsot-episode-8-sub-indo?skipMirrors=1" },
];

function summarize(json) {
  if (!json || typeof json !== "object") return String(json).slice(0, 60);
  if (Array.isArray(json)) return `array(${json.length})`;
  if (json.error) return `ERROR: ${json.error}`;
  if (json.count != null) return `count=${json.count}`;
  if (json.totalAnime != null) return `total=${json.totalAnime}`;
  if (json.ongoing && json.complete)
    return `ongoing=${json.ongoing.length} complete=${json.complete.length}`;
  if (json.episodes) return `eps=${json.episodes.length}`;
  if (json.mirrors) return `mirrors=${json.mirrors.length} downloads=${json.downloads?.length || 0}`;
  if (json.days) return `days=${json.days.length}`;
  if (json.endpoints) return `endpoints=${json.endpoints.length}`;
  if (json.ok) return "ok";
  return Object.keys(json).slice(0, 4).join(",");
}

async function hit(path) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    headers: API_KEY ? { "X-API-Key": API_KEY } : {},
  });
  const ms = Date.now() - t0;
  const cache = res.headers.get("x-cache") || "-";
  let body;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, cache, ms, summary: summarize(body) };
}

function row(name, pass, status, cache, ms, summary) {
  const mark = pass ? "PASS" : "FAIL";
  console.log(
    `[${mark}] ${name.padEnd(16)} ${String(status).padStart(3)} ` +
      `${cache.padEnd(5)} ${String(ms).padStart(5)}ms  ${summary}`
  );
}

(async () => {
  console.log(`Testing ${BASE}`);
  console.log("name             code cache    ms  summary");
  console.log("-".repeat(70));
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      // First call (likely MISS)
      const r1 = await hit(t.path);
      const ok1 = r1.status >= 200 && r1.status < 300;
      row(t.name + " 1", ok1, r1.status, r1.cache, r1.ms, r1.summary);

      // Second call (should be HIT)
      const r2 = await hit(t.path);
      const ok2 = r2.status >= 200 && r2.status < 300;
      const cachedOk =
        t.path === "/" || t.path === "/healthz" || r2.cache === "HIT";
      row(
        t.name + " 2",
        ok2 && cachedOk,
        r2.status,
        r2.cache,
        r2.ms,
        r2.summary
      );

      if (ok1 && ok2 && cachedOk) pass += 2;
      else fail += (ok1 ? 0 : 1) + (ok2 && cachedOk ? 0 : 1);
    } catch (err) {
      row(t.name, false, "ERR", "-", 0, err.message);
      fail += 1;
    }
  }
  console.log("-".repeat(70));
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})();
