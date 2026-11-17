/**
 * Plain-text receipt shown to the seller after a confirmed entry.
 *
 * Everything here is integer paise. Line totals are recomputed from quantity and
 * unit price instead of trusting a stored total, so a malformed or stale item can
 * never change the money the seller sees. The output is deliberately plain text
 * with no markdown so the seller can forward it as-is.
 */

export interface ReceiptItem {
  name: string;
  qty: number;
  unit?: string;
  unitPricePaise: number;
}

export interface ReceiptInput {
  shopName: string;
  customerName: string;
  entryType: string;
  items: ReceiptItem[];
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  date: string;
  entryId: string;
}

const MAX_ITEM_QTY = 1_000_000;
const MAX_ITEM_NAME = 80;

/** Integer-only rupee display. No float arithmetic touches a monetary value. */
export function formatPaise(amountPaise: number | string): string {
  const value = typeof amountPaise === "string" ? Number.parseInt(amountPaise, 10) : amountPaise;
  if (!Number.isSafeInteger(value)) return "₹0";
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value)).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return fraction === "00" ? `${sign}₹${whole}` : `${sign}₹${whole}.${fraction}`;
}

/** Quantity × unit price, in integer paise. Returns null when the item is malformed. */
export function lineTotalPaise(item: ReceiptItem): number | null {
  if (!Number.isSafeInteger(item.qty) || item.qty <= 0 || item.qty > MAX_ITEM_QTY) return null;
  if (!Number.isSafeInteger(item.unitPricePaise) || item.unitPricePaise < 0) return null;
  const total = item.qty * item.unitPricePaise;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Defensive read of a `jsonb` items array. Invalid entries are dropped rather
 * than allowed to crash a confirmation that has already posted money.
 */
export function parseReceiptItems(raw: unknown): ReceiptItem[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const items: ReceiptItem[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const qty = record.qty;
    const unitPricePaise = record.unitPricePaise;
    if (name.length === 0 || name.length > MAX_ITEM_NAME) continue;
    if (typeof qty !== "number" || typeof unitPricePaise !== "number") continue;
    const item: ReceiptItem = { name, qty, unitPricePaise };
    if (typeof record.unit === "string" && record.unit.trim().length > 0) {
      item.unit = record.unit.trim().slice(0, 20);
    }
    if (lineTotalPaise(item) === null) continue;
    items.push(item);
  }
  return items;
}

/** Shop-local date, formatted for forwarding. */
export function formatReceiptDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(instant);
}

function itemLabel(item: ReceiptItem): string {
  const unit = item.unit ? ` ${item.unit}` : "";
  const total = lineTotalPaise(item) ?? 0;
  return `${item.name} x${item.qty}${unit} @ ${formatPaise(item.unitPricePaise)} = ${formatPaise(total)}`;
}

/** The exact text queued to the seller. Kept grep-friendly and forwardable. */
export function buildReceipt(input: ReceiptInput): string {
  const lines = [
    "✅ Entry confirmed.",
    "🧾 Receipt",
    `Shop: ${input.shopName}`,
    `Customer: ${input.customerName}`,
  ];

  if (input.items.length > 0) {
    lines.push("Items:");
    for (const item of input.items) lines.push(`  • ${itemLabel(item)}`);
  }

  lines.push(`Total: ${formatPaise(input.totalPaise)}`);
  lines.push(`Paid: ${formatPaise(input.paidPaise)}`);
  lines.push(`Balance: ${formatPaise(input.balancePaise)}`);
  lines.push(`Date: ${input.date}`);
  lines.push(`Entry: ${input.entryId.slice(0, 8)}`);

  return lines.join("\n");
}
