// Otakudesu streaming URL scraper.
//
// Pipeline (validated 2026-05-21):
//   1. Episode page HTML contains <a data-content="<base64>"> mirror tokens
//      where each token decodes to {id, i, q} (i = mirror index, q = quality).
//   2. POST action=aa1208d27f29ca340c92c66d1926f13f to /wp-admin/admin-ajax.php
//      → returns {"data": "<nonce>"}.
//   3. POST {id, i, q, nonce, action: 2a3505c93b0035d3f455df82bf976b84} to the
//      same endpoint → returns {"data": "<base64 iframe HTML>"}.
//   4. Decoded iframe src points at desustream.info (or similar host) which
//      embeds a <video><source src="..."> with the actual MP4/M3U8 URL.

import { load } from "cheerio";
import { pathToFileURL } from "node:url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const NONCE_ACTION = "aa1208d27f29ca340c92c66d1926f13f";
const MIRROR_ACTION = "2a3505c93b0035d3f455df82bf976b84";
const AJAX_URL = "https://otakudesu.blog/wp-admin/admin-ajax.php";

const DEFAULT_BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// Global fetch config — tweakable from server.js or env.
const fetchConfig = {
  timeoutMs: 20_000,
  maxRetries: 3,
  retryDelayMs: 500, // base, exponential
  proxyAgent: null, // set with configureFetch({ proxyUrl })
};

export function configureFetch(opts = {}) {
  if (opts.timeoutMs != null) fetchConfig.timeoutMs = opts.timeoutMs;
  if (opts.maxRetries != null) fetchConfig.maxRetries = opts.maxRetries;
  if (opts.retryDelayMs != null) fetchConfig.retryDelayMs = opts.retryDelayMs;
  if (opts.proxyAgent !== undefined) fetchConfig.proxyAgent = opts.proxyAgent;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, init = {}) {
  const headers = { ...DEFAULT_BROWSER_HEADERS, ...(init.headers || {}) };
  let lastErr = null;
  for (let attempt = 0; attempt <= fetchConfig.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchConfig.timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
        ...(fetchConfig.proxyAgent ? { agent: fetchConfig.proxyAgent } : {}),
      });
      clearTimeout(timer);
      // Retry on 429 / 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < fetchConfig.maxRetries) {
          const delay =
            fetchConfig.retryDelayMs * Math.pow(2, attempt) +
            Math.floor(Math.random() * 200);
          await sleep(delay);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isNetworkErr =
        err.name === "AbortError" ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ENOTFOUND";
      if (attempt < fetchConfig.maxRetries && isNetworkErr) {
        const delay =
          fetchConfig.retryDelayMs * Math.pow(2, attempt) +
          Math.floor(Math.random() * 200);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`fetch failed for ${url}`);
}

async function fetchText(url, init = {}) {
  const res = await fetchWithRetry(url, init);
  return res.text();
}

async function fetchJSON(url, init = {}) {
  const res = await fetchWithRetry(url, {
    ...init,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...(init.headers || {}),
    },
  });
  return res.json();
}

function b64decode(s) {
  return Buffer.from(s, "base64").toString("utf-8");
}

async function getNonce(episodeUrl) {
  const body = new URLSearchParams({ action: NONCE_ACTION });
  const json = await fetchJSON(AJAX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: episodeUrl,
    },
    body,
  });
  return json.data;
}

async function resolveMirror({ id, i, q }, nonce, episodeUrl) {
  const body = new URLSearchParams({
    id: String(id),
    i: String(i),
    q,
    nonce,
    action: MIRROR_ACTION,
  });
  const json = await fetchJSON(AJAX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: episodeUrl,
    },
    body,
  });
  const html = b64decode(json.data);
  const $ = load(html);
  const src = $("iframe").attr("src");
  return src || null;
}

async function extractDirectVideo(embedUrl, refererUrl) {
  // Best-effort: fetch the embed page and look for a <video><source>.
  // Some hosts use JS-built players — those return null and the caller
  // should treat the iframe URL as the streaming URL.
  try {
    const html = await fetchText(embedUrl, {
      headers: { Referer: refererUrl },
    });
    const $ = load(html);
    const direct = $("source").attr("src") || $("video").attr("src") || null;
    return direct;
  } catch {
    return null;
  }
}

