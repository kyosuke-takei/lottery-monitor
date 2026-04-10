import { DiffResult, LotteryItem } from "../types";

function normalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ");
}

function buildKey(item: LotteryItem): string {
  return item.itemId;
}

function isSameItem(a: LotteryItem, b: LotteryItem): boolean {
  return (
    normalize(a.productName) === normalize(b.productName) &&
    normalize(a.storeName) === normalize(b.storeName) &&
    normalize(a.area) === normalize(b.area) &&
    normalize(a.entryPeriod) === normalize(b.entryPeriod) &&
    normalize(a.entryStart) === normalize(b.entryStart) &&
    normalize(a.entryEnd) === normalize(b.entryEnd) &&
    normalize(a.lotteryDate) === normalize(b.lotteryDate) &&
    normalize(a.salePeriod) === normalize(b.salePeriod) &&
    normalize(a.url) === normalize(b.url) &&
    normalize(a.applyType) === normalize(b.applyType)
  );
}

function getChangedFields(a: LotteryItem, b: LotteryItem): Array<keyof LotteryItem> {
  const fields: Array<keyof LotteryItem> = [
    "productName",
    "storeName",
    "area",
    "entryPeriod",
    "entryStart",
    "entryEnd",
    "lotteryDate",
    "salePeriod",
    "url",
    "applyType",
  ];

  return fields.filter((field) => normalize(a[field]) !== normalize(b[field]));
}

export function compareLotteryItems(
  previousItems: LotteryItem[],
  currentItems: LotteryItem[],
): DiffResult {
  const previousMap = new Map<string, LotteryItem>();
  const currentMap = new Map<string, LotteryItem>();

  for (const item of previousItems) {
    previousMap.set(buildKey(item), item);
  }

  for (const item of currentItems) {
    currentMap.set(buildKey(item), item);
  }

  const added: LotteryItem[] = [];
  const removed: LotteryItem[] = [];
  const changed: DiffResult["changed"] = [];

  for (const [key, currentItem] of currentMap.entries()) {
    const previousItem = previousMap.get(key);

    if (!previousItem) {
      added.push(currentItem);
      continue;
    }

    if (!isSameItem(previousItem, currentItem)) {
      changed.push({
        before: previousItem,
        after: currentItem,
        changedFields: getChangedFields(previousItem, currentItem),
      });
    }
  }

  for (const [key, previousItem] of previousMap.entries()) {
    if (!currentMap.has(key)) {
      removed.push(previousItem);
    }
  }

  return { added, removed, changed };
}