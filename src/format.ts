export type Settings = {
  shop_name: string;
  shop_logo: string;
  shop_address: string;
  shop_phone: string;
  shop_email: string;
  currency_symbol: string;
  currency_code: string;
  money_decimals: number;
  date_format: string;
  receipt_header: string;
  receipt_footer: string;
  receipt_show_logo: boolean;
  theme: "light" | "dark";
  accent: string;
  font_scale: number;
  backup_dest: string;
  backup_interval_minutes: number;
};

let current: Pick<Settings, "currency_symbol" | "money_decimals" | "date_format"> = {
  currency_symbol: "Rs",
  money_decimals: 0,
  date_format: "DD/MM/YYYY",
};

export function setFormat(s: Partial<Settings>) {
  current = {
    currency_symbol: s.currency_symbol ?? current.currency_symbol,
    money_decimals: s.money_decimals ?? current.money_decimals,
    date_format: s.date_format ?? current.date_format,
  };
}

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function money(cents: number | null | undefined, opts?: { symbol?: boolean; decimals?: number; snapshot?: any }): string {
  if (cents === null || cents === undefined) return "";
  const dec = opts?.decimals ?? (opts?.snapshot ? Number(opts.snapshot.money_decimals ?? 0) : current.money_decimals);
  const sym = opts?.snapshot ? String(opts.snapshot.currency_symbol ?? "") : current.currency_symbol;
  const neg = cents < 0;
  const a = BigInt(Math.abs(Math.trunc(cents)));
  let body: string;
  if (dec === 2) {
    body = `${group(a / 100n)}.${(a % 100n).toString().padStart(2, "0")}`;
  } else {
    body = group((a + 50n) / 100n);
  }
  const s = `${neg ? "-" : ""}${body}`;
  return opts?.symbol === false || !sym ? s : `${sym} ${s}`;
}

export function moneyInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const neg = cents < 0;
  const a = Math.abs(cents);
  const whole = Math.trunc(a / 100);
  const frac = a % 100;
  return `${neg ? "-" : ""}${whole}${frac ? "." + String(frac).padStart(2, "0") : ""}`;
}

export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/,/g, "").replace(/\s/g, "");
  if (t === "") return null;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return NaN;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  const v = whole * 100n + frac;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return NaN;
  return Number(v);
}

export function parseQty(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return NaN;
  return Number(t);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(iso: string | null | undefined, fmt?: string): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  switch (fmt ?? current.date_format) {
    case "MM/DD/YYYY":
      return `${mo}/${d}/${y}`;
    case "YYYY-MM-DD":
      return `${y}-${mo}-${d}`;
    case "DD MMM YYYY":
      return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
    default:
      return `${d}/${mo}/${y}`;
  }
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;
  const local = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  return `${date(local)} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthRange(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}

export function thisMonth(): string {
  return todayIso().slice(0, 7);
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

export const KIND_LABEL: Record<string, string> = {
  purchase: "Purchase",
  sale: "Sale",
  return: "Return",
  adjustment: "Stock change",
  reversal: "Reversal",
};

export function kindLabel(kind: string, related?: string | null): string {
  if (kind === "reversal" && related) return `Reversal of ${KIND_LABEL[related]?.toLowerCase() ?? related}`;
  return KIND_LABEL[kind] ?? kind;
}

export const FIELD_KINDS: { value: string; label: string; hint: string }[] = [
  { value: "text", label: "Short text", hint: "A word or a line, like a model name or colour" },
  { value: "longtext", label: "Long notes", hint: "Several lines of notes" },
  { value: "int", label: "Whole number", hint: "Like drawer count or model year" },
  { value: "decimal", label: "Number with decimals", hint: "Like length 120.5 cm or engine 125 cc" },
  { value: "money", label: "Money", hint: "An amount of money" },
  { value: "date", label: "Date", hint: "A day, like registration date" },
  { value: "bool", label: "Yes / No", hint: "A tick box" },
  { value: "choice", label: "Choice list", hint: "Pick one from a list you write" },
];

export function kindName(k: string): string {
  return FIELD_KINDS.find((x) => x.value === k)?.label ?? k;
}

export const STATUS: Record<string, { label: string; cls: string }> = {
  in_stock: { label: "In stock", cls: "st-ok" },
  sold: { label: "Sold", cls: "st-sold" },
  out_of_stock: { label: "Out of stock", cls: "st-out" },
  damaged: { label: "Damaged", cls: "st-bad" },
  inactive: { label: "Inactive", cls: "st-off" },
};
