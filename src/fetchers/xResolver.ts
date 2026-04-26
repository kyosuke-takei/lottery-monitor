import { chromium, type BrowserContext, type Locator } from "playwright"

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

async function resolveTcoUrl(context: BrowserContext, tcoUrl: string): Promise<string> {
  const newPage = await context.newPage()
  let capturedUrl = tcoUrl

  try {
    // t.co以外へのナビゲーションをキャプチャし即中断（ページロード不要）
    await newPage.route("**", async (route) => {
      const url = route.request().url()
      if (!url.startsWith("https://t.co/")) {
        capturedUrl = url
        await route.abort()
      } else {
        await route.continue()
      }
    })

    await newPage.goto(tcoUrl, { timeout: 15000 }).catch(() => {})
    console.log("[X] resolveTco:", tcoUrl, "→", capturedUrl)
    return capturedUrl
  } catch (e) {
    console.error("[X] resolveTco error:", tcoUrl, e)
    return tcoUrl
  } finally {
    await newPage.close().catch(() => {})
  }
}

async function extractExternalUrlsFromArticle(articleEl: Locator, context: BrowserContext): Promise<string[]> {
  try {
    const hrefs: string[] = await articleEl
      .locator('a[href^="https://t.co/"]')
      .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href))
    console.log("[X] t.co hrefs:", hrefs)

    const results: string[] = []
    for (const href of hrefs) {
      const finalUrl = await resolveTcoUrl(context, href)
      if (!/^https?:\/\/(x\.com|twitter\.com|t\.co)/i.test(finalUrl)) {
        results.push(finalUrl)
      }
    }
    return results
  } catch (e) {
    console.error("[X] extractExternalUrls error:", e)
    return []
  }
}

function findUrlForProduct(text: string, productName: string, externalUrls: string[]): string | null {
  if (!productName || externalUrls.length === 0) return null

  // 商品名が単独行として登場する位置を探す（タイトル行のスラッシュ区切りは除外）
  const escaped = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const standaloneRe = new RegExp(`(?:^|\n)${escaped}\n`)
  const match = standaloneRe.exec(text)
  if (!match) return null

  const nameStart = match.index + match[0].indexOf(productName)
  const afterProduct = text.slice(nameStart + productName.length)

  const urlInfo = detectUrl(afterProduct)
  if (!urlInfo) return null

  // テキストURLのパス部分でexternalUrlsを照合
  try {
    const textPath = new URL(urlInfo.applyUrl).pathname
    const matched = externalUrls.find((u) => u.includes(textPath))
    if (matched) return matched
  } catch {
    const pathMatch = urlInfo.applyUrl.match(/\/[^\s?#]+/)
    if (pathMatch) {
      const matched = externalUrls.find((u) => u.includes(pathMatch[0]))
      if (matched) return matched
    }
  }

  return null
}

export async function resolveApplyInfoFromXPost(
  xPostUrl: string,
  productName?: string
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
  const context = await browser.newContext()
  const page = await context.newPage()

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
    let targetIndex = 0

    for (let i = 0; i < Math.min(count, 3); i++) {
      const t = normalizeText(await articles.nth(i).innerText())
      console.log(`[X] article[${i}] text preview:`, t.slice(0, 500))

      if (/応募[:：]/.test(t) || /期間[:：]/.test(t) || /当選[:：]/.test(t)) {
        text = t
        targetIndex = i
        break
      }
    }

    if (!text && count > 0) {
      text = normalizeText(await articles.first().innerText())
      targetIndex = 0
    }

    console.log("[X] selected text preview:", text.slice(0, 1200))

    // href属性のt.co URLをリダイレクト解決して実URLを取得（wwwなど正確なURLを得るため）
    const externalUrls = await extractExternalUrlsFromArticle(articles.nth(targetIndex), context)
    console.log("[X] external urls from hrefs:", externalUrls)

    const candidates = extractApplyCandidates(text)
    console.log("[X] apply candidates:", candidates)

    const picked = pickBestApplyCandidate(candidates)

    // 商品名でテキストURLをexternalUrlsに照合して正確なURLを選択
    if (externalUrls.length > 0) {
      const matchedUrl = findUrlForProduct(text, productName ?? "", externalUrls)
      if (matchedUrl) {
        console.log("[X] product-matched url:", matchedUrl)
        return { applyUrl: matchedUrl, applyLabel: matchedUrl, applyType: "url" }
      }

      // 商品名で絞り込めなかった場合は最初のURLを使用
      if (picked?.applyType === "url" || !picked) {
        const url = externalUrls[0]
        console.log("[X] using first href-resolved url:", url)
        return { applyUrl: url, applyLabel: url, applyType: "url" }
      }
    }

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
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}