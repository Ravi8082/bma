import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import {
  ADMIN_TICKET_TTL_MS,
  AdminAccessDeniedError,
  AdminAccessService,
  type AdminAuditEvent,
} from "../security/adminAccess";

function createHarness() {
  const events: AdminAuditEvent[] = [];
  const sink = {
    record: async (event: AdminAuditEvent): Promise<void> => {
      events.push(event);
    },
  };
  let now = new Date("2026-11-13T10:00:00.000Z");
  const service = new AdminAccessService(sink, () => now);
  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  return { events, service, advance };
}

const shopA = new Types.ObjectId();
const shopB = new Types.ObjectId();

describe("admin access ticket issuance", () => {
  it("requires a written reason of at least 10 characters", () => {
    const { service } = createHarness();
    expect(() =>
      service.issue({ actorId: "admin-1", role: "ADMIN", shopId: shopA, reason: "check" }),
    ).toThrow(AdminAccessDeniedError);
  });

  it("issues a 15-minute ticket bound to one shop", () => {
    const { service } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });

    expect(ticket.ticketId).toMatch(/^adt_/);
    expect(ticket.shopId.equals(shopA)).toBe(true);
    expect(ticket.expiresAt.getTime() - ticket.issuedAt.getTime()).toBe(ADMIN_TICKET_TTL_MS);
    expect(ticket.reason).toBe("investigating support ticket #412");
  });
});

describe("admin access enforcement", () => {
  it("rejects an expired ticket", async () => {
    const { service, advance } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });

    advance(ADMIN_TICKET_TTL_MS + 1);

    await expect(
      service.execute({ ticket, shopId: shopA, operation: "READ" }, async () => "data"),
    ).rejects.toMatchObject({ code: "ADMIN_TICKET_EXPIRED" });
  });

  it("rejects use against a different shop", async () => {
    const { service } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });

    await expect(
      service.execute({ ticket, shopId: shopB, operation: "READ" }, async () => "data"),
    ).rejects.toMatchObject({ code: "ADMIN_SHOP_MISMATCH" });
  });

  it("makes SUPPORT read-only", async () => {
    const { service } = createHarness();
    const ticket = service.issue({
      actorId: "support-7",
      role: "SUPPORT",
      shopId: shopA,
      reason: "customer called about a wrong bill",
    });

    await expect(
      service.execute({ ticket, shopId: shopA, operation: "WRITE" }, async () => "changed"),
    ).rejects.toMatchObject({ code: "ADMIN_WRITE_FORBIDDEN" });
  });

  it("never allows an unscoped request", async () => {
    const { service } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });

    await expect(
      service.execute(
        { ticket, shopId: undefined as unknown as Types.ObjectId, operation: "READ" },
        async () => "data",
      ),
    ).rejects.toMatchObject({ code: "ADMIN_SHOP_REQUIRED" });
  });

  it("gives ADMIN a write context scoped to the ticket's shop", async () => {
    const { service } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "merging duplicate customer records on request",
    });

    const context = await service.execute(
      { ticket, shopId: shopA, operation: "WRITE" },
      async (ctx) => ctx,
    );

    expect(context).toMatchObject({
      shopId: String(shopA),
      source: "ADMIN_TICKET",
      readOnly: false,
      ticketId: ticket.ticketId,
    });
  });
});

describe("admin access audit trail", () => {
  it("records granted and completed events with the reason", async () => {
    const { service, events } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });

    await service.execute({ ticket, shopId: shopA, operation: "READ" }, async () => 42);

    expect(events.map((event) => event.action)).toEqual([
      "admin.access.granted",
      "admin.access.completed",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        ticketId: ticket.ticketId,
        actorId: "admin-1",
        role: "ADMIN",
        shopId: String(shopA),
        operation: "READ",
        reason: "investigating support ticket #412",
      });
    }
  });

  it("records a failed event and rethrows when the action fails", async () => {
    const { service, events } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "checking a payment mismatch",
    });

    await expect(
      service.execute({ ticket, shopId: shopA, operation: "READ" }, async () => {
        throw new Error("ledger read failed");
      }),
    ).rejects.toThrow("ledger read failed");

    expect(events.map((event) => event.action)).toEqual([
      "admin.access.granted",
      "admin.access.failed",
    ]);
    expect(events[1]?.error).toBe("ledger read failed");
  });

  it("audits a denied request as failed, never as granted", async () => {
    const { service, events, advance } = createHarness();
    const ticket = service.issue({
      actorId: "admin-1",
      role: "ADMIN",
      shopId: shopA,
      reason: "investigating support ticket #412",
    });
    advance(ADMIN_TICKET_TTL_MS + 1);

    await expect(
      service.execute({ ticket, shopId: shopA, operation: "READ" }, async () => "data"),
    ).rejects.toBeInstanceOf(AdminAccessDeniedError);

    expect(events.map((event) => event.action)).toEqual(["admin.access.failed"]);
    expect(events[0]?.error).toBe("ADMIN_TICKET_EXPIRED");
  });
});
