/**
 * Free-pilot spend caps.
 *
 * The pilot is free: there is no subscription, payment link or trial. When a shop
 * reaches its daily or monthly AI cost ceiling, the bot keeps recording entries with
 * the deterministic parser and tells the seller once per period. Money is read from
 * `app.cost_log` as integer paise; no float is involved.
 */

import { env } from "../config/env";
import { withTenant } from "../db/tenant";
import { sql } from "../db/sql";

export interface PilotSpend {
  dayPaise: number;
  monthPaise: number;
}

export interface PilotCaps {
  dailyPaise: number;
  monthlyPaise: number;
}

export type PilotCapKind = "DAY" | "MONTH";

export interface PilotCapBreach extends PilotSpend {
  cap: PilotCapKind;
  /** 'YYYY-MM-DD' for the daily cap, 'YYYY-MM' for the monthly cap (UTC). */
  period: string;
}

export const PILOT_CAP_MESSAGE =
  "You've reached today's free-pilot AI limit, so I'm using the basic parser to keep " +
  "recording your entries. Nothing is lost and there is nothing to pay.";

/** UTC midnight at the start of the current day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** UTC midnight at the start of the current month. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Spend today and this month, read under tenant context from the RLS cost table. */
export async function getPilotSpend(shopId: string, now: Date = new Date()): Promise<PilotSpend> {
  const dayStart = utcDayStart(now);
  const monthStart = utcMonthStart(now);
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "pilot-budget" }, async (db) => {
    const row = await db.queryOne<{ day_paise: string; month_paise: string }>(
      sql`SELECT
            COALESCE(SUM(cost_paise) FILTER (WHERE occurred_at >= ${dayStart}), 0)::text AS day_paise,
            COALESCE(SUM(cost_paise) FILTER (WHERE occurred_at >= ${monthStart}), 0)::text AS month_paise
          FROM app.cost_log
          WHERE shop_id = ${shopId}`,
    );
    return {
      dayPaise: Number.parseInt(row?.day_paise ?? "0", 10),
      monthPaise: Number.parseInt(row?.month_paise ?? "0", 10),
    };
  });
}

/**
 * Per-shop ceilings, falling back to the platform defaults.
 *
 * Both columns are nullable: NULL means "use the env default". A shop row that
 * cannot be read also falls back rather than blocking the entry.
 */
export async function pilotCapsFor(shopId: string): Promise<PilotCaps> {
  const fallback: PilotCaps = {
    dailyPaise: env.PILOT_DAILY_CAP_PAISE,
    monthlyPaise: env.PILOT_MONTHLY_CAP_PAISE,
  };
  try {
    return await withTenant(
      { shopId, actorType: "SYSTEM", actorId: "pilot-budget" },
      async (db) => {
        const row = await db.queryOne<{
          pilot_daily_cap_paise: string | null;
          pilot_monthly_cap_paise: string | null;
        }>(
          sql`SELECT pilot_daily_cap_paise, pilot_monthly_cap_paise
                FROM app.shop_settings WHERE shop_id = ${shopId}`,
        );
        if (!row) return fallback;
        const daily = row.pilot_daily_cap_paise
          ? Number.parseInt(row.pilot_daily_cap_paise, 10)
          : fallback.dailyPaise;
        const monthly = row.pilot_monthly_cap_paise
          ? Number.parseInt(row.pilot_monthly_cap_paise, 10)
          : fallback.monthlyPaise;
        return {
          dailyPaise: Number.isSafeInteger(daily) && daily > 0 ? daily : fallback.dailyPaise,
          monthlyPaise:
            Number.isSafeInteger(monthly) && monthly > 0 ? monthly : fallback.monthlyPaise,
        };
      },
    );
  } catch {
    return fallback;
  }
}

/** Which cap, if any, is exhausted. The daily cap wins because it resets sooner. */
export function pilotCapBreach(
  spend: PilotSpend,
  caps: PilotCaps,
  now: Date = new Date(),
): PilotCapBreach | null {
  if (spend.dayPaise >= caps.dailyPaise) {
    return {
      ...spend,
      cap: "DAY",
      period: now.toISOString().slice(0, 10),
    };
  }
  if (spend.monthPaise >= caps.monthlyPaise) {
    return {
      ...spend,
      cap: "MONTH",
      period: now.toISOString().slice(0, 7),
    };
  }
  return null;
}

/**
 * Claim the right to send the polite notice for this period.
 *
 * A partial unique index on `audit_logs (shop_id, after->>'period')` makes this
 * exactly-once even when two messages are processed concurrently. Returns true only
 * for the caller that inserted the row.
 */
export async function claimPilotCapNotice(
  shopId: string,
  breach: PilotCapBreach,
): Promise<boolean> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "pilot-budget" }, async (db) => {
    const rows = await db.query<{ id: string }>(
      sql`INSERT INTO app.audit_logs
            (shop_id, actor_type, actor_id, action, entity_type, entity_id, after)
          VALUES
            (${shopId}, 'SYSTEM', 'pilot-budget', 'PILOT_CAP_NOTICE', 'shop', ${shopId},
             ${JSON.stringify({
               period: breach.period,
               cap: breach.cap,
               dayPaise: breach.dayPaise,
               monthPaise: breach.monthPaise,
             })}::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING id`,
    );
    return rows.length > 0;
  });
}