function pagedUrl(baseUrl, page) {
  if (!page || page <= 1) return baseUrl;
  const u = baseUrl.replace(/\/$/, "");
  return `${u}/page/${page}/`;
}

function extractPagination($) {
  const $nav = $(".pagenavix, .pagination").first();
  if (!$nav.length) return null;
  const current = parseInt($nav.find(".current").first().text(), 10) || 1;
  const pageNumbers = $nav
    .find("a.page-numbers, span.page-numbers.current")
    .map((_, el) => parseInt($(el).text(), 10))
    .get()
    .filter((n) => !isNaN(n));
  const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : current;
  const nextUrl = $nav.find("a.next").attr("href") || null;
  const prevUrl = $nav.find("a.prev").attr("href") || null;
  return { current, totalPages, nextUrl, prevUrl };
}

function parseDetpost($, el, kind) {
  const $card = $(el);
  const $a = $card.find(".thumb a").first();
  const url = $a.attr("href") || null;
  const title = $card.find(".jdlflm").first().text().trim();
  const image = $card.find(".thumb img").attr("src") || null;
  const epzText = $card.find(".epz").first().text().trim();
  const epzTipeText = $card.find(".epztipe").first().text().trim();
  const dateText = $card.find(".newnime").first().text().trim() || null;

  const base = {
    title,
    url,
    slug: slugFromAnimeUrl(url),
    image,
    date: dateText,
  };

  if (kind === "ongoing") {
    const epNum = epzText.match(/Episode\s+(\d+(?:\.\d+)?)/i)?.[1] || null;
    return { ...base, currentEpisode: epNum, day: epzTipeText || null };
  }
  if (kind === "complete") {
    const total = epzText.match(/(\d+)\s*Episode/i)?.[1] || null;
    const score = epzTipeText.match(/([\d.]+)/)?.[1] || null;
    return { ...base, totalEpisodes: total, score };
  }
  // Generic — keep raw labels
  return { ...base, epzText, epztipeText: epzTipeText };
}

function parseDetpostList($, root, kind) {
  return $(root)
    .find(".venz > ul > li > .detpost, .venz li .detpost")
    .map((_, el) => parseDetpost($, el, kind))
    .get();
}

const INFO_LABEL_MAP = {
  judul: "judul",
  japanese: "japanese",
  skor: "skor",
  produser: "produser",
  tipe: "tipe",
  status: "status",
  "total episode": "totalEpisode",
  durasi: "durasi",
  "tanggal rilis": "tanggalRilis",
  studio: "studio",
};

function mapInfoLabel(label) {
  const key = INFO_LABEL_MAP[label];
  return key || label.replace(/\s+/g, "_");
}

function slugFromEpisodeUrl(url) {
  if (!url) return null;
  const m = url.match(/\/episode\/([^/]+)\/?/);
  return m ? m[1] : null;
}

function slugFromAnimeUrl(url) {
  if (!url) return null;
  const m = url.match(/\/anime\/([^/]+)\/?/);
  return m ? m[1] : null;
}

