import axios from "axios"
import * as cheerio from "cheerio"
import dayjs from "dayjs"
import type { LotteryItem } from "../types"

const URL = "https://laurier-hub.com/lottery/"

function clean(v: string) {
  return v.replace(/\s+/g, " ").trim()
}

function buildKey(
  product: string,
  store: string,
  area: string,
  entry: string
) {
  return `${product}|${store}|${area}|${entry}`
}

function parsePeriod(period: string) {
  const m = period.match(/(\d{1,2})\/(\d{1,2}).*?(\d{1,2})\/(\d{1,2})/)

  if (!m) {
    return { start: "", end: "" }
  }

  const now = dayjs()
  let startYear = now.year()
  let endYear = now.year()

  const startMonth = Number(m[1])
  const endMonth = Number(m[3])

  if (startMonth === 12 && endMonth === 1) {
    if (now.month() + 1 <= 3) {
      startYear = now.year() - 1
      endYear = now.year()
    } else {
      startYear = now.year()
      endYear = now.year() + 1
    }
  }

  const start = dayjs(
    `${startYear}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`
  ).format("YYYY-MM-DD")

  const end = dayjs(
    `${endYear}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`
  ).format("YYYY-MM-DD")

  return { start, end }
}

let $: cheerio.CheerioAPI

function extractProductStoreFromMainRow(mainRow: cheerio.Cheerio<any>) {
  const td = mainRow.find("td")
  if (td.length < 6) return null

  const productStoreLines = $(td[1])
    .text()
    .split("\n")
    .map(clean)
    .filter(Boolean)
    .filter(v => v !== "New")

  if (productStoreLines.length < 2) return null

  return {
    td,
    product: productStoreLines[0],
    store: productStoreLines[1]
  }
}

function pickXPostUrlFromTbody(tbody: cheerio.Cheerio<any>): string {
  const href =
    tbody.find('a[href*="x.com/"]').first().attr("href") ||
    tbody.find('a[href*="twitter.com/"]').first().attr("href") ||
    ""

  if (href) return href

  const text = tbody.text()
  const textMatch = text.match(/https:\/\/x\.com\/[^\s]+|https:\/\/twitter\.com\/[^\s]+/i)

  if (textMatch) return textMatch[0]

  return ""
}

export async function fetchLhubLotteryItems(): Promise<LotteryItem[]> {
  const res = await axios.get(URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    },
    timeout: 30000
  })

  $ = cheerio.load(res.data)

  const items: LotteryItem[] = []

  $("table > tbody").each((_, tbodyEl) => {
    const tbody = $(tbodyEl)
    const rows = tbody.find("tr")
    if (rows.length === 0) return

    const mainRow = rows.first()
    const parsed = extractProductStoreFromMainRow(mainRow)
    if (!parsed) return

    const td = parsed.td
    const product = parsed.product
    const store = parsed.store

    const area = clean($(td[2]).text())
    const entryPeriod = clean($(td[3]).text())
    const lottery = clean($(td[4]).text()) || "-"
    const sales = clean($(td[5]).text()) || "-"

    if (!product || !store || !area || !entryPeriod) return

    const xPostUrl = pickXPostUrlFromTbody(tbody)
    const { start, end } = parsePeriod(entryPeriod)

    items.push({
      key: buildKey(product, store, area, entryPeriod),
      productName: product,
      storeName: store,
      area,
      entryPeriod,
      lotteryDate: lottery,
      salesPeriod: sales,
      entryStartDate: start,
      entryEndDate: end,
      sourceUrl: URL,
      xPostUrl,
      applyUrl: "",
      applyLabel: "",
      applyType: "unknown"
    })
  })

  return items
}