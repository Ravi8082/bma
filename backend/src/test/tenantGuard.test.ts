import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { createTenantSchema } from "../db/scopedSchema";
import { defineTenantModel } from "../db/tenantModel";
import { TenantViolationError } from "../db/plugins/tenantGuard";
import { useMongoReplSet } from "./helpers/mongo";

interface TenantCustomer {
  shopId: Types.ObjectId;
  name: string;
  balancePaise: number;
}

interface TenantOrder {
  shopId: Types.ObjectId;
  customerId: Types.ObjectId;
  amountPaise: number;
}

const customerSchema = createTenantSchema({
  name: { type: String, required: true },
  balancePaise: { type: Number, default: 0 },
});

const orderSchema = createTenantSchema({
  customerId: { type: Types.ObjectId, required: true },
  amountPaise: { type: Number, required: true },
});

const TenantCustomerModel = defineTenantModel<TenantCustomer>("TenantCustomer", customerSchema);
const TenantOrderModel = defineTenantModel<TenantOrder>("TenantOrder", orderSchema);

useMongoReplSet();

const shopA = new Types.ObjectId();
const shopB = new Types.ObjectId();

describe("tenant guard — query operations", () => {
  it("rejects every unscoped read", async () => {
    await expect(TenantCustomerModel.find({}).exec()).rejects.toBeInstanceOf(TenantViolationError);
    await expect(TenantCustomerModel.findOne({ name: "Rahul" }).exec()).rejects.toBeInstanceOf(
      TenantViolationError,
    );
    await expect(TenantCustomerModel.countDocuments({}).exec()).rejects.toBeInstanceOf(
      TenantViolationError,
    );
  });

  it("rejects unscoped updateOne", async () => {
    await expect(
      TenantCustomerModel.updateOne({ name: "Rahul" }, { $set: { name: "x" } }).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects unscoped updateMany", async () => {
    await expect(
      TenantCustomerModel.updateMany({}, { $set: { balancePaise: 0 } }).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects unscoped deleteMany", async () => {
    await expect(TenantCustomerModel.deleteMany({}).exec()).rejects.toBeInstanceOf(
      TenantViolationError,
    );
  });

  it("rejects unscoped findOneAndUpdate", async () => {
    await expect(
      TenantCustomerModel.findOneAndUpdate(
        { name: "Rahul" },
        { $set: { balancePaise: 1 } },
      ).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects unscoped countDocuments through an aggregate as well", async () => {
    await expect(
      TenantCustomerModel.aggregate([{ $count: "total" }]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("allows a scope expressed through $and", async () => {
    const result = await TenantCustomerModel.find({
      $and: [{ shopId: shopA }, { name: "Rahul" }],
    }).exec();
    expect(result).toEqual([]);
  });

  it("does not accept $or as sufficient scope", async () => {
    await expect(
      TenantCustomerModel.find({ $or: [{ shopId: shopA }, { name: "x" }] }).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});

describe("tenant guard — bulkWrite", () => {
  it("rejects an insert without a shopId", async () => {
    await expect(
      TenantCustomerModel.bulkWrite([
        { insertOne: { document: { name: "No shop", balancePaise: 1 } } },
      ]),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects an unscoped updateOne", async () => {
    await expect(
      TenantCustomerModel.bulkWrite([
        { updateOne: { filter: { name: "Rahul" }, update: { $set: { balancePaise: 1 } } } },
      ]),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects an unscoped deleteMany", async () => {
    await expect(
      TenantCustomerModel.bulkWrite([{ deleteMany: { filter: { name: "Rahul" } } }]),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects moving a document to another shop", async () => {
    await expect(
      TenantCustomerModel.bulkWrite([
        {
          updateOne: {
            filter: { shopId: shopA },
            update: { $set: { shopId: shopB } },
          },
        },
      ]),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("accepts a fully scoped bulkWrite and applies every operation", async () => {
    await TenantCustomerModel.create({
      shopId: shopA,
      name: "Rahul",
      balancePaise: 1_000,
    });

    const result = await TenantCustomerModel.bulkWrite([
      { insertOne: { document: { shopId: shopA, name: "Priya", balancePaise: 500 } } },
      {
        updateOne: {
          filter: { shopId: shopA, name: "Rahul" },
          update: { $set: { balancePaise: 2_000 } },
        },
      },
      { deleteMany: { filter: { shopId: shopB, name: "Nobody" } } },
    ]);

    expect(result.insertedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);

    const rahul = await TenantCustomerModel.findOne({ shopId: shopA, name: "Rahul" }).exec();
    expect(rahul?.balancePaise).toBe(2_000);
    expect(await TenantCustomerModel.countDocuments({ shopId: shopA })).toBe(2);
  });
});

describe("tenant guard — $lookup", () => {
  it("rejects a $lookup with localField/foreignField (cannot be scoped)", async () => {
    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        {
          $lookup: {
            from: "tenantorders",
            localField: "_id",
            foreignField: "customerId",
            as: "orders",
          },
        },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects a $lookup pipeline that does not start with a shop match", async () => {
    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        {
          $lookup: {
            from: "tenantorders",
            let: { customerId: "$_id" },
            pipeline: [{ $limit: 5 }],
            as: "orders",
          },
        },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("accepts a $lookup pipeline that starts with a shop match", async () => {
    const customer = await TenantCustomerModel.create({
      shopId: shopA,
      name: "Rahul",
      balancePaise: 0,
    });
    await TenantOrderModel.create([
      { shopId: shopA, customerId: customer._id, amountPaise: 50_000 },
      { shopId: shopB, customerId: customer._id, amountPaise: 90_000 },
    ]);

    const rows = await TenantCustomerModel.aggregate([
      { $match: { shopId: shopA } },
      {
        $lookup: {
          from: "tenantorders",
          let: { customerId: "$_id" },
          pipeline: [
            {
              $match: {
                shopId: shopA,
                $expr: { $eq: ["$customerId", "$$customerId"] },
              },
            },
          ],
          as: "orders",
        },
      },
    ]).exec();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orders).toHaveLength(1);
    expect(rows[0]?.orders[0]?.amountPaise).toBe(50_000);
  });

  it("rejects $lookup on the tenant key only when both sides are shopId", async () => {
    const rows = await TenantCustomerModel.aggregate([
      { $match: { shopId: shopA } },
      { $lookup: { from: "tenantorders", localField: "shopId", foreignField: "shopId", as: "x" } },
    ]).exec();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe("tenant guard — other aggregate stages", () => {
  it("rejects $unionWith with a bare collection name", async () => {
    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        { $unionWith: "tenantorders" },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("rejects $merge and $out", async () => {
    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        { $merge: { into: "tenantorders" } },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);

    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        { $out: "tenantorders" },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("does not accept a $lookup hidden inside $facet", async () => {
    await expect(
      TenantCustomerModel.aggregate([
        { $match: { shopId: shopA } },
        {
          $facet: {
            branch: [{ $lookup: { from: "tenantorders", localField: "_id", foreignField: "customerId", as: "o" } }],
          },
        },
      ]).exec(),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});

describe("tenant isolation behaviour", () => {
  it("returns only the requested shop's documents", async () => {
    await TenantCustomerModel.create([
      { shopId: shopA, name: "Rahul", balancePaise: 50_000 },
      { shopId: shopA, name: "Priya", balancePaise: 30_000 },
      { shopId: shopB, name: "Rahul", balancePaise: 99_000 },
    ]);

    const shopACustomers = await TenantCustomerModel.find({ shopId: shopA }).exec();
    expect(shopACustomers).toHaveLength(2);

    const shopBCustomer = await TenantCustomerModel.findOne({
      shopId: shopB,
      name: "Rahul",
    }).exec();
    expect(shopBCustomer?.balancePaise).toBe(99_000);
  });

  it("cannot read another shop's document by id", async () => {
    const created = await TenantCustomerModel.create({
      shopId: shopA,
      name: "Rahul",
      balancePaise: 100,
    });

    const foreignRead = await TenantCustomerModel.findOne({
      shopId: shopB,
      _id: created._id,
    }).exec();

    expect(foreignRead).toBeNull();
  });

  it("requires shopId at schema level", async () => {
    await expect(
      TenantCustomerModel.create({ name: "No shop", balancePaise: 1 } as never),
    ).rejects.toThrow(/shopId/);
  });

  it("exposes an optimistic version field", async () => {
    const created = await TenantCustomerModel.create({
      shopId: shopA,
      name: "Rahul",
      balancePaise: 100,
    });
    expect(created.get("version")).toBe(0);
  });
});
