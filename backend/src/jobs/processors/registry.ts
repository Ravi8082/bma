import { withTenant, type TenantContext, type TenantDb } from "../../db/tenant";

/**
 * Tenant-scoped job handler contract.
 *
 * A processor receives the tenant context of the shop the job is about and the scoped
 * database handle. Every dispatch runs inside `withTenant()`, so a processor can never
 * accidentally run unscoped even when a caller forgets to wrap the work.
 */
export type TenantScopedJobHandler = (
  context: TenantContext,
  db: TenantDb,
  payload: unknown,
) => Promise<void>;

export interface TenantScopedJobDefinition {
  readonly name: string;
  readonly handler: TenantScopedJobHandler;
}

export class TenantScopedProcessorRegistry {
  private readonly jobs = new Map<string, TenantScopedJobDefinition>();

  register(job: TenantScopedJobDefinition): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`tenant-scoped processor already registered for job "${job.name}"`);
    }
    this.jobs.set(job.name, job);
  }

  get size(): number {
    return this.jobs.size;
  }

  async dispatch(context: TenantContext, name: string, payload: unknown): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`no tenant-scoped processor registered for job "${name}"`);
    }
    await withTenant(context, async (db) => {
      await job.handler(context, db, payload);
    });
  }
}
