export type ApplyType =
  | "online"
  | "store"
  | "app"
  | "x"
  | "other"
  | "unknown";

export interface LotteryItem {
  source: "lhub";
  itemId: string;
  productName: string;
  storeName: string;
  area: string;
  entryPeriod: string;
  entryStart?: string | null;
  entryEnd?: string | null;
  lotteryDate?: string | null;
  salePeriod?: string | null;
  url: string;
  applyType: ApplyType;
  fetchedAt: string;
}

export interface ChangedLotteryItem {
  before: LotteryItem;
  after: LotteryItem;
  changedFields: Array<keyof LotteryItem>;
}

export interface DiffResult {
  added: LotteryItem[];
  removed: LotteryItem[];
  changed: ChangedLotteryItem[];
}