function parseSizeMB(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "GB") return n * 1024;
  if (unit === "KB") return n / 1024;
  return n;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function scrapeAnime(animeUrl) {
  const html = await fetchText(animeUrl);
  const $ = load(html);

  // Title: direct text of <h1> inside .jdlrx, excluding the trailing icon span.
  const title = $(".jdlrx h1")
    .first()
    .contents()
    .filter((_, n) => n.type === "text")
    .text()
    .trim();

  const image = $(".fotoanime img").attr("src") || null;

  const info = { genres: [] };
  $(".infozingle p").each((_, el) => {
    const $p = $(el);
    const label = $p
      .find("b")
      .first()
      .text()
      .trim()
      .toLowerCase()
      .replace(/:$/, "");
    if (!label) return;
    if (label === "genre" || label === "genres") {
      info.genres = $p
        .find("a")
        .map((_, a) => $(a).text().trim())
        .get()
        .filter(Boolean);
      return;
    }
    const value = $p
      .find("span")
      .first()
      .text()
      .replace(/^[^:]*:\s*/, "")
      .trim();
    info[mapInfoLabel(label)] = value || null;
  });

  const synopsis = $(".sinopc p")
    .map((_, p) => $(p).text().trim())
    .get()
    .filter(Boolean)
    .join("\n\n");

  const episodes = [];
  const batches = [];
  $(".episodelist").each((_, list) => {
    const $list = $(list);
    const heading = $list.find(".monktit").first().text().trim();
    const isBatch = /batch/i.test(heading);
    $list.find("ul > li").each((_, li) => {
      const $li = $(li);
      const $a = $li.find("a").first();
      const url = $a.attr("href") || null;
      const itemTitle = $a.text().trim();
      const date = $li.find(".zeebr").text().trim() || null;
      const slug = slugFromEpisodeUrl(url);
      const numMatch = itemTitle.match(/Episode\s+(\d+(?:\.\d+)?)/i);
      const episode = numMatch ? numMatch[1] : null;
      const entry = { title: itemTitle, url, slug, episode, date };
      if (isBatch) batches.push(entry);
      else episodes.push(entry);
    });
  });

  return {
    animeUrl,
    title,
    image,
    info,
    synopsis,
    episodeCount: episodes.length,
    episodes,
    batches,
  };
}

export async function scrapeHome(homeUrl = "https://otakudesu.blog/") {
  const html = await fetchText(homeUrl);
  const $ = load(html);

  const sections = $(".venutama .rseries")
    .map((_, sec) => {
      const $sec = $(sec);
      const heading = $sec.find("#rvod h1").first().text().trim();
      const moreUrl = $sec.find("a").first().attr("href") || null;
      const kind = /on-?going/i.test(heading)
        ? "ongoing"
        : /complete/i.test(heading)
          ? "complete"
          : null;
      return {
        heading,
        moreUrl,
        kind,
        items: parseDetpostList($, sec, kind),
      };
    })
    .get();

  const ongoing = sections.find((s) => s.kind === "ongoing")?.items || [];
  const complete = sections.find((s) => s.kind === "complete")?.items || [];

  return { homeUrl, ongoing, complete, sections };
}

async function scrapeDetpostList(url, kind) {
  const html = await fetchText(url);
  const $ = load(html);
  const items = parseDetpostList($, $.root(), kind);
  const pagination = extractPagination($);
  return { url, kind, count: items.length, items, pagination };
}

export function scrapeOngoing({ page = 1 } = {}) {
  return scrapeDetpostList(
    pagedUrl("https://otakudesu.blog/ongoing-anime/", page),
    "ongoing",
  );
}

export function scrapeComplete({ page = 1 } = {}) {
  return scrapeDetpostList(
    pagedUrl("https://otakudesu.blog/complete-anime/", page),
    "complete",
  );
}

export async function scrapeAnimeList(
  listUrl = "https://otakudesu.blog/anime-list/",
) {
  const html = await fetchText(listUrl);
  const $ = load(html);

  const groups = [];
  $(".bariskelom").each((_, group) => {
    const $group = $(group);
    const letter =
      $group.find(".barispenz a[name]").first().text().trim() || null;
    const anime = $group
      .find(".jdlbar a.hodebgst")
      .map((_, a) => {
        const $a = $(a);
        // Some titles have nested junk; use ownText then fallback
        const title =
          $a
            .contents()
            .filter((_, n) => n.type === "text")
            .text()
            .trim() || $a.text().trim();
        const url = $a.attr("href") || null;
        return {
          title,
          url,
          slug: slugFromAnimeUrl(url),
          fullTitle: $a.attr("title") || null,
        };
      })
      .get();
    if (letter || anime.length)
      groups.push({ letter, count: anime.length, anime });
  });

  const totalAnime = groups.reduce((n, g) => n + g.anime.length, 0);
  return { listUrl, totalAnime, groups };
}

