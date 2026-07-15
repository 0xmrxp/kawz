// Bundle: Web Intelligence (4 endpoints)
// url-metadata, article-parser, link-extractor: native fetch + regex, zero new deps.
// screenshot: puppeteer-core + system Chrome/Chromium.

import { Hono } from "hono";
import type { Variables } from "../types";
import { getOrFetch } from "../lib/cache";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";

const web = new Hono<{ Variables: Variables }>();

const TTL = {
  urlMetadata:    300,
  articleParser:  600,
  linkExtractor:  300,
} as const;

const USER_AGENT = "Lobre/1.2 (+https://lobre.lat)";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

interface MetaData {
  title:       string | null;
  description: string | null;
  og_title:    string | null;
  og_image:    string | null;
  og_type:     string | null;
  canonical:   string | null;
  favicon:     string | null;
}

function extractMeta(html: string, baseUrl: string): MetaData {
  const tagMatch = (re: RegExp) => {
    const m = html.match(re);
    return m ? (m[1] ?? m[2] ?? null) : null;
  };

  const title = tagMatch(/<title[^>]*>([^<]*)<\/title>/i);

  // <meta name="description" content="..."> or <meta property="og:*" content="...">
  const metaContent = (nameOrProp: string) => {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]+content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${nameOrProp}["']`,
      "i"
    );
    return tagMatch(re);
  };

  const description = metaContent("description");
  const og_title    = metaContent("og:title");
  const og_image    = metaContent("og:image");
  const og_type     = metaContent("og:type");

  // <link rel="canonical" href="...">
  const canonicalM = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)
                  ?? html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
  const canonical = canonicalM ? canonicalM[1] ?? null : null;

  // favicon — prefer <link rel="icon"> or shortcut icon
  const faviconM = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']*)["']/i)
                ?? html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
  let favicon: string | null = faviconM ? faviconM[1] ?? null : null;
  if (!favicon) {
    try { favicon = new URL("/favicon.ico", baseUrl).href; } catch { favicon = null; }
  }

  return { title, description, og_title, og_image, og_type, canonical, favicon };
}

function cleanArticle(html: string): string {
  // Strip script / style / nav / header / footer blocks entirely
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Try <article> first, then <main>, then fall back to <body>
  const articleM = cleaned.match(/<article[\s\S]*?<\/article>/i);
  const mainM    = cleaned.match(/<main[\s\S]*?<\/main>/i);
  const bodyM    = cleaned.match(/<body[\s\S]*?<\/body>/i);

  const block = (articleM ?? mainM ?? bodyM)?.[0] ?? cleaned;

  // Strip remaining tags and collapse whitespace
  return block
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface ExtractedLink {
  href:     string;
  text:     string;
  internal: boolean;
}

function extractLinks(html: string, baseUrl: string, internalOnly: boolean): ExtractedLink[] {
  let origin: string;
  try { origin = new URL(baseUrl).origin; } catch { origin = ""; }

  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  const re = /<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null && links.length < 100) {
    const rawHref = (m[1] ?? "").trim();
    const rawText = (m[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    let absolute: string;
    try {
      absolute = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }

    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const internal = origin !== "" && absolute.startsWith(origin);
    if (internalOnly && !internal) continue;

    links.push({ href: absolute, text: rawText, internal });
  }

  return links;
}

// ─── GET /url-metadata ───────────────────────────────────────────────────────

web.get("/url-metadata", async (c) => {
  const env = c.get("env");
  const url = c.req.query("url");
  if (!url) return c.json({ success: false, error: "url query param required" }, 400);

  try { new URL(url); } catch {
    return c.json({ success: false, error: "invalid url" }, 400);
  }

  const cacheKey = `web:url-metadata:${url}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      async () => {
        const html = await fetchHtml(url);
        return { ...extractMeta(html, url), url, fetched_at: Date.now() };
      },
      { ttlSeconds: TTL.urlMetadata }
    );
    return c.json({ success: true, bundle: "web_intelligence", data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── POST /article-parser ────────────────────────────────────────────────────

web.post("/article-parser", async (c) => {
  const env = c.get("env");
  let body: { url?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }
  const { url } = body;
  if (!url) return c.json({ success: false, error: "body.url required" }, 400);

  try { new URL(url); } catch {
    return c.json({ success: false, error: "invalid url" }, 400);
  }

  const cacheKey = `web:article-parser:${url}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      async () => {
        const html = await fetchHtml(url);
        const full = cleanArticle(html);
        const text = full.slice(0, 8000);
        return { url, text, char_count: text.length, fetched_at: Date.now() };
      },
      { ttlSeconds: TTL.articleParser }
    );
    return c.json({ success: true, bundle: "web_intelligence", data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── POST /link-extractor ────────────────────────────────────────────────────

web.post("/link-extractor", async (c) => {
  const env = c.get("env");
  let body: { url?: string; internal_only?: boolean };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }
  const { url, internal_only = false } = body;
  if (!url) return c.json({ success: false, error: "body.url required" }, 400);

  try { new URL(url); } catch {
    return c.json({ success: false, error: "invalid url" }, 400);
  }

  const cacheKey = `web:link-extractor:${url}:${internal_only}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      async () => {
        const html  = await fetchHtml(url);
        const links = extractLinks(html, url, internal_only);
        return {
          url,
          links,
          count:         links.length,
          internal_only,
          fetched_at:    Date.now(),
        };
      },
      { ttlSeconds: TTL.linkExtractor }
    );
    return c.json({ success: true, bundle: "web_intelligence", data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

// ─── /screenshot ─────────────────────────────────────────────────────────────
// Browser singleton — reused across requests, relaunched on crash.

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean) as string[];

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--single-process",
];

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.connected) return _browser;
  for (const executablePath of CHROME_PATHS) {
    try {
      _browser = await puppeteer.launch({ executablePath, headless: true, args: LAUNCH_ARGS });
      return _browser;
    } catch { /* try next */ }
  }
  throw new Error("Chrome/Chromium not found. Set PUPPETEER_EXECUTABLE_PATH or install google-chrome-stable.");
}

web.get("/screenshot", async (c) => {
  const env = c.get("env");
  const url = c.req.query("url");
  const width  = Math.min(1920, Math.max(320, parseInt(c.req.query("width")  ?? "1280")));
  const height = Math.min(1080, Math.max(240, parseInt(c.req.query("height") ?? "800")));

  if (!url) return c.json({ success: false, error: "url query param required" }, 400);
  try { new URL(url); } catch { return c.json({ success: false, error: "invalid url" }, 400); }

  try {
    const cacheKey = `web:screenshot:${width}x${height}:${url}`;
    const data = await getOrFetch(env.REDIS_URL, cacheKey, async () => {
      const browser = await getBrowser();
      const page    = await browser.newPage();
      try {
        await page.setViewport({ width, height });
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15_000 });
        const screenshot = await page.screenshot({ type: "png", encoding: "base64" });
        return {
          url,
          screenshot_base64: screenshot as string,
          format: "png",
          viewport: { width, height },
          timestamp: Date.now(),
        };
      } finally {
        await page.close().catch(() => {});
      }
    }, { ttlSeconds: 60 });
    return c.json({ success: true, bundle: "web_intelligence", data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "screenshot failed";
    return c.json({ success: false, error: msg }, 503);
  }
});

export default web;
