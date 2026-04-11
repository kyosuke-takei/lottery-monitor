import type { LotteryItem, DiffResult } from "../types"

function getChangedFields(before: LotteryItem, after: LotteryItem) {
  const fields: (keyof LotteryItem)[] = [
    "entryPeriod",
    "lotteryDate",
    "salesPeriod",
    "xPostUrl",
    "applyUrl",
    "applyLabel",
    "applyType"
  ]

  return fields.filter(f => before[f] !== after[f]).map(String)
}

export function compareLotteryItems(
  previous: LotteryItem[],
  current: LotteryItem[]
): DiffResult {
  const previousMap = new Map(previous.map(i => [i.key, i]))

  const added: LotteryItem[] = []
  const updated: DiffResult["updated"] = []

  for (const item of current) {
    const prev = previousMap.get(item.key)

    if (!prev) {
      added.push(item)
      continue
    }

    const changedFields = getChangedFields(prev, item)

    if (changedFields.length > 0) {
      updated.push({
        before: prev,
        after: item,
        changedFields
      })
    }
  }

  return { added, updated }
}