export async function listGenres(
  genreListUrl = "https://otakudesu.blog/genre-list/",
) {
  const html = await fetchText(genreListUrl);
  const $ = load(html);
  const genres = $("ul.genres a")
    .map((_, a) => {
      const $a = $(a);
      const href = $a.attr("href") || null;
      const url = href
        ? href.startsWith("http")
          ? href
          : new URL(href, genreListUrl).href
        : null;
      return {
        name: $a.text().trim(),
        url,
        slug: url ? (url.match(/\/genres\/([^/]+)\/?/) || [])[1] || null : null,
      };
    })
    .get();
  return { genreListUrl, count: genres.length, genres };
}

function parseGenreCard($, el) {
  const $c = $(el);
  const $titleA = $c.find(".col-anime-title a").first();
  const url = $titleA.attr("href") || null;
  return {
    title: $titleA.text().trim(),
    url,
    slug: slugFromAnimeUrl(url),
    studio: $c.find(".col-anime-studio").first().text().trim() || null,
    episodes: $c.find(".col-anime-eps").first().text().trim() || null,
    rating: $c.find(".col-anime-rating").first().text().trim() || null,
    genres: $c
      .find(".col-anime-genre a")
      .map((_, a) => $(a).text().trim())
      .get(),
    image: $c.find(".col-anime-cover img").attr("src") || null,
    synopsis: $c.find(".col-synopsis").first().text().trim() || null,
    season: $c.find(".col-anime-date").first().text().trim() || null,
  };
}

export async function scrapeGenre(slugOrUrl, { page = 1 } = {}) {
  const baseUrl = slugOrUrl.includes("://")
    ? slugOrUrl
    : `https://otakudesu.blog/genres/${slugOrUrl}/`;
  const url = pagedUrl(baseUrl, page);

  const html = await fetchText(url);
  const $ = load(html);

  const items = $(".col-anime")
    .map((_, el) => parseGenreCard($, el))
    .get();
  const pagination = extractPagination($);
  const slug = (baseUrl.match(/\/genres\/([^/]+)\/?/) || [])[1] || null;

  return { url, slug, count: items.length, items, pagination };
}

export async function scrapeSchedule(
  scheduleUrl = "https://otakudesu.blog/jadwal-rilis/",
) {
  const html = await fetchText(scheduleUrl);
  const $ = load(html);

  const days = $(".kglist321")
    .map((_, d) => {
      const $d = $(d);
      const day = $d.find("h2").first().text().trim();
      const anime = $d
        .find("ul li a")
        .map((_, a) => {
          const $a = $(a);
          const url = $a.attr("href") || null;
          return {
            title: $a.text().trim(),
            url,
            slug: slugFromAnimeUrl(url),
          };
        })
        .get();
      return { day, count: anime.length, anime };
    })
    .get();

  return { scheduleUrl, days };
}

export async function search(
  keyword,
  { baseUrl = "https://otakudesu.blog/" } = {},
) {
  if (!keyword || !keyword.trim()) {
    return { keyword, count: 0, items: [] };
  }
  const url = `${baseUrl.replace(/\/$/, "")}/?s=${encodeURIComponent(keyword.trim())}`;
  const html = await fetchText(url);
  const $ = load(html);

  const items = $("ul.chivsrc > li")
    .map((_, li) => {
      const $li = $(li);
      const $a = $li.find("h2 a").first();
      const linkUrl = $a.attr("href") || null;
      const isEpisode = linkUrl && linkUrl.includes("/episode/");
      const isAnime = linkUrl && linkUrl.includes("/anime/");
      const sets = $li
        .find(".set")
        .map((_, s) => $(s).text().trim())
        .get()
        .filter(Boolean);
      const setMap = {};
      for (const s of sets) {
        const m = s.match(/^([^:]+):\s*(.*)$/);
        if (m) setMap[m[1].trim().toLowerCase()] = m[2].trim();
      }
      return {
        title: $a.text().trim(),
        url: linkUrl,
        kind: isEpisode ? "episode" : isAnime ? "anime" : "other",
        slug: isEpisode
          ? slugFromEpisodeUrl(linkUrl)
          : isAnime
            ? slugFromAnimeUrl(linkUrl)
            : null,
        status: setMap.status || null,
        rating: setMap.rating || null,
        genres: setMap.genres || null,
      };
    })
    .get();

  return { keyword, url, count: items.length, items };
}

