import axios from "axios";
import fs from "fs";
import path from "path";
import { compareLotteryItems } from "./diff/compare";
import { fetchLhubLotteryItems } from "./fetchers/lhub";
import { DiffResult, LotteryItem } from "./types";

const DATA_DIR = path.resolve(process.cwd(), "data");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const INITIAL_SEED_SILENT = true;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SLACK_MAX_LINES = Number(process.env.SLACK_MAX_LINES || "40");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPreviousItems(): LotteryItem[] {
  try {
    if (!fs.existsSync(LATEST_FILE)) {
      return [];
    }

    const raw = fs.readFileSync(LATEST_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as LotteryItem[];
  } catch (error) {
    console.error("[loadPreviousItems] failed:", error);
    return [];
  }
}

function saveLatestItems(items: LotteryItem[]): void {
  ensureDataDir();
  fs.writeFileSync(LATEST_FILE, JSON.stringify(items, null, 2), "utf-8");
}

function formatItem(item: LotteryItem): string {
  return [
    `商品: ${item.productName}`,
    `店舗: ${item.storeName}`,
    `エリア: ${item.area || "-"}`,
    `応募期間: ${item.entryPeriod || "-"}`,
    `抽選日: ${item.lotteryDate || "-"}`,
    `販売期間: ${item.salePeriod || "-"}`,
    `応募種別: ${item.applyType}`,
    `リンク: ${item.url || "-"}`,
  ].join("\n");
}

function formatItemCompact(item: LotteryItem): string {
  return [
    `商品: ${item.productName}`,
    `店舗: ${item.storeName}`,
    `エリア: ${item.area || "-"}`,
    `応募期間: ${item.entryPeriod || "-"}`,
    `リンク: ${item.url || "-"}`,
  ].join("\n");
}

function formatChangedItem(
  before: LotteryItem,
  after: LotteryItem,
  changedFields: Array<keyof LotteryItem>,
): string {
  return [
    `商品: ${after.productName}`,
    `店舗: ${after.storeName}`,
    `変更項目: ${changedFields.join(", ")}`,
    `変更後の応募期間: ${after.entryPeriod || "-"}`,
    `変更後リンク: ${after.url || "-"}`,
    `変更前リンク: ${before.url || "-"}`,
  ].join("\n");
}

function printDiff(diff: DiffResult): void {
  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    console.log("[diff] no changes");
    return;
  }

  for (const item of diff.added) {
    console.log("\n【新規抽選】");
    console.log(formatItem(item));
  }

  for (const item of diff.removed) {
    console.log("\n【掲載終了】");
    console.log(formatItem(item));
  }

  for (const item of diff.changed) {
    console.log("\n【内容変更】");
    console.log(`変更項目: ${item.changedFields.join(", ")}`);
    console.log(formatItem(item.after));
  }
}

function buildSlackLines(diff: DiffResult): string[] {
  const lines: string[] = [];

  for (const item of diff.added) {
    lines.push("【新規抽選】");
    lines.push(formatItemCompact(item));
    lines.push("");
  }

  for (const item of diff.changed) {
    lines.push("【内容変更】");
    lines.push(formatChangedItem(item.before, item.after, item.changedFields));
    lines.push("");
  }

  for (const item of diff.removed) {
    lines.push("【掲載終了】");
    lines.push(formatItemCompact(item));
    lines.push("");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function chunkSlackLines(lines: string[], maxLines: number): string[] {
  const chunks: string[] = [];
  const size = Math.max(1, maxLines);

  for (let i = 0; i < lines.length; i += size) {
    const chunk = lines.slice(i, i + size).join("\n");
    if (chunk.trim()) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

async function postToSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("[slack] skipped: SLACK_WEBHOOK_URL is not set");
    return;
  }

  await axios.post(
    SLACK_WEBHOOK_URL,
    { text },
    {
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
      },
      validateStatus: (status) => status >= 200 && status < 300,
    },
  );
}

async function sendDiffToSlack(diff: DiffResult): Promise<void> {
  const hasDiff =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasDiff) {
    console.log("[slack] skipped: no changes");
    return;
  }

  const lines = buildSlackLines(diff);
  const chunks = chunkSlackLines(lines, SLACK_MAX_LINES);

  console.log(`[slack] chunks=${chunks.length}`);

  for (let i = 0; i < chunks.length; i += 1) {
    const header =
      chunks.length === 1
        ? "🎯 抽選情報の更新があります"
        : `🎯 抽選情報の更新があります (${i + 1}/${chunks.length})`;

    const body = `${header}\n\n${chunks[i]}`;
    await postToSlack(body);
    console.log(`[slack] sent ${i + 1}/${chunks.length}`);
  }
}

async function main(): Promise<void> {
  const previousItems = loadPreviousItems();
  const currentItems = await fetchLhubLotteryItems();

  if (INITIAL_SEED_SILENT && previousItems.length === 0) {
    saveLatestItems(currentItems);
    console.log(`[seed] initial snapshot saved: ${currentItems.length} items`);
    return;
  }

  const diff = compareLotteryItems(previousItems, currentItems);

  printDiff(diff);
  await sendDiffToSlack(diff);
  saveLatestItems(currentItems);

  console.log(`\n[done] previous=${previousItems.length} current=${currentItems.length}`);
  console.log(
    `[done] added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length}`,
  );
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});