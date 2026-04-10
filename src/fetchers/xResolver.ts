import axios from "axios";
import * as cheerio from "cheerio";
import { ApplyType } from "../types";

export interface XResolveResult {
  originalUrl: string;
  normalizedPostUrl: string;
  resolvedUrl: string;
  applyType: ApplyType;
  text: string;
  extractedUrls: string[];
}

const REQUEST_TIMEOUT_MS = 5000;
const MAX_FETCH_TARGETS = 2;

function cleanText(value?: string | null): string {
  return (value || "")
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isTcoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() === "t.co";
  } catch {
    return false;
  }
}

function isBlockedStaticAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "abs.twimg.com" ||
      host === "pbs.twimg.com" ||
      host === "video.twimg.com" ||
      host === "ton.twimg.com"
    );
  } catch {
    return false;
  }
}

function isBlockedHandleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host === "handles.x.com";
  } catch {
    return false;
  }
}

function isXDomainUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "x.com" ||
      host === "twitter.com" ||
      host === "fxtwitter.com" ||
      host === "vxtwitter.com"
    );
  } catch {
    return false;
  }
}

function normalizeUrl(input: string): string {
  const raw = cleanText(input);
  if (!raw) return "";

  let value = raw;
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    url.hash = "";

    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return raw;
  }
}

export function normalizeXUrl(input: string): string {
  const raw = cleanText(input);
  if (!raw) return "";

  let urlText = raw;

  if (!/^https?:\/\//i.test(urlText)) {
    if (/^(www\.)?(x\.com|twitter\.com)\//i.test(urlText)) {
      urlText = `https://${urlText}`;
    } else {
      return raw;
    }
  }

  try {
    const url = new URL(urlText);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (host !== "x.com" && host !== "twitter.com") {
      return normalizeUrl(url.toString());
    }

    url.protocol = "https:";
    url.hostname = "x.com";
    url.hash = "";

    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }

    const params = new URLSearchParams(url.search);
    const s = params.get("s");

    const normalizedParams = new URLSearchParams();
    if (s) normalizedParams.set("s", s);
    url.search = normalizedParams.toString() ? `?${normalizedParams.toString()}` : "";

    return url.toString();
  } catch {
    return raw;
  }
}

export function isSameXUrl(a?: string | null, b?: string | null): boolean {
  return normalizeXUrl(a || "") === normalizeXUrl(b || "");
}

