import { chromium } from "playwright"

export type ResolvedApplyInfo = {
  applyUrl: string
  applyLabel: string
  applyType: "url" | "store" | "unknown"
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function isLikelyPeriodText(text: string): boolean {
  const t = text.trim()

  return /(?:\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2}).*(?:\d{1,2}:\d{2}|[)）]|日|月|火|水|木|金|土|〜|～|-)/.test(
    t
  )
}

function detectStoreOnly(text: string): ResolvedApplyInfo | null {
  const storePatterns = [
    /店頭QRコード/i,
    /店頭受付/i,
    /店頭応募/i,
    /店頭販売/i,
    /店頭配布/i,
    /店頭/i,
    /店舗QRコード/i,
    /店舗受付/i,
    /店舗応募/i,
    /店舗販売/i,
    /店舗受取/i,
    /店舗配布/i,
    /店舗限定キャンペーン/i,
    /店舗限定/i,
    /店舗/i,
    /マイページの店舗限定キャンペーン/i
  ]

  for (const p of storePatterns) {
    const m = text.match(p)
    if (m) {
      return {
        applyUrl: "",
        applyLabel: m[0],
        applyType: "store"
      }
    }
  }

  return null
}

function trimUrlNoise(url: string): string {
  let cleaned = url

  const stopMarkers = ["※", "#", "Translate", "Views", "…"]
  for (const marker of stopMarkers) {
    const idx = cleaned.indexOf(marker)
    if (idx >= 0) {
      cleaned = cleaned.slice(0, idx)
    }
  }

  // URLの後ろに日本語説明が直結したケースを切る
  const jpNoise = cleaned.match(
    /^(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)([^\x00-\x7F].*)$/
  )
  if (jpNoise) {
    cleaned = jpNoise[1]
  }

  cleaned = cleaned.replace(/[),。.、…]+$/, "")

  return cleaned
}

function detectUrl(text: string): ResolvedApplyInfo | null {
  const compact = text
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .replace(/\s+/g, "")
    .trim()

  const urlMatch = compact.match(/https?:\/\/[^\s"'<>]+/i)
  if (urlMatch) {
    const url = trimUrlNoise(urlMatch[0])

    return {
      applyUrl: url,
      applyLabel: url,
      applyType: "url"
    }
  }

  const domainLikeMatch = compact.match(
    /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>]*)?/i
  )

  if (domainLikeMatch) {
    const raw = trimUrlNoise(domainLikeMatch[0].replace(/^\/+/, ""))

    return {
      applyUrl: `https://${raw}`,
      applyLabel: raw,
      applyType: "url"
    }
  }

  return null
}

function isStopLine(line: string): boolean {
  return /^(当選|購入|期間|受取|引換|Translate post|Last edited|\d+:\d+\s?[AP]M|Views|View post analytics)/i.test(
    line.trim()
  )
}

function extractApplyCandidates(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const candidates: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (!/^応募[:：]/i.test(line)) continue

    const afterColon = line.replace(/^応募[:：]\s*/i, "").trim()

    // 同じ行に応募情報があるケース
    if (afterColon) {
      candidates.push(afterColon)
      continue
    }

    // 「応募：」だけで改行後に続くケース
    const blockLines: string[] = []

    for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
      const nextLine = lines[j]

      if (isStopLine(nextLine)) break
      if (/^応募[:：]/i.test(nextLine)) break

      blockLines.push(nextLine)
    }

    if (blockLines.length > 0) {
      candidates.push(blockLines.join(""))
    }
  }

  return candidates
}

function pickBestApplyCandidate(
  candidates: string[]
): ResolvedApplyInfo | null {
  if (candidates.length === 0) return null

  // 1. URL候補を最優先
  for (const c of candidates) {
    const urlInfo = detectUrl(c)
    if (urlInfo) {
      return urlInfo
    }
  }

  // 2. 店頭/店舗系
  for (const c of candidates) {
    const storeInfo = detectStoreOnly(c)
    if (storeInfo) {
      return storeInfo
    }
  }

  // 3. 期間っぽいものは捨てる
  for (const c of candidates) {
    if (isLikelyPeriodText(c)) continue

    return {
      applyUrl: "",
      applyLabel: c,
      applyType: "unknown"
    }
  }

  return null
}

export async function resolveApplyInfoFromXPost(
  xPostUrl: string
): Promise<ResolvedApplyInfo> {
  if (!xPostUrl || !/^https?:\/\/(x\.com|twitter\.com)\//i.test(xPostUrl)) {
    console.log("[X] invalid xPostUrl:", xPostUrl)
    return {
      applyUrl: "",
      applyLabel: "",
      applyType: "unknown"
    }
  }

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  try {
    console.log("[X] open:", xPostUrl)

    await page.goto(xPostUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    })

    await page.waitForTimeout(3000)

    const articles = page.locator("article")
    const count = await articles.count()
    console.log("[X] article count:", count)

    let text = ""

    for (let i = 0; i < Math.min(count, 3); i++) {
      const t = normalizeText(await articles.nth(i).innerText())
      console.log(`[X] article[${i}] text preview:`, t.slice(0, 500))

      if (/応募[:：]/.test(t) || /期間[:：]/.test(t) || /当選[:：]/.test(t)) {
        text = t
        break
      }
    }

    if (!text && count > 0) {
      text = normalizeText(await articles.first().innerText())
    }

    console.log("[X] selected text preview:", text.slice(0, 1200))

    const candidates = extractApplyCandidates(text)
    console.log("[X] apply candidates:", candidates)

    const picked = pickBestApplyCandidate(candidates)
    if (picked) {
      console.log("[X] picked from candidates:", picked)
      return picked
    }

    // フォールバック1: 全文からURL
    const urlInfo = detectUrl(text)
    if (urlInfo) {
      console.log("[X] fallback url:", urlInfo)
      return urlInfo
    }

    // フォールバック2: 全文から店頭系
    const storeInfo = detectStoreOnly(text)
    if (storeInfo) {
      console.log("[X] fallback store:", storeInfo)
      return storeInfo
    }

    console.log("[X] nothing detected")
    return {
      applyUrl: "",
      applyLabel: "",
      applyType: "unknown"
    }
  } catch (error) {
    console.error("[X] resolve failed:", xPostUrl, error)

    return {
      applyUrl: "",
      applyLabel: "",
      applyType: "unknown"
    }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}