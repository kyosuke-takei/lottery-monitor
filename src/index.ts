import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";

type LotteryItem = {
  key: string;
  productName: string;
  storeName: string;
  area: string;
  entryPeriod: string;
  lotteryDate: string;
  salesPeriod: string;
  sourceUrl: string;
};

const TARGET_URL = "https://laurier-hub.com/lottery/";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const DATA_DIR = path.join(process.cwd(), "data");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLatest(): LotteryItem[] {
  ensureDataDir();

  if (!fs.existsSync(LATEST_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(LATEST_FILE, "utf-8");
    return JSON.parse(raw) as LotteryItem[];
  } catch (error) {
    console.error("[LOAD ERROR]", error);
    return [];
  }
}

function saveLatest(items: LotteryItem[]) {
  ensureDataDir();
  fs.writeFileSync(LATEST_FILE, JSON.stringify(items, null, 2), "utf-8");
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeUrl(rawUrl: string, baseUrl?: string): string {
  try {
    let fixed = (rawUrl || "").trim();

    if (!fixed) return "";

    // javascript: / # を除外
    if (
      fixed.startsWith("javascript:") ||
      fixed.startsWith("#")
    ) {
      return "";
    }

    // 相対URLを絶対URL化
    if (baseUrl) {
      fixed = new URL(fixed, baseUrl).toString();
    }

    // http/https が無い場合
    if (!/^https?:\/\//i.test(fixed)) {
      fixed = "https://" + fixed;
    }

    const u = new URL(fixed);

    // よくあるホスト崩れを最低限補正
    u.hostname = u.hostname.replace(/^ww\./i, "www.");
    u.hostname = u.hostname.replace(/^w\./i, "www.");

    // www が無い場合は補完
    if (!u.hostname.startsWith("www.")) {
      u.hostname = "www." + u.hostname;
    }

    return u.toString();
  } catch (error) {
    console.error("[NORMALIZE URL ERROR]", rawUrl, error);
    return rawUrl;
  }
}

async function isAccessibleUrl(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 400) {
      return true;
    }

    // HEAD を嫌うサイト対策
    const getRes = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    return getRes.status >= 200 && getRes.status < 400;
  } catch {
    return false;
  }
}

async function ensureAccessibleUrl(rawUrl: string, baseUrl?: string): Promise<string> {
  const normalized = normalizeUrl(rawUrl, baseUrl);

  if (!normalized) return "";

  if (await isAccessibleUrl(normalized)) {
    return normalized;
  }

  try {
    const u = new URL(normalized);

    // wwwあり → なし を試す
    if (u.hostname.startsWith("www.")) {
      const noWww = new URL(normalized);
      noWww.hostname = noWww.hostname.replace(/^www\./, "");
      const noWwwUrl = noWww.toString();

      if (await isAccessibleUrl(noWwwUrl)) {
        return noWwwUrl;
      }
    } else {
      // wwwなし → あり を試す
      const withWww = new URL(normalized);
      withWww.hostname = "www." + withWww.hostname;
      const withWwwUrl = withWww.toString();

      if (await isAccessibleUrl(withWwwUrl)) {
        return withWwwUrl;
      }
    }
  } catch (error) {
    console.error("[ACCESSIBLE URL ERROR]", rawUrl, error);
  }

  return normalized;
}

function buildKey(item: Omit<LotteryItem, "key">): string {
  return [
    item.productName,
    item.storeName,
    item.area,
    item.entryPeriod,
    item.lotteryDate,
    item.salesPeriod,
    item.sourceUrl,
  ].join("|");
}

async function fetchLotteryItems(): Promise<LotteryItem[]> {
  console.log("[FETCH] open:", TARGET_URL);

  const res = await axios.get(TARGET_URL, {
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    },
  });

  const $ = cheerio.load(res.data);
  const items: LotteryItem[] = [];

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");

    // 想定: 7列
    if (tds.length < 7) return;

    const productName = cleanText($(tds[0]).text());
    const storeName = cleanText($(tds[1]).text());
    const area = cleanText($(tds[2]).text());
    const entryPeriod = cleanText($(tds[3]).text());
    const lotteryDate = cleanText($(tds[4]).text());
    const salesPeriod = cleanText($(tds[5]).text());

    const href =
      $(tds[6]).find("a").attr("href") ||
      $(tds[0]).find("a").attr("href") ||
      "";

    if (!productName || !storeName) return;

    items.push({
      key: "",
      productName,
      storeName,
      area,
      entryPeriod,
      lotteryDate,
      salesPeriod,
      sourceUrl: href,
    });
  });

  console.log("[FETCH] raw item count:", items.length);

  const normalizedItems: LotteryItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const safeUrl = await ensureAccessibleUrl(item.sourceUrl, TARGET_URL);

    const completed: Omit<LotteryItem, "key"> = {
      ...item,
      sourceUrl: safeUrl || item.sourceUrl || TARGET_URL,
    };

    const key = buildKey(completed);

    if (seen.has(key)) continue;
    seen.add(key);

    normalizedItems.push({
      ...completed,
      key,
    });
  }

  console.log("[FETCH] normalized item count:", normalizedItems.length);

  return normalizedItems;
}

function diffItems(oldItems: LotteryItem[], newItems: LotteryItem[]) {
  const oldMap = new Map(oldItems.map((item) => [item.key, item]));
  const added: LotteryItem[] = [];

  for (const item of newItems) {
    if (!oldMap.has(item.key)) {
      added.push(item);
    }
  }

  return { added };
}

function buildSlackText(item: LotteryItem): string {
  return [
    "【新規抽選】",
    `商品: ${item.productName || "-"}`,
    `店舗: ${item.storeName || "-"}`,
    `エリア: ${item.area || "-"}`,
    `応募期間: ${item.entryPeriod || "-"}`,
    `抽選日: ${item.lotteryDate || "-"}`,
    `販売期間: ${item.salesPeriod || "-"}`,
    `応募リンク: ${item.sourceUrl || "-"}`,
  ].join("\n");
}

async function postToSlack(text: string) {
  if (!SLACK_WEBHOOK_URL) {
    console.log("[SKIP] SLACK_WEBHOOK_URL is empty");
    return;
  }

  await axios.post(
    SLACK_WEBHOOK_URL,
    { text },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

async function main() {
  try {
    const oldItems = loadLatest();
    const newItems = await fetchLotteryItems();

    const { added } = diffItems(oldItems, newItems);

    console.log("[DIFF] added:", added.length);

    for (const item of added) {
      const message = buildSlackText(item);
      console.log("[POST]", message);
      await postToSlack(message);
    }

    saveLatest(newItems);
    console.log("[DONE] latest.json updated");
  } catch (error) {
    console.error("[FATAL ERROR]", error);

    if (SLACK_WEBHOOK_URL) {
      try {
        await postToSlack(`【lottery-monitor エラー】\n${String(error)}`);
      } catch (slackError) {
        console.error("[SLACK ERROR]", slackError);
      }
    }

    process.exit(1);
  }
}

main();