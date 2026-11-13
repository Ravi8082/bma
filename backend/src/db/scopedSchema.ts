import { Schema, type SchemaDefinition, type SchemaOptions } from "mongoose";
import { tenantGuard } from "./plugins/tenantGuard";

/**
 * Base schema for every shop-owned collection.
 *
 * - shopId is required and indexed: the tenant key, never trusted from a client.
 * - optimisticConcurrency turns a stale write into a VersionError (→ 409).
 * - tenantGuard refuses any query that is not scoped to one shop.
 */
export function createTenantSchema(
  definition: SchemaDefinition,
  options: SchemaOptions = {},
): Schema {
  const schema = new Schema(
    {
      shopId: {
        type: Schema.Types.ObjectId,
        ref: "Shop",
        required: true,
        index: true,
      },
      ...definition,
    },
    {
      timestamps: true,
      versionKey: "version",
      optimisticConcurrency: true,
      ...options,
    },
  );

  schema.plugin(tenantGuard);
  return schema;
}

/** Fields every shop-owned document exposes through the API. */
export interface TenantDocumentShape {
  _id: string;
  shopId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}
