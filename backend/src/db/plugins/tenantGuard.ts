import type { Aggregate, Query, Schema } from "mongoose";

export class TenantViolationError extends Error {
  readonly code = "TENANT_SCOPE_REQUIRED";

  constructor(modelName: string, operation: string) {
    super(
      `Refusing ${operation} on "${modelName}" without a shopId scope. ` +
        "Every tenant-scoped query must be constrained to one shop, including admin access.",
    );
    this.name = "TenantViolationError";
  }
}

/**
 * True when a Mongo filter is guaranteed to be constrained to a single shop.
 *
 * A top-level shopId is sufficient. Inside $and, any branch that constrains
 * shopId is sufficient (AND narrows). Inside $or it is NOT: one unscoped branch
 * would leak another shop's rows, so $or is never accepted as scope.
 */
export function hasShopScope(filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return false;
  const candidate = filter as Record<string, unknown>;

  const shopId = candidate.shopId;
  if (shopId !== undefined && shopId !== null) return true;

  const and = candidate.$and;
  if (Array.isArray(and)) {
    return and.some((branch) => hasShopScope(branch));
  }

  return false;
}

/** True when an update/replacement document attempts to move a row between shops. */
export function touchesShopId(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;

  if (Array.isArray(update)) {
    return update.some((stage) => touchesShopId(stage));
  }

  const candidate = update as Record<string, unknown>;

  // replacement document
  if ("shopId" in candidate) return true;

  for (const [operator, value] of Object.entries(candidate)) {
    if (!value || typeof value !== "object") continue;

    if (operator === "$rename") {
      if (Object.values(value as Record<string, unknown>).includes("shopId")) return true;
      continue;
    }

    if (
      operator === "$set" ||
      operator === "$setOnInsert" ||
      operator === "$unset" ||
      operator === "$inc" ||
      operator === "$mul" ||
      operator === "$min" ||
      operator === "$max" ||
      operator === "$currentDate" ||
      operator === "$push" ||
      operator === "$addToSet" ||
      operator === "$pull"
    ) {
      if ("shopId" in (value as Record<string, unknown>)) return true;
    }
  }

  return false;
}

const QUERY_OPERATIONS = [
  "count",
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateMany",
  "updateOne",
] as const;

/**
 * Applied to every shop-owned schema. Turns "forgot to filter by shop" from a
 * data breach into a thrown error during development.
 *
 * bulkWrite is not covered here because Mongoose exposes no bulkWrite
 * middleware; `defineTenantModel()` wraps the static instead (see
 * docs/10-admin-access.md and db/tenantModel.ts).
 */
export function tenantGuard(schema: Schema): void {
  const register = schema.pre.bind(schema) as (
    operation: string,
    handler: (this: Query<unknown, unknown>) => void,
  ) => void;

  for (const operation of QUERY_OPERATIONS) {
    register(operation, function guardQuery(this: Query<unknown, unknown>) {
      const filter = this.getFilter() as Record<string, unknown> | undefined;
      if (!hasShopScope(filter)) {
        throw new TenantViolationError(this.model.modelName, operation);
      }
    });
  }

  const registerAggregate = schema.pre.bind(schema) as (
    operation: string,
    handler: (this: Aggregate<unknown[]>) => void,
  ) => void;

  registerAggregate("aggregate", function guardAggregate(this: Aggregate<unknown[]>) {
    assertPipelineScope(this.pipeline() as unknown[], this.model().modelName, true);
  });
}

/**
 * Aggregate pipelines get stricter treatment than queries:
 *
 * - the first stage must be a shop-scoped $match;
 * - every $lookup must either carry a pipeline that starts with a shop-scoped
 *   $match, or join on the tenant key itself (localField/foreignField shopId);
 * - $graphLookup must restrict its search with a shop-scoped match;
 * - $unionWith must bring its own shop-scoped pipeline;
 * - $merge and $out are rejected outright (writes belong in services, inside a
 *   transaction, with audit records — never in a read pipeline).
 */
export function assertPipelineScope(
  pipeline: readonly unknown[],
  modelName: string,
  requireLeadingMatch: boolean,
): void {
  if (requireLeadingMatch) {
    const first = pipeline[0] as Record<string, unknown> | undefined;
    if (!first || !hasShopScope(first.$match)) {
      throw new TenantViolationError(modelName, "aggregate");
    }
  }

  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;
    const record = stage as Record<string, unknown>;

    if ("$lookup" in record) assertLookupScope(record.$lookup, modelName);
    if ("$graphLookup" in record) assertGraphLookupScope(record.$graphLookup, modelName);
    if ("$unionWith" in record) assertUnionWithScope(record.$unionWith, modelName);

    if ("$facet" in record) {
      const facet = record.$facet;
      if (facet && typeof facet === "object") {
        for (const branch of Object.values(facet as Record<string, unknown>)) {
          if (Array.isArray(branch)) assertPipelineScope(branch, modelName, false);
        }
      }
    }

    if ("$merge" in record || "$out" in record) {
      throw new TenantViolationError(modelName, "aggregate $merge/$out");
    }
  }
}

function assertLookupScope(value: unknown, modelName: string): void {
  if (!value || typeof value !== "object") {
    throw new TenantViolationError(modelName, "aggregate $lookup");
  }
  const lookup = value as Record<string, unknown>;

  if (Array.isArray(lookup.pipeline)) {
    if (lookup.pipeline.length === 0) {
      throw new TenantViolationError(modelName, "aggregate $lookup (empty pipeline)");
    }
    const first = lookup.pipeline[0] as Record<string, unknown> | undefined;
    if (!first || !hasShopScope(first.$match)) {
      throw new TenantViolationError(modelName, "aggregate $lookup");
    }
    assertPipelineScope(lookup.pipeline, modelName, false);
    return;
  }

  // The localField/foreignField form cannot be scoped by the guard. It is
  // allowed only when it joins on the tenant key itself.
  if (lookup.localField === "shopId" && lookup.foreignField === "shopId") return;

  throw new TenantViolationError(modelName, "aggregate $lookup");
}

function assertGraphLookupScope(value: unknown, modelName: string): void {
  if (!value || typeof value !== "object") {
    throw new TenantViolationError(modelName, "aggregate $graphLookup");
  }
  const graph = value as Record<string, unknown>;
  if (!hasShopScope(graph.restrictSearchWithMatch)) {
    throw new TenantViolationError(modelName, "aggregate $graphLookup");
  }
}

function assertUnionWithScope(value: unknown, modelName: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // string form ($unionWith: "collection") cannot carry a scope.
    throw new TenantViolationError(modelName, "aggregate $unionWith");
  }
  const union = value as Record<string, unknown>;
  if (!Array.isArray(union.pipeline)) {
    throw new TenantViolationError(modelName, "aggregate $unionWith");
  }
  assertPipelineScope(union.pipeline, modelName, true);
}
