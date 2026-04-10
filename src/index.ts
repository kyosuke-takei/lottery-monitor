import "dotenv/config";
import fs from "fs";
import path from "path";
import axios from "axios";
import dayjs from "dayjs";
import { compareLotteryItems } from "./diff/compare";
import { fetchLhubItems, filterItemsInPeriod } from "./fetchers/lhub";
import { LotteryItem } from "./types";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LATEST_JSON_PATH = path.join(DATA_DIR, "latest.json");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLatestItems(): LotteryItem[] | null {
  if (!fs.existsSync(LATEST_JSON_PATH)) return null;

  const raw = fs.readFileSync(LATEST_JSON_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { items?: LotteryItem[] } | LotteryItem[];

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.items)) {
    return parsed.items;
  }

  return null;
}

function saveLatestItems(items: LotteryItem[]): void {
  ensureDataDir();

  const payload = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  fs.writeFileSync(LATEST_JSON_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

function normalizeItemForSlack(item: LotteryItem): LotteryItem {
  return {
    ...item,
    url: item.url || item.sourceUrl || "https://laurier-hub.com/lottery/",
    sourceUrl: item.sourceUrl || "https://laurier-hub.com/lottery/",
  };
}

function formatAdded(item: LotteryItem): string {
  const safe = normalizeItemForSlack(item);

  return [
    "【新規抽選】",
    `商品: ${safe.productName}`,
    `店舗: ${safe.storeName}`,
    `エリア: ${safe.area || "-"}`,
    `応募期間: ${safe.entryPeriod}`,
    `抽選日: ${safe.lotteryDate || "-"}`,
    `販売期間: ${safe.salePeriod || "-"}`,
    `リンク: ${safe.url}`,
  ].join("\n");
}

function formatChanged(
  before: LotteryItem,
  after: LotteryItem,
  changedFields: string[]
): string {
  const safe = normalizeItemForSlack(after);

  const labelMap: Record<string, string> = {
    productName: "商品",
    storeName: "店舗",
    area: "エリア",
    entryPeriod: "応募期間",
    entryStart: "応募開始",
    entryEnd: "応募終了",
    lotteryDate: "抽選日",
    salePeriod: "販売期間",
    sourceUrl: "取得元URL",
    url: "リンク",
  };

  const lines: string[] = [
    "【内容変更】",
    `商品: ${safe.productName}`,
    `店舗: ${safe.storeName}`,
    `エリア: ${safe.area || "-"}`,
  ];

  for (const field of changedFields) {
    const label = labelMap[field] || field;
    const beforeValue = String((before as Record<string, unknown>)[field] ?? "").trim() || "-";
    const afterValue = String((after as Record<string, unknown>)[field] ?? "").trim() || "-";
    lines.push(`${label}: ${beforeValue} => ${afterValue}`);
  }

  lines.push(`リンク: ${safe.url}`);

  return lines.join("\n");
}

function formatRemoved(item: LotteryItem): string {
  const safe = normalizeItemForSlack(item);

  return [
    "【掲載終了】",
    `商品: ${safe.productName}`,
    `店舗: ${safe.storeName}`,
    `エリア: ${safe.area || "-"}`,
    `応募期間: ${safe.entryPeriod}`,
    `リンク: ${safe.url || safe.sourceUrl}`,
  ].join("\n");
}

async function postSlackMessage(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn("[Slack] SLACK_WEBHOOK_URL is not set. skip.");
    return;
  }

  await axios.post(
    webhookUrl,
    {
      text,
    },
    {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

async function postSlackDiffs(params: {
  added: LotteryItem[];
  changed: Array<{ before: LotteryItem; after: LotteryItem; changedFields: string[] }>;
  removed: LotteryItem[];
}): Promise<void> {
  const { added, changed, removed } = params;

  for (const item of added) {
    await postSlackMessage(formatAdded(item));
  }

  for (const diff of changed) {
    await postSlackMessage(formatChanged(diff.before, diff.after, diff.changedFields));
  }

  for (const item of removed) {
    await postSlackMessage(formatRemoved(item));
  }
}

async function main(): Promise<void> {
  const now = dayjs();

  const allItems = await fetchLhubItems();
  console.log(`[LHUB] rows(all)=${allItems.length}`);

  const inPeriodItems = filterItemsInPeriod(allItems, now);
  console.log(`[LHUB] rows(in-period)=${inPeriodItems.length}`);

  // 今回は「期間内のものだけSlack通知できればよい」ので、
  // X解析は使わず、そのまま期間内データだけで差分監視する。
  const currentItems = inPeriodItems.map((item) => ({
    ...item,
    url: item.url || item.sourceUrl || "https://laurier-hub.com/lottery/",
    sourceUrl: item.sourceUrl || "https://laurier-hub.com/lottery/",
  }));

  const prevItems = loadLatestItems();

  if (!prevItems) {
    saveLatestItems(currentItems);
    console.log(`[STATE] first seed saved: ${currentItems.length}`);
    return;
  }

  const diff = compareLotteryItems(prevItems, currentItems);

  console.log(
    `[DIFF] added=${diff.added.length} changed=${diff.changed.length} removed=${diff.removed.length}`
  );

  if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) {
    saveLatestItems(currentItems);
    console.log("[DIFF] no changes");
    return;
  }

  await postSlackDiffs(diff);
  saveLatestItems(currentItems);
  console.log("[STATE] latest.json updated");
}

main().catch((error) => {
  console.error("[ERROR]", error);
  process.exit(1);
});