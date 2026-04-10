import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

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

    if (fixed.startsWith("javascript:") || fixed.startsWith("#")) {
      return "";
    }

    if (baseUrl) {
      fixed = new URL(fixed, baseUrl).toString();
    }

    if (!/^https?:\/\//i.test(fixed)) {
      fixed = "https://" + fixed;
    }

    const u = new URL(fixed);

    if (
      !u.hostname.startsWith("www.") &&
      !u.hostname.includes("x.com") &&
      !u.hostname.includes("twitter.com")
    ) {
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
    const headRes = await axios.head(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
    });

    if (headRes.status >= 200 && headRes.status < 400) {
      return true;
    }

    const getRes = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      },
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

    if (u.hostname.startsWith("www.")) {
      const noWww = new URL(normalized);
      noWww.hostname = noWww.hostname.replace(/^www\./, "");
      const noWwwUrl = noWww.toString();

      if (await isAccessibleUrl(noWwwUrl)) {
        return noWwwUrl;
      }
    } else if (!u.hostname.includes("x.com") && !u.hostname.includes("twitter.com")) {
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

function isDateRangeLine(line: string): boolean {
  return /\d{1,2}\/\d{1,2}\s*〜\s*\d{1,2}\/\d{1,2}/.test(line);
}

function isSingleDateOrDash(line: string): boolean {
  return line === "-" || /^\d{1,2}\/\d{1,2}$/.test(line);
}

function isAreaLine(line: string): boolean {
  return (
    line.includes("通販店舗") ||
    line.includes("全国規模") ||
    line.includes("東京都") ||
    line.includes("北海道") ||
    line.includes("青森県") ||
    line.includes("岩手県") ||
    line.includes("宮城県") ||
    line.includes("秋田県") ||
    line.includes("山形県") ||
    line.includes("福島県") ||
    line.includes("茨城県") ||
    line.includes("栃木県") ||
    line.includes("群馬県") ||
    line.includes("埼玉県") ||
    line.includes("千葉県") ||
    line.includes("神奈川県") ||
    line.includes("新潟県") ||
    line.includes("富山県") ||
    line.includes("石川県") ||
    line.includes("福井県") ||
    line.includes("山梨県") ||
    line.includes("長野県") ||
    line.includes("岐阜県") ||
    line.includes("静岡県") ||
    line.includes("愛知県") ||
    line.includes("三重県") ||
    line.includes("滋賀県") ||
    line.includes("京都府") ||
    line.includes("大阪府") ||
    line.includes("兵庫県") ||
    line.includes("奈良県") ||
    line.includes("和歌山県") ||
    line.includes("鳥取県") ||
    line.includes("島根県") ||
    line.includes("岡山県") ||
    line.includes("広島県") ||
    line.includes("山口県") ||
    line.includes("徳島県") ||
    line.includes("香川県") ||
    line.includes("愛媛県") ||
    line.includes("高知県") ||
    line.includes("福岡県") ||
    line.includes("佐賀県") ||
    line.includes("長崎県") ||
    line.includes("熊本県") ||
    line.includes("大分県") ||
    line.includes("宮崎県") ||
    line.includes("鹿児島県") ||
    line.includes("沖縄県") ||
    line === "------"
  );
}

function extractLinksInOrder($: cheerio.CheerioAPI): string[] {
  const urls: string[] = [];

  $("a[href]").each((_, a) => {
    const href = cleanText($(a).attr("href") || "");
    if (!href) return;

    if (
      href.includes("x.com/laurier_news/") ||
      href.includes("twitter.com/laurier_news/")
    ) {
      urls.push(normalizeUrl(href, TARGET_URL));
    }
  });

  return urls;
}

function parseLotteryItemsFromBodyText(bodyText: string, xLinks: string[]): LotteryItem[] {
  const lines = bodyText
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter(
      (line) =>
        ![
          "LHUB",
          "ログイン",
          "無料登録",
          "TOP",
          "抽選情報",
          "メディア記事",
          "商品フィルター",
          "商品/店舗名",
          "都道府県",
          "応募期間",
          "抽選",
          "販売期間",
          "応募▽",
          "当選",
          "落選",
          "編集",
          "削除",
          "Image",
        ].includes(line)
    );

  const items: LotteryItem[] = [];
  let linkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line === "New" || line === "NEW") {
      continue;
    }

    const productName = line;
    const storeName = lines[i + 1] || "";
    const area = lines[i + 2] || "";
    const entryPeriod = lines[i + 3] || "";
    const lotteryDate = lines[i + 4] || "";
    const salesPeriod = lines[i + 5] || "";

    const looksLikeItem =
      productName &&
      storeName &&
      isAreaLine(area) &&
      isDateRangeLine(entryPeriod) &&
      isSingleDateOrDash(lotteryDate) &&
      isSingleDateOrDash(salesPeriod);

    if (!looksLikeItem) {
      continue;
    }

    const sourceUrl = xLinks[linkIndex] || TARGET_URL;
    linkIndex += 1;

    const itemWithoutKey: Omit<LotteryItem, "key"> = {
      productName,
      storeName,
      area,
      entryPeriod,
      lotteryDate,
      salesPeriod,
      sourceUrl,
    };

    items.push({
      ...itemWithoutKey,
      key: buildKey(itemWithoutKey),
    });

    i += 5;
  }

  return items;
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

  const xLinks = extractLinksInOrder($);
  const bodyText = $("body").text();

  const rawItems = parseLotteryItemsFromBodyText(bodyText, xLinks);
  console.log("[FETCH] raw item count:", rawItems.length);

  const normalizedItems: LotteryItem[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
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