export async function scrapeEpisode(episodeUrl, options = {}) {
  const { skipMirrors = false, mirrorConcurrency = 5 } = options;

  const html = await fetchText(episodeUrl);
  const $ = load(html);

  const title =
    $("h1.posttl").first().text().trim() || $("title").text().trim();

  // Default iframe shown on page load (no AJAX needed).
  const defaultIframe = $("iframe").first().attr("src") || null;

  // ---- Navigation: prev/next, anime, full episode list ----
  const flirLinks = $(".flir a")
    .map((_, a) => ({
      href: $(a).attr("href") || null,
      text: $(a).text().trim(),
    }))
    .get();
  const prevEpisodeUrl =
    flirLinks.find((l) => /previous/i.test(l.text))?.href || null;
  const nextEpisodeUrl =
    flirLinks.find((l) => /next/i.test(l.text))?.href || null;
  const animeUrl =
    flirLinks.find((l) => l.href && l.href.includes("/anime/"))?.href || null;

  const episodeList = [];
  $('select[name="episode"] option').each((_, opt) => {
    const $opt = $(opt);
    const value = $opt.attr("value");
    if (!value || value === "0") return;
    const optText = $opt.text().trim();
    const num = optText.match(/(\d+(?:\.\d+)?)/)?.[1] || null;
    episodeList.push({
      url: value,
      slug: slugFromEpisodeUrl(value),
      label: optText,
      episode: num,
    });
  });

  // ---- Download links block ----
  const downloadGroups = [];
  $(".download").each((_, block) => {
    const $block = $(block);
    // Each .download can contain alternating <h4> group headings and <ul> lists.
    // Pair them positionally.
    const children = $block.children().toArray();
    let currentHeading = null;
    let groupItems = [];
    const flush = () => {
      if (groupItems.length) {
        downloadGroups.push({ heading: currentHeading, items: groupItems });
        groupItems = [];
      }
    };
    for (const child of children) {
      const $c = $(child);
      const tag = child.tagName?.toLowerCase();
      if (tag === "h4") {
        flush();
        currentHeading = $c.text().trim();
      } else if (tag === "ul") {
        $c.find("li").each((_, li) => {
          const $li = $(li);
          const quality = $li.find("strong").first().text().trim() || null;
          const size = parseSizeMB($li.find("i").first().text());
          const links = $li
            .find("a")
            .map((_, a) => ({
              host: $(a).text().trim(),
              url: $(a).attr("href") || null,
            }))
            .get()
            .filter((l) => l.url);
          if (quality || links.length) {
            groupItems.push({ quality, sizeMB: size, links });
          }
        });
      }
    }
    flush();
  });

  // ---- Mirror tokens + host names ----
  const tokens = [];
  $(".mirrorstream [data-content]").each((_, el) => {
    const $el = $(el);
    const raw = $el.attr("data-content");
    if (!raw) return;
    try {
      const { id, i, q } = JSON.parse(b64decode(raw));
      tokens.push({ id, i, q, host: $el.text().trim() || null });
    } catch {
      /* not a mirror token */
    }
  });

  let mirrors = [];
  if (!skipMirrors && tokens.length) {
    const nonce = await getNonce(episodeUrl);
    mirrors = await mapWithConcurrency(
      tokens,
      mirrorConcurrency,
      async (tok) => {
        try {
          const iframeSrc = await resolveMirror(tok, nonce, episodeUrl);
          const directSrc = iframeSrc
            ? await extractDirectVideo(iframeSrc, episodeUrl)
            : null;
          return {
            quality: tok.q,
            mirrorIndex: tok.i,
            host: tok.host,
            iframeUrl: iframeSrc,
            directUrl: directSrc,
          };
        } catch (err) {
          return {
            quality: tok.q,
            mirrorIndex: tok.i,
            host: tok.host,
            error: err.message,
          };
        }
      },
    );
  } else if (tokens.length) {
    // skipMirrors: surface tokens without resolving so the caller can still see
    // what mirrors exist and resolve them later.
    mirrors = tokens.map((tok) => ({
      quality: tok.q,
      mirrorIndex: tok.i,
      host: tok.host,
      resolved: false,
    }));
  }

  return {
    episodeUrl,
    slug: slugFromEpisodeUrl(episodeUrl),
    title,
    animeUrl,
    animeSlug: slugFromAnimeUrl(animeUrl),
    prevEpisodeUrl,
    nextEpisodeUrl,
    episodeList,
    defaultIframe,
    downloads: downloadGroups,
    mirrors,
  };
}