function detectApplyType(text: string): ApplyType {
  const t = cleanText(text).toLowerCase();

  if (!t) return "unknown";

  if (
    t.includes("app") ||
    t.includes("アプリ") ||
    t.includes("line") ||
    t.includes("会員アプリ") ||
    t.includes("セブンアプリ")
  ) {
    return "app";
  }

  if (
    t.includes("店頭") ||
    t.includes("店舗受取") ||
    t.includes("店舗受け取り") ||
    t.includes("来店") ||
    t.includes("店頭受付") ||
    t.includes("抽選券") ||
    t.includes("各店舗")
  ) {
    return "store";
  }

  if (
    t.includes("web") ||
    t.includes("通販") ||
    t.includes("オンライン") ||
    t.includes("応募フォーム") ||
    t.includes("抽選ページ") ||
    t.includes("応募url") ||
    t.includes("申し込み") ||
    t.includes("申込") ||
    t.includes("受付ページ")
  ) {
    return "online";
  }

  if (
    t.includes("x.com") ||
    t.includes("twitter.com") ||
    t.includes("fxtwitter.com") ||
    t.includes("vxtwitter.com") ||
    t.includes("ポスト") ||
    t.includes("ツイート")
  ) {
    return "x";
  }

  return "other";
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeUrl(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function extractHttpUrlsFromText(text: string): string[] {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const matches = cleaned.match(/https?:\/\/[^\s"'<>）)]+/g) || [];
  return unique(matches);
}

function extractExternalUrlsFromHtml(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];

  $("a[href]").each((_: number, el: any) => {
    const href = cleanText($(el).attr("href"));
    if (!href) return;

    try {
      const absolute = new URL(href, baseUrl).toString();
      urls.push(absolute);
    } catch {
      // noop
    }
  });

  $('meta[property="og:description"], meta[name="description"], meta[property="twitter:description"]').each(
    (_: number, el: any) => {
      const content = cleanText($(el).attr("content"));
      if (content) {
        urls.push(...extractHttpUrlsFromText(content));
      }
    },
  );

  $("script").each((_: number, el: any) => {
    const scriptText = $(el).html() || "";
    const scriptUrls = scriptText.match(/https?:\/\/[^"'\\\s<>]+/g) || [];
    urls.push(...scriptUrls);
  });

  return unique(urls);
}

function filterCandidateUrls(urls: string[], postUrl: string): string[] {
  const normalizedPostUrl = normalizeXUrl(postUrl);

  const filtered = urls.filter((url) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return false;
    if (isTcoUrl(normalized)) return false;
    if (isBlockedStaticAssetUrl(normalized)) return false;
    if (isBlockedHandleUrl(normalized)) return false;
    if (normalizedPostUrl && normalizeXUrl(normalized) === normalizedPostUrl) return false;
    if (isXDomainUrl(normalized)) return false;
    return true;
  });

  return unique(filtered);
}

async function fetchHtml(url: string): Promise<string> {
  const response = await axios.get<string>(url, {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      Referer: "https://www.google.com/",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return response.data;
}

function buildFallbackMirrorUrls(normalizedPostUrl: string): string[] {
  try {
    const url = new URL(normalizedPostUrl);
    const path = url.pathname + (url.search || "");

    return [
      `https://fxtwitter.com${path}`,
      `https://vxtwitter.com${path}`,
    ];
  } catch {
    return [];
  }
}

function chooseBestResolvedUrl(candidates: string[]): string {
  if (candidates.length === 0) return "";

  const preferred = candidates.find((url) => {
    const u = url.toLowerCase();
    return (
      !u.includes("google.com") &&
      !u.includes("facebook.com/sharer") &&
      !u.includes("twitter.com/intent") &&
      !u.includes("x.com/intent")
    );
  });

  return preferred || candidates[0];
}

function inferTextFromHtml(html: string): string {
  const $ = cheerio.load(html);

  const candidates = [
    $('meta[property="og:description"]').attr("content"),
    $('meta[name="description"]').attr("content"),
    $('meta[property="twitter:description"]').attr("content"),
    $("title").text(),
  ];

  for (const candidate of candidates) {
    const text = cleanText(candidate);
    if (text) return text;
  }

  return "";
}

export async function resolveXLotteryUrl(inputUrl: string): Promise<XResolveResult> {
  const normalizedPostUrl = normalizeXUrl(inputUrl);

  if (!normalizedPostUrl) {
    return {
      originalUrl: inputUrl,
      normalizedPostUrl: inputUrl,
      resolvedUrl: inputUrl,
      applyType: "unknown",
      text: "",
      extractedUrls: [],
    };
  }

  const fetchTargets = [normalizedPostUrl, ...buildFallbackMirrorUrls(normalizedPostUrl)].slice(
    0,
    MAX_FETCH_TARGETS,
  );

  const extractedUrls: string[] = [];
  let combinedText = "";
  let finalResolvedUrl = "";
  let finalApplyType: ApplyType = "x";

  for (const target of fetchTargets) {
    try {
      const html = await fetchHtml(target);
      const urls = filterCandidateUrls(extractExternalUrlsFromHtml(html, target), normalizedPostUrl);
      extractedUrls.push(...urls);

      const inferredText = inferTextFromHtml(html);
      if (inferredText) {
        combinedText = [combinedText, inferredText].filter(Boolean).join(" ");
      }

      const best = chooseBestResolvedUrl(filterCandidateUrls(extractedUrls, normalizedPostUrl));
      if (best) {
        finalResolvedUrl = best;
        break;
      }
    } catch {
      // 次を試す
    }
  }

  const uniqueUrls = unique(filterCandidateUrls(extractedUrls, normalizedPostUrl));

  if (!finalResolvedUrl && uniqueUrls.length > 0) {
    finalResolvedUrl = uniqueUrls[0];
  }

  if (!finalResolvedUrl) {
    finalResolvedUrl = normalizedPostUrl;
  }

  finalApplyType = detectApplyType(`${combinedText} ${finalResolvedUrl}`);

  return {
    originalUrl: inputUrl,
    normalizedPostUrl,
    resolvedUrl: finalResolvedUrl,
    applyType: finalApplyType,
    text: cleanText(combinedText),
    extractedUrls: uniqueUrls,
  };
}

export function detectApplyTypeFromAnyText(text: string): ApplyType {
  return detectApplyType(text);
}