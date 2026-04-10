import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { ApplyType, LotteryItem } from "../types";
import {
  detectApplyTypeFromAnyText,
  normalizeXUrl,
  resolveXLotteryUrl,
  XResolveResult,
} from "./xResolver";

const LHUB_URL = "https://laurier-hub.com/lottery/";
const X_RESOLVE_CONCURRENCY = Number(process.env.X_RESOLVE_CONCURRENCY || "5");
const X_RESOLVE_MAX_URLS = Number(process.env.X_RESOLVE_MAX_URLS || "10");

interface RawLhubRow {
  productName: string;
  storeName: string;
  area: string;
  entryPeriod: string;
  lotteryDateRaw: string;
  salePeriodRaw: string;
  sourceUrl: string;
}

function cleanText(value?: string | null): string {
  return (value || "")
    .replace(/\r/g, "")
    .replace(/\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .trim();
}

function buildItemId(item: {
  productName: string;
  storeName: string;
  area: string;
}): string {
  return crypto
    .createHash("sha1")
    .update(`${item.productName}|${item.storeName}|${item.area}`.toLowerCase())
    .digest("hex");
}

function normalizeArea(value: string): string {
  const text = cleanText(value);
  if (!text || text === "------") return "";
  return text;
}

function normalizeSalePeriod(value: string): string | null {
  const text = cleanText(value);
  if (!text || text === "-") return null;
  return text;
}

function normalizeDateText(value?: string | null): string | null {
  const text = cleanText(value);
  if (!text || text === "-") return null;

  const fullDate = text.match(/(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, "0")}-${fullDate[3].padStart(2, "0")}`;
  }

  return null;
}

function getTodayJstYmd(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(now);
}

function parseMonthDay(month: string, day: string, year: number): string {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseEntryPeriod(periodText: string): {
  entryStart: string | null;
  entryEnd: string | null;
} {
  const text = cleanText(periodText);
  if (!text || text === "-") {
    return { entryStart: null, entryEnd: null };
  }

  const fullMatches = [...text.matchAll(/(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?/g)];
  if (fullMatches.length > 0) {
    const dates = fullMatches.map((m) => {
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    });

    return {
      entryStart: dates[0] ?? null,
      entryEnd: dates[dates.length - 1] ?? null,
    };
  }

  const currentYear = Number(getTodayJstYmd().slice(0, 4));
  const mdMatches = [...text.matchAll(/(\d{1,2})\s*\/\s*(\d{1,2})/g)];

  if (mdMatches.length === 1) {
    const month = mdMatches[0][1];
    const day = mdMatches[0][2];
    const date = parseMonthDay(month, day, currentYear);
    return { entryStart: date, entryEnd: date };
  }

  if (mdMatches.length >= 2) {
    const startMonth = Number(mdMatches[0][1]);
    const startDay = mdMatches[0][2];
    const endMonth = Number(mdMatches[1][1]);
    const endDay = mdMatches[1][2];

    let startYear = currentYear;
    let endYear = currentYear;

    if (endMonth < startMonth) {
      endYear = currentYear + 1;
    }

    const entryStart = parseMonthDay(String(startMonth), startDay, startYear);
    const entryEnd = parseMonthDay(String(endMonth), endDay, endYear);

    return { entryStart, entryEnd };
  }

  return { entryStart: null, entryEnd: null };
}

function normalizeApplyType(input: ApplyType): ApplyType {
  const allowed: ApplyType[] = ["online", "store", "app", "x", "other", "unknown"];
  return allowed.includes(input) ? input : "unknown";
}

function uniqueByItemId(items: LotteryItem[]): LotteryItem[] {
  const map = new Map<string, LotteryItem>();

  for (const item of items) {
    if (!map.has(item.itemId)) {
      map.set(item.itemId, item);
    }
  }

  return [...map.values()];
}

function splitProductStoreCell($: cheerio.CheerioAPI, td: any): {
  productName: string;
  storeName: string;
} {
  const clone = $(td).clone();
  clone.find("br").replaceWith("\n");

  const lines = cleanText(clone.text())
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== "new");

  const productName = lines[0] ?? "";
  const storeName = lines[1] ?? "";

  return { productName, storeName };
}

function extractMainRow($: cheerio.CheerioAPI, tr: any): Omit<RawLhubRow, "sourceUrl"> | null {
  const tds = $(tr).find("td");
  if (tds.length < 6) return null;

  const productStoreTd = tds.eq(1);
  const areaTd = tds.eq(2);
  const entryTd = tds.eq(3);
  const lotteryTd = tds.eq(4);
  const saleTd = tds.eq(5);

  const { productName, storeName } = splitProductStoreCell($, productStoreTd);
  const area = normalizeArea(areaTd.text());
  const entryPeriod = cleanText(entryTd.text());
  const lotteryDateRaw = cleanText(lotteryTd.text());
  const salePeriodRaw = cleanText(saleTd.text());

  if (!productName || !storeName) {
    return null;
  }

  return {
    productName,
    storeName,
    area,
    entryPeriod,
    lotteryDateRaw,
    salePeriodRaw,
  };
}

function extractLinkRow($: cheerio.CheerioAPI, tr: any): string {
  const href = cleanText($(tr).find('a[href]').first().attr("href"));
  if (!href) return LHUB_URL;

  if (/x\.com|twitter\.com/i.test(href)) {
    return normalizeXUrl(href);
  }

  return href;
}

function looksLikeLinkOnlyRow($: cheerio.CheerioAPI, tr: any): boolean {
  const tds = $(tr).find("td");
  if (tds.length === 0) return false;

  const firstHref = cleanText($(tr).find('a[href]').first().attr("href"));
  if (!firstHref) return false;

  const text = cleanText($(tr).text());

  if (/x\.com|twitter\.com/i.test(firstHref)) return true;
  if (/^https?:\/\//i.test(text)) return true;

  return false;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, chunkSize);
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function resolveXUrlsInBatches(urls: string[]): Promise<Map<string, XResolveResult>> {
  const resultMap = new Map<string, XResolveResult>();
  const limitedUrls =
    X_RESOLVE_MAX_URLS > 0 ? urls.slice(0, X_RESOLVE_MAX_URLS) : urls;
  const chunks = chunkArray(limitedUrls, X_RESOLVE_CONCURRENCY);

  console.log(`[X] target urls=${urls.length}`);
  console.log(`[X] limited urls=${limitedUrls.length}`);
  console.log(`[X] batch size=${X_RESOLVE_CONCURRENCY}`);
  console.log(`[X] batches=${chunks.length}`);

  for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += 1) {
    const batch = chunks[batchIndex];
    console.log(`[X] batch ${batchIndex + 1}/${chunks.length} start`);

    const batchResults = await Promise.all(
      batch.map(async (url, indexInBatch) => {
        const globalIndex = batchIndex * X_RESOLVE_CONCURRENCY + indexInBatch + 1;
        console.log(`[X] resolving ${globalIndex}/${limitedUrls.length}: ${url}`);

        try {
          const resolved = await resolveXLotteryUrl(url);
          return { url, resolved };
        } catch {
          return {
            url,
            resolved: {
              originalUrl: url,
              normalizedPostUrl: url,
              resolvedUrl: url,
              applyType: "x" as const,
              text: "",
              extractedUrls: [],
            },
          };
        }
      }),
    );

    for (const item of batchResults) {
      resultMap.set(item.url, item.resolved);
    }

    console.log(`[X] batch ${batchIndex + 1}/${chunks.length} done`);
  }

  return resultMap;
}

function isInPeriod(entryStart: string | null, entryEnd: string | null): boolean {
  const today = getTodayJstYmd();

  if (entryStart && entryEnd) {
    return entryStart <= today && today <= entryEnd;
  }

  if (!entryStart && entryEnd) {
    return today <= entryEnd;
  }

  if (entryStart && !entryEnd) {
    return entryStart <= today;
  }

  return true;
}

export async function fetchLhubLotteryItems(): Promise<LotteryItem[]> {
  const response = await axios.get<string>(LHUB_URL, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });

  const $ = cheerio.load(response.data);
  const rows = $("table tr").toArray();
  const fetchedAt = new Date().toISOString();

  const rawRows: RawLhubRow[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const tr = rows[i];
    const main = extractMainRow($, tr);
    if (!main) continue;

    let sourceUrl = LHUB_URL;
    const nextTr = rows[i + 1];

    if (nextTr && looksLikeLinkOnlyRow($, nextTr)) {
      sourceUrl = extractLinkRow($, nextTr);
      i += 1;
    }

    rawRows.push({
      ...main,
      sourceUrl,
    });
  }

  console.log(`[LHUB] rows(all)=${rawRows.length}`);

  const preItems = rawRows.map((raw) => {
    const { entryStart, entryEnd } = parseEntryPeriod(raw.entryPeriod);
    const lotteryDate = normalizeDateText(raw.lotteryDateRaw);

    return {
      source: "lhub" as const,
      itemId: buildItemId({
        productName: raw.productName,
        storeName: raw.storeName,
        area: raw.area,
      }),
      productName: raw.productName,
      storeName: raw.storeName,
      area: raw.area,
      entryPeriod: raw.entryPeriod,
      entryStart,
      entryEnd,
      lotteryDate,
      salePeriod: normalizeSalePeriod(raw.salePeriodRaw),
      url: raw.sourceUrl,
      applyType: normalizeApplyType(
        detectApplyTypeFromAnyText(
          `${raw.storeName} ${raw.area} ${raw.entryPeriod} ${raw.salePeriodRaw} ${raw.sourceUrl}`,
        ),
      ),
      fetchedAt,
    };
  });

  const inPeriodItems = uniqueByItemId(preItems).filter((item) =>
    isInPeriod(item.entryStart ?? null, item.entryEnd ?? null),
  );

  console.log(`[LHUB] rows(in-period)=${inPeriodItems.length}`);

  const uniqueXUrls = Array.from(
    new Set(
      inPeriodItems
        .map((item) => item.url)
        .filter((url) => /x\.com|twitter\.com/i.test(url)),
    ),
  );

  console.log(`[LHUB] unique x urls(in-period)=${uniqueXUrls.length}`);

  const xResolveMap = await resolveXUrlsInBatches(uniqueXUrls);

  const resolvedItems = inPeriodItems.map((item) => {
    let resolvedUrl = item.url;
    let applyType = item.applyType;

    const resolved = xResolveMap.get(item.url);
    if (resolved) {
      resolvedUrl = resolved.resolvedUrl || resolved.normalizedPostUrl || item.url;
      applyType = normalizeApplyType(
        detectApplyTypeFromAnyText(
          [
            item.storeName,
            item.area,
            item.entryPeriod,
            item.salePeriod,
            resolvedUrl,
            resolved.text,
            resolved.extractedUrls.join(" "),
          ].join(" "),
        ),
      );
    }

    return {
      ...item,
      url: resolvedUrl,
      applyType,
    };
  });

  return uniqueByItemId(resolvedItems);
}