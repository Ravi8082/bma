import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { createTenantSchema } from "../db/scopedSchema";
import { defineTenantModel } from "../db/tenantModel";
import { useMongoReplSet } from "./helpers/mongo";

/**
 * Money storage proof.
 *
 * Paise are stored as BSON Number (double) restricted to safe integers. A
 * double represents every integer up to 2^53 exactly, so integer addition and
 * $sum are exact for our range. These tests assert that property rather than
 * trusting it: any float drift, string coercion or rupee/paise mix fails.
 */
interface LedgerEntry {
  shopId: Types.ObjectId;
  customerId: Types.ObjectId;
  amountPaise: number;
  note?: string;
}

const ledgerSchema = createTenantSchema({
  customerId: { type: Types.ObjectId, required: true },
  amountPaise: {
    type: Number,
    required: true,
    validate: {
      validator: (value: number) => Number.isSafeInteger(value),
      message: "amountPaise must be a safe integer number of paise",
    },
  },
  note: { type: String },
});

const LedgerEntryModel = defineTenantModel<LedgerEntry>("AggLedgerEntry", ledgerSchema);

useMongoReplSet();

const shopA = new Types.ObjectId();
const shopB = new Types.ObjectId();
const rahul = new Types.ObjectId();
const priya = new Types.ObjectId();

describe("paise storage", () => {
  it("refuses a fractional amount at the schema boundary", async () => {
    await expect(
      LedgerEntryModel.create({
        shopId: shopA,
        customerId: rahul,
        amountPaise: 10.5,
      }),
    ).rejects.toThrow(/safe integer/);
  });

  it("refuses an unsafe integer amount", async () => {
    await expect(
      LedgerEntryModel.create({
        shopId: shopA,
        customerId: rahul,
        amountPaise: Number.MAX_SAFE_INTEGER + 2,
      }),
    ).rejects.toThrow(/safe integer/);
  });

  it("stores the exact integer that was written", async () => {
    const created = await LedgerEntryModel.create({
      shopId: shopA,
      customerId: rahul,
      amountPaise: 15_000_050,
    });

    const raw = await LedgerEntryModel.collection.findOne({ _id: created._id });
    expect(raw?.amountPaise).toBe(15_000_050);
    expect(Number.isInteger(raw?.amountPaise)).toBe(true);
    expect(typeof raw?.amountPaise).toBe("number");
  });
});

describe("$sum over paise", () => {
  it("sums to the exact integer, with no floating-point residue", async () => {
    const amounts = [50_000, 123_456_789, 1, 99_999_999, 15_000_050];
    await LedgerEntryModel.insertMany(
      amounts.map((amountPaise) => ({ shopId: shopA, customerId: rahul, amountPaise })),
    );

    const [row] = await LedgerEntryModel.aggregate<{
      total: number;
      count: number;
      max: number;
    }>([
      { $match: { shopId: shopA } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amountPaise" },
          count: { $sum: 1 },
          max: { $max: "$amountPaise" },
        },
      },
    ]).exec();

    const expected = amounts.reduce((total, amount) => total + amount, 0);
    expect(row?.total).toBe(expected);
    expect(Number.isSafeInteger(row?.total)).toBe(true);
    expect(String(row?.total)).not.toContain(".");
    expect(row?.count).toBe(amounts.length);
    expect(row?.max).toBe(123_456_789);
  });

  it("keeps 2,000 single-paise entries exact", async () => {
    await LedgerEntryModel.insertMany(
      Array.from({ length: 2_000 }, () => ({
        shopId: shopA,
        customerId: priya,
        amountPaise: 1,
      })),
    );

    const [row] = await LedgerEntryModel.aggregate<{ total: number }>([
      { $match: { shopId: shopA } },
      { $group: { _id: null, total: { $sum: "$amountPaise" } } },
    ]).exec();

    expect(row?.total).toBe(2_000);
  });

  it("stays exact at the top of the supported range", async () => {
    // ₹10,00,00,000 per entry (the configured ceiling), 1,000 entries.
    const each = 100_000_000_000;
    const count = 1_000;
    await LedgerEntryModel.insertMany(
      Array.from({ length: count }, () => ({
        shopId: shopA,
        customerId: rahul,
        amountPaise: each,
      })),
    );

    const [row] = await LedgerEntryModel.aggregate<{ total: number }>([
      { $match: { shopId: shopA } },
      { $group: { _id: null, total: { $sum: "$amountPaise" } } },
    ]).exec();

    expect(row?.total).toBe(each * count);
    expect(Number.isSafeInteger(row?.total)).toBe(true);
  });

  it("sums signed amounts exactly (credit + debit)", async () => {
    await LedgerEntryModel.insertMany([
      { shopId: shopA, customerId: rahul, amountPaise: 50_000 },
      { shopId: shopA, customerId: rahul, amountPaise: -20_000 },
      { shopId: shopA, customerId: rahul, amountPaise: -1 },
    ]);

    const [row] = await LedgerEntryModel.aggregate<{ balance: number }>([
      { $match: { shopId: shopA, customerId: rahul } },
      { $group: { _id: null, balance: { $sum: "$amountPaise" } } },
    ]).exec();

    expect(row?.balance).toBe(29_999);
  });

  it("groups per customer without leaking across shops", async () => {
    await LedgerEntryModel.insertMany([
      { shopId: shopA, customerId: rahul, amountPaise: 10_000 },
      { shopId: shopA, customerId: rahul, amountPaise: 5_000 },
      { shopId: shopA, customerId: priya, amountPaise: 7_000 },
      { shopId: shopB, customerId: rahul, amountPaise: 999_999 },
    ]);

    const groups = await LedgerEntryModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { shopId: shopA } },
      { $group: { _id: "$customerId", total: { $sum: "$amountPaise" } } },
      { $sort: { total: -1 } },
    ]).exec();

    expect(groups).toEqual([
      { _id: rahul, total: 15_000 },
      { _id: priya, total: 7_000 },
    ]);
  });
});
