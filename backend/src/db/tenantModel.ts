import mongoose, { type Model, type Schema } from "mongoose";
import { TenantViolationError, hasShopScope, touchesShopId } from "./plugins/tenantGuard";

/**
 * Validate every operation of a bulkWrite against one shop.
 *
 * Mongoose has no bulkWrite middleware, so this check cannot live in the
 * schema plugin. `defineTenantModel()` installs it on the model, which is why
 * repositories must never call `mongoose.model()` directly.
 */
export function assertBulkWriteScoped(operations: readonly unknown[], modelName: string): void {
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") {
      throw new TenantViolationError(modelName, "bulkWrite");
    }

    const entry = operation as Record<string, unknown>;

    if ("insertOne" in entry) {
      const insert = entry.insertOne as { document?: unknown } | undefined;
      if (!insert || !hasShopScope(insert.document)) {
        throw new TenantViolationError(modelName, "bulkWrite insertOne");
      }
      continue;
    }

    if ("replaceOne" in entry) {
      const replace = entry.replaceOne as
        | { filter?: unknown; replacement?: unknown }
        | undefined;
      if (!replace || !hasShopScope(replace.filter)) {
        throw new TenantViolationError(modelName, "bulkWrite replaceOne");
      }
      if (touchesShopId(replace.replacement)) {
        throw new TenantViolationError(modelName, "bulkWrite replaceOne (shopId change)");
      }
      continue;
    }

    if ("updateOne" in entry || "updateMany" in entry) {
      const update = (entry.updateOne ?? entry.updateMany) as
        | { filter?: unknown; update?: unknown }
        | undefined;
      if (!update || !hasShopScope(update.filter)) {
        throw new TenantViolationError(modelName, "bulkWrite update");
      }
      if (touchesShopId(update.update)) {
        throw new TenantViolationError(modelName, "bulkWrite update (shopId change)");
      }
      continue;
    }

    if ("deleteOne" in entry || "deleteMany" in entry) {
      const remove = (entry.deleteOne ?? entry.deleteMany) as { filter?: unknown } | undefined;
      if (!remove || !hasShopScope(remove.filter)) {
        throw new TenantViolationError(modelName, "bulkWrite delete");
      }
      continue;
    }

    throw new TenantViolationError(modelName, "bulkWrite (unknown operation)");
  }
}

function installBulkWriteGuard(model: { modelName: string }): void {
  const marker = model as unknown as { __bulkWriteGuarded?: boolean };
  if (marker.__bulkWriteGuarded) return;

  // Keep this cast structural. Instantiating Mongoose's Model<unknown> generic
  // here causes a pathological type expansion in tsc.
  const target = model as unknown as {
    modelName: string;
    bulkWrite: (operations: unknown[], ...rest: unknown[]) => Promise<unknown>;
  };

  const original = target.bulkWrite.bind(target);

  const guarded = async (operations: unknown[], ...rest: unknown[]): Promise<unknown> => {
    assertBulkWriteScoped(operations, target.modelName);
    return original(operations, ...rest);
  };

  target.bulkWrite = guarded;
  Object.defineProperty(model, "__bulkWriteGuarded", { value: true, enumerable: false });
}

/**
 * The only sanctioned way to obtain a tenant-scoped model.
 *
 * - registers the schema's query/aggregate guard (already attached by
 *   createTenantSchema)
 * - installs the bulkWrite guard, which Mongoose middleware cannot express
 */
export function defineTenantModel<T>(
  name: string,
  schema: Schema,
  collection?: string,
): Model<T> {
  const existing = mongoose.models[name] as Model<T> | undefined;
  const model = existing ?? mongoose.model<T>(name, schema, collection);
  installBulkWriteGuard(model);
  return model;
}
