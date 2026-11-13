import { randomUUID } from "node:crypto";
import { Types } from "mongoose";

export type AdminRole = "ADMIN" | "SUPPORT";
export type AdminOperation = "READ" | "WRITE";

/**
 * Cross-shop access is deliberately NOT "run any query you like".
 *
 * It is a time-boxed ticket for exactly one shop and one operation. The tenant
 * guard stays active: an admin context still carries a single shopId, so an
 * unscoped query is impossible for admins too. Every use is audited before the
 * data is touched and again when the action completes or fails.
 */
export interface AdminAccessTicket {
  ticketId: string;
  actorId: string;
  role: AdminRole;
  shopId: Types.ObjectId;
  reason: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface IssueTicketInput {
  actorId: string;
  role: AdminRole;
  shopId: Types.ObjectId;
  reason: string;
}

export interface AdminTenantContext {
  shopId: string;
  actorId: string;
  role: AdminRole;
  source: "ADMIN_TICKET";
  ticketId: string;
  readOnly: boolean;
}

export interface AdminAuditEvent {
  action: "admin.access.granted" | "admin.access.completed" | "admin.access.failed";
  ticketId: string;
  actorId: string;
  role: AdminRole;
  shopId: string;
  reason: string;
  operation: AdminOperation;
  at: Date;
  error?: string;
}

export interface AdminAuditSink {
  record(event: AdminAuditEvent): Promise<void>;
}

export type AdminDenialCode =
  | "ADMIN_REASON_REQUIRED"
  | "ADMIN_TICKET_EXPIRED"
  | "ADMIN_SHOP_MISMATCH"
  | "ADMIN_SHOP_REQUIRED"
  | "ADMIN_WRITE_FORBIDDEN"
  | "ADMIN_OPERATION_REQUIRED";

export class AdminAccessDeniedError extends Error {
  readonly code: AdminDenialCode;

  constructor(code: AdminDenialCode, message: string) {
    super(message);
    this.name = "AdminAccessDeniedError";
    this.code = code;
  }
}

export const ADMIN_TICKET_TTL_MS = 15 * 60 * 1000;
const MIN_REASON_LENGTH = 10;

export interface AdminAccessRequest {
  ticket: AdminAccessTicket;
  shopId: Types.ObjectId;
  operation: AdminOperation;
}

export class AdminAccessService {
  constructor(
    private readonly audit: AdminAuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(input: IssueTicketInput): AdminAccessTicket {
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new AdminAccessDeniedError(
        "ADMIN_REASON_REQUIRED",
        `a written reason of at least ${MIN_REASON_LENGTH} characters is required`,
      );
    }
    if (!input.actorId.trim()) {
      throw new AdminAccessDeniedError("ADMIN_REASON_REQUIRED", "actorId is required");
    }

    const issuedAt = this.now();
    return {
      ticketId: `adt_${randomUUID()}`,
      actorId: input.actorId,
      role: input.role,
      shopId: input.shopId,
      reason,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + ADMIN_TICKET_TTL_MS),
    };
  }

  /**
   * Run `fn` with a single-shop admin context. The callback receives only the
   * scoped context — there is no API here that returns a cross-shop handle.
   */
  async execute<T>(
    request: AdminAccessRequest,
    fn: (context: AdminTenantContext) => Promise<T>,
  ): Promise<T> {
    const base = {
      ticketId: request.ticket.ticketId,
      actorId: request.ticket.actorId,
      role: request.ticket.role,
      shopId: String(request.shopId ?? request.ticket.shopId),
      reason: request.ticket.reason,
      operation: request.operation,
      at: this.now(),
    };

    let context: AdminTenantContext;
    try {
      context = this.authorize(request);
    } catch (error) {
      // Denied attempts are security-relevant: record them before rethrowing.
      await this.audit.record({
        ...base,
        action: "admin.access.failed",
        error: error instanceof AdminAccessDeniedError ? error.code : "ADMIN_DENIED",
      });
      throw error;
    }

    await this.audit.record({ ...base, action: "admin.access.granted" });

    try {
      const result = await fn(context);
      await this.audit.record({ ...base, action: "admin.access.completed" });
      return result;
    } catch (error) {
      await this.audit.record({
        ...base,
        action: "admin.access.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private authorize(request: AdminAccessRequest): AdminTenantContext {
    const { ticket, shopId, operation } = request;
    const now = this.now();

    if (operation !== "READ" && operation !== "WRITE") {
      throw new AdminAccessDeniedError("ADMIN_OPERATION_REQUIRED", "operation must be READ or WRITE");
    }
    if (!shopId || !(shopId instanceof Types.ObjectId)) {
      throw new AdminAccessDeniedError(
        "ADMIN_SHOP_REQUIRED",
        "an explicit target shopId is required; admin access is never unscoped",
      );
    }
    if (!ticket.shopId.equals(shopId)) {
      throw new AdminAccessDeniedError(
        "ADMIN_SHOP_MISMATCH",
        "this ticket was issued for a different shop",
      );
    }
    if (now.getTime() >= ticket.expiresAt.getTime()) {
      throw new AdminAccessDeniedError("ADMIN_TICKET_EXPIRED", "admin access ticket has expired");
    }
    if (ticket.role === "SUPPORT" && operation === "WRITE") {
      throw new AdminAccessDeniedError(
        "ADMIN_WRITE_FORBIDDEN",
        "support accounts have read-only cross-shop access",
      );
    }

    return {
      shopId: String(ticket.shopId),
      actorId: ticket.actorId,
      role: ticket.role,
      source: "ADMIN_TICKET",
      ticketId: ticket.ticketId,
      readOnly: operation === "READ",
    };
  }
}