// CLI entrypoint:
//   node scrape.js <episode-url>                       (auto-detect)
//   node scrape.js <anime-url>                         (auto-detect)
//   node scrape.js --episode <url> [--skip-mirrors]
//   node scrape.js --anime <url>
//   node scrape.js --home
//   node scrape.js --ongoing [--page 2]
//   node scrape.js --complete [--page 2]
//   node scrape.js --list                              (anime A-Z)
//   node scrape.js --genres                            (list of genres)
//   node scrape.js --genre <slug-or-url> [--page 2]
//   node scrape.js --schedule
//   node scrape.js --search <keyword>
function printUsage() {
  console.error(
    "Usage:\n" +
      "  node scrape.js <episode-url|anime-url>\n" +
      "  node scrape.js --episode <url> [--skip-mirrors]\n" +
      "  node scrape.js --anime <url>\n" +
      "  node scrape.js --home\n" +
      "  node scrape.js --ongoing [--page N]\n" +
      "  node scrape.js --complete [--page N]\n" +
      "  node scrape.js --list\n" +
      "  node scrape.js --genres\n" +
      "  node scrape.js --genre <slug-or-url> [--page N]\n" +
      "  node scrape.js --schedule\n" +
      "  node scrape.js --search <keyword>",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  let mode = null;
  let arg = null;
  let page = 1;
  let skipMirrors = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--episode") mode = "episode";
    else if (a === "--anime") mode = "anime";
    else if (a === "--home") mode = "home";
    else if (a === "--ongoing") mode = "ongoing";
    else if (a === "--complete") mode = "complete";
    else if (a === "--list") mode = "list";
    else if (a === "--genres") mode = "genres";
    else if (a === "--genre") mode = "genre";
    else if (a === "--schedule") mode = "schedule";
    else if (a === "--search") mode = "search";
    else if (a === "--skip-mirrors") skipMirrors = true;
    else if (a === "--page") page = parseInt(args[++i], 10) || 1;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg) arg = a;
  }

  if (!mode) {
    if (!arg) arg = "https://otakudesu.blog/episode/nsot-episode-8-sub-indo/";
    mode = arg.includes("/anime/") ? "anime" : "episode";
  }

  let run;
  switch (mode) {
    case "episode":
      run = scrapeEpisode(arg, { skipMirrors });
      break;
    case "anime":
      run = scrapeAnime(arg);
      break;
    case "home":
      run = scrapeHome();
      break;
    case "ongoing":
      run = scrapeOngoing({ page });
      break;
    case "complete":
      run = scrapeComplete({ page });
      break;
    case "list":
      run = scrapeAnimeList();
      break;
    case "genres":
      run = listGenres();
      break;
    case "genre":
      if (!arg) {
        console.error("Error: --genre needs a slug or URL");
        printUsage();
        process.exit(1);
      }
      run = scrapeGenre(arg, { page });
      break;
    case "schedule":
      run = scrapeSchedule();
      break;
    case "search":
      if (!arg) {
        console.error("Error: --search needs a keyword");
        printUsage();
        process.exit(1);
      }
      run = search(arg);
      break;
    default:
      printUsage();
      process.exit(1);
  }

  run
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
