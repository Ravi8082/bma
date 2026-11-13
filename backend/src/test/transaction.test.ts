import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { defineTenantModel } from "../db/tenantModel";
import { createTenantSchema } from "../db/scopedSchema";
import { withTransaction } from "../config/db";
import { useMongoReplSet } from "./helpers/mongo";

interface LedgerRow {
  shopId: Types.ObjectId;
  customerName: string;
  amountPaise: number;
}

const ledgerSchema = createTenantSchema({
  customerName: { type: String, required: true },
  amountPaise: { type: Number, required: true },
});

const LedgerRowModel = defineTenantModel<LedgerRow>("TxnLedgerRow", ledgerSchema);

useMongoReplSet();

const shopId = new Types.ObjectId();

describe("withTransaction()", () => {
  it("commits every write when the callback succeeds", async () => {
    await withTransaction(async (session) => {
      await LedgerRowModel.create([{ shopId, customerName: "Rahul", amountPaise: 50_000 }], {
        session,
      });
      await LedgerRowModel.create([{ shopId, customerName: "Priya", amountPaise: 30_000 }], {
        session,
      });
    });

    const rows = await LedgerRowModel.find({ shopId }).exec();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((total, row) => total + row.amountPaise, 0)).toBe(80_000);
  });

  it("rolls back every write when the callback throws", async () => {
    await expect(
      withTransaction(async (session) => {
        await LedgerRowModel.create([{ shopId, customerName: "Rahul", amountPaise: 50_000 }], {
          session,
        });
        throw new Error("posting failed after the first write");
      }),
    ).rejects.toThrow("posting failed after the first write");

    expect(await LedgerRowModel.countDocuments({ shopId })).toBe(0);
  });

  it("returns the callback result", async () => {
    const postingId = await withTransaction(async (session) => {
      const created = await LedgerRowModel.create(
        [{ shopId, customerName: "Meena", amountPaise: 1_000 }],
        { session },
      );
      return String(created[0]?._id);
    });

    expect(postingId).toMatch(/^[0-9a-f]{24}$/);
  });

  it("keeps the previous committed state after a failed second transaction", async () => {
    await withTransaction(async (session) => {
      await LedgerRowModel.create([{ shopId, customerName: "Rahul", amountPaise: 20_000 }], {
        session,
      });
    });

    await expect(
      withTransaction(async (session) => {
        await LedgerRowModel.create([{ shopId, customerName: "Priya", amountPaise: 10_000 }], {
          session,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await LedgerRowModel.find({ shopId }).exec();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.customerName).toBe("Rahul");
  });
});
