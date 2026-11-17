import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { confirmDraft } from "../../whatsapp/confirmation";
import { formatPaise, formatReceiptDate, lineTotalPaise } from "../../whatsapp/receipt";
import { ledgerCount, outboxRows, seedDraft, seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const deps = { keyRef: env.FIELD_ENCRYPTION_KEY_REF };

describe("receipt maths", () => {
  it("formats integer paise without floating point", () => {
    expect(formatPaise(0)).toBe("₹0");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(12_345)).toBe("₹123.45");
    expect(formatPaise("30000")).toBe("₹300");
    expect(formatPaise(-150)).toBe("-₹1.50");
  });

  it("recomputes a line total from quantity and unit price", () => {
    expect(lineTotalPaise({ name: "Rose", qty: 3, unitPricePaise: 12_500 })).toBe(37_500);
    expect(lineTotalPaise({ name: "Bad", qty: 1.5, unitPricePaise: 100 })).toBeNull();
    expect(lineTotalPaise({ name: "Bad", qty: 1, unitPricePaise: -1 })).toBeNull();
  });

  it("formats the shop-local date for forwarding", () => {
    expect(formatReceiptDate(new Date("2026-06-15T13:00:00Z"), "Asia/Kolkata")).toBe("15 Jun 2026");
    expect(formatReceiptDate(new Date("2026-06-15T22:30:00Z"), "America/New_York")).toBe("15 Jun 2026");
  });
});

describe("plain-text receipt after confirm", () => {
  it("sends shop, customer, itemised totals, paid, balance and shop-local date", async () => {
    const shop = await seedShop({ name: "Sharma Flowers" });
    const draftId = await seedDraft(shop, {
      customerName: "Ramesh",
      amountPaise: 50_000,
      isCreditSale: true,
      items: [
        { name: "Rose", qty: 2, unit: "bunch", unitPricePaise: 15_000 },
        { name: "Lily", qty: 1, unitPricePaise: 20_000 },
        // A stored line total is ignored in favour of qty × unit price.
        { name: "Marigold", qty: 1, unitPricePaise: 0, lineTotalPaise: 999_999 },
      ],
    });

    const result = await confirmDraft(shop.shopId, draftId, deps);
    expect(result.status).toBe("CONFIRMED");

    const rows = await outboxRows(shop.shopId);
    expect(rows).toHaveLength(1);
    const text = rows[0]!.payload.text ?? "";
    expect(text).toContain("✅ Entry confirmed.");
    expect(text).toContain("🧾 Receipt");
    expect(text).toContain("Shop: Sharma Flowers");
    expect(text).toContain("Customer: Ramesh");
    expect(text).toContain("Items:");
    expect(text).toContain("Rose x2 bunch @ ₹150 = ₹300");
    expect(text).toContain("Lily x1 @ ₹200 = ₹200");
    expect(text).toContain("Marigold x1 @ ₹0 = ₹0");
    expect(text).not.toContain("999999");
    expect(text).toContain("Total: ₹500");
    expect(text).toContain("Paid: ₹0");
    expect(text).toContain("Balance: ₹500");
    expect(text).toMatch(/Date: \d{2} [A-Z][a-z]{2} \d{4}/);
    expect(text).toMatch(/Entry: [0-9a-f]{8}/);

    expect(await ledgerCount(shop.shopId)).toBe(1);
  });

  it("shows a payment as paid and the reduced balance", async () => {
    const shop = await seedShop({ name: "Patel Kirana" });
    const draftId = await seedDraft(shop, {
      customerName: "Sunita",
      amountPaise: 20_000,
      entryType: "PAYMENT_IN",
      direction: "CREDIT",
      isCreditSale: false,
      customerBalancePaise: 50_000,
    });

    const result = await confirmDraft(shop.shopId, draftId, deps);
    expect(result.status).toBe("CONFIRMED");

    const text = (await outboxRows(shop.shopId))[0]!.payload.text ?? "";
    expect(text).toContain("Customer: Sunita");
    expect(text).not.toContain("Items:");
    expect(text).toContain("Total: ₹200");
    expect(text).toContain("Paid: ₹200");
    expect(text).toContain("Balance: ₹300");
  });

  it("omits the items block when a draft has no item lines", async () => {
    const shop = await seedShop();
    const draftId = await seedDraft(shop, { customerName: "Asha", amountPaise: 30_000 });

    await confirmDraft(shop.shopId, draftId, deps);

    const text = (await outboxRows(shop.shopId))[0]!.payload.text ?? "";
    expect(text).toContain("Customer: Asha");
    expect(text).not.toContain("Items:");
    expect(text).toContain("Total: ₹300");
    expect(text).toContain("Balance: ₹300");
  });
});
