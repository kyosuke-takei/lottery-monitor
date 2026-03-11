import "dotenv/config"
import fs from "fs"
import path from "path"
import dayjs from "dayjs"

import { fetchLhubLotteryItems } from "./fetchers/lhub"
import { compareLotteryItems } from "./diff/compare"
import { postToSlack } from "./notify/slack"
import { resolveApplyInfoFromXPost } from "./fetchers/xResolver"

import type { LotteryItem } from "./types"

const dataDir = path.join(process.cwd(), "data")
const latestFile = path.join(dataDir, "latest.json")
const notifiedFile = path.join(dataDir, "notified.json")

function load<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback

  const raw = fs.readFileSync(file, "utf8").trim()
  if (!raw) return fallback

  return JSON.parse(raw) as T
}

function save(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function isOpenNow(item: LotteryItem) {
  if (!item.entryStartDate || !item.entryEndDate) return false

  const today = dayjs().format("YYYY-MM-DD")
  return today >= item.entryStartDate && today <= item.entryEndDate
}

function isTomorrow(item: LotteryItem) {
  const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD")
  return item.entryEndDate === tomorrow
}

function isToday(item: LotteryItem) {
  const today = dayjs().format("YYYY-MM-DD")
  return item.entryEndDate === today
}

async function enrichApplyInfo(item: LotteryItem): Promise<LotteryItem> {
  if (!item.xPostUrl) return item

  const resolved = await resolveApplyInfoFromXPost(item.xPostUrl)

  return {
    ...item,
    applyUrl: resolved.applyUrl,
    applyLabel: resolved.applyLabel,
    applyType: resolved.applyType
  }
}

function buildApplyLines(i: LotteryItem): string[] {
  if (i.applyType === "url" && i.applyUrl) {
    return [`応募リンク: ${i.applyUrl}`]
  }

  if (i.applyType === "store" && i.applyLabel) {
    return [`応募方法: ${i.applyLabel}`]
  }

  if (i.applyLabel) {
    return [`応募方法: ${i.applyLabel}`]
  }

  if (i.xPostUrl) {
    return [`参考X: ${i.xPostUrl}`]
  }

  return []
}

function msgNew(i: LotteryItem) {
  return [
    "【新規抽選】",
    `商品: ${i.productName}`,
    `店舗: ${i.storeName}`,
    `エリア: ${i.area}`,
    `応募期間: ${i.entryPeriod}`,
    `抽選日: ${i.lotteryDate}`,
    `販売期間: ${i.salesPeriod}`,
    ...buildApplyLines(i)
  ].join("\n")
}

function msgUpdate(
  before: LotteryItem,
  after: LotteryItem,
  changedFields: string[]
) {
  return [
    "【抽選情報更新】",
    `商品: ${after.productName}`,
    `店舗: ${after.storeName}`,
    `変更項目: ${changedFields.join(", ")}`,
    "",
    `応募期間: ${before.entryPeriod} → ${after.entryPeriod}`,
    `抽選日: ${before.lotteryDate} → ${after.lotteryDate}`,
    `販売期間: ${before.salesPeriod} → ${after.salesPeriod}`,
    ...buildApplyLines(after)
  ].join("\n")
}

function msgToday(i: LotteryItem) {
  return [
    "【本日締切】",
    `商品: ${i.productName}`,
    `店舗: ${i.storeName}`,
    `応募締切: 本日 (${i.entryEndDate})`,
    `応募期間: ${i.entryPeriod}`,
    ...buildApplyLines(i)
  ].join("\n")
}

function msgTomorrow(i: LotteryItem) {
  return [
    "【締切明日】",
    `商品: ${i.productName}`,
    `店舗: ${i.storeName}`,
    `応募締切: 明日 (${i.entryEndDate})`,
    `応募期間: ${i.entryPeriod}`,
    ...buildApplyLines(i)
  ].join("\n")
}

async function main() {
  const previous: LotteryItem[] = load(latestFile, [])
  const notified: Record<string, boolean> = load(notifiedFile, {})

  const current = await fetchLhubLotteryItems()
  const diff = compareLotteryItems(previous, current)

  for (const item of diff.added) {
    if (!isOpenNow(item)) continue

    const key = `new:${item.key}`
    if (notified[key]) continue

    const enriched = await enrichApplyInfo(item)
    await postToSlack(msgNew(enriched))
    notified[key] = true
  }

  for (const u of diff.updated) {
    if (!isOpenNow(u.after)) continue

    const key = `update:${u.after.key}:${u.after.entryPeriod}`
    if (notified[key]) continue

    const enriched = await enrichApplyInfo(u.after)
    await postToSlack(msgUpdate(u.before, enriched, u.changedFields))
    notified[key] = true
  }

  for (const item of current) {
    if (isTomorrow(item)) {
      const key = `tomorrow:${item.key}:${item.entryEndDate}`

      if (!notified[key]) {
        const enriched = await enrichApplyInfo(item)
        await postToSlack(msgTomorrow(enriched))
        notified[key] = true
      }
    }

    if (isToday(item)) {
      const today = dayjs().format("YYYY-MM-DD")
      const key = `today:${item.key}:${today}`

      if (!notified[key]) {
        const enriched = await enrichApplyInfo(item)
        await postToSlack(msgToday(enriched))
        notified[key] = true
      }
    }
  }

  save(latestFile, current)
  save(notifiedFile, notified)

  console.log("monitor complete")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})