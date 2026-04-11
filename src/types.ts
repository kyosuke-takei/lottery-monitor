export type LotteryItem = {
  key: string

  productName: string
  storeName: string
  area: string

  entryPeriod: string
  lotteryDate: string
  salesPeriod: string

  entryStartDate: string
  entryEndDate: string

  sourceUrl: string      // LHUBページ
  xPostUrl: string       // XポストURL
  applyUrl: string       // 応募先URL
  applyLabel: string     // 店頭QRコード / 店舗 / マイページの店舗限定キャンペーン など
  applyType: "url" | "store" | "unknown"
}

export type DiffResult = {
  added: LotteryItem[]
  updated: {
    before: LotteryItem
    after: LotteryItem
    changedFields: string[]
  }[]
}