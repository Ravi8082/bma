import { randomBytes } from "node:crypto";

export interface IssuedCode {
  code: string;
  shopId: string;
  phone: string;
  expiresAt: number;
}

export interface ChannelSession {
  token: string;
  shopId: string;
  phone: string;
  expiresAt: number;
}

export interface SessionView {
  shopId: string;
  phone: string;
  expiresAt: number;
}

/**
 * In-memory state for the local web chat test channel.
 *
 * Codes are single-use and short lived. Sessions are server-side so a code cannot be
 * replayed after it has been redeemed. Nothing here is persisted: the channel exists
 * only for local testing and a restart intentionally invalidates every link.
 */
export class TestChannelStore {
  private readonly codes = new Map<string, IssuedCode>();
  private readonly sessions = new Map<string, ChannelSession>();
  private readonly sends = new Map<string, number[]>();

  issueCode(
    shopId: string,
    phone: string,
    ttlMs: number,
    now: number = Date.now(),
  ): IssuedCode {
    this.prune(now);
    const issued: IssuedCode = {
      code: randomBytes(24).toString("base64url"),
      shopId,
      phone,
      expiresAt: now + ttlMs,
    };
    this.codes.set(issued.code, issued);
    return issued;
  }

  /** Redeem once. A second attempt with the same code returns null. */
  redeemCode(code: string, now: number = Date.now()): { shopId: string; phone: string } | null {
    const issued = this.codes.get(code);
    if (!issued) return null;
    this.codes.delete(code);
    if (issued.expiresAt <= now) return null;
    return { shopId: issued.shopId, phone: issued.phone };
  }

  createSession(
    shopId: string,
    phone: string,
    ttlMs: number,
    now: number = Date.now(),
  ): ChannelSession {
    const session: ChannelSession = {
      token: randomBytes(32).toString("hex"),
      shopId,
      phone,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  getSession(token: string | undefined, now: number = Date.now()): SessionView | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return null;
    }
    return { shopId: session.shopId, phone: session.phone, expiresAt: session.expiresAt };
  }

  /** Fixed-window rate limit per session token. Returns false when the window is full. */
  allowSend(
    token: string,
    limit: number,
    windowMs: number,
    now: number = Date.now(),
  ): boolean {
    const cutoff = now - windowMs;
    const recent = (this.sends.get(token) ?? []).filter((at) => at > cutoff);
    if (recent.length >= limit) {
      this.sends.set(token, recent);
      return false;
    }
    recent.push(now);
    this.sends.set(token, recent);
    return true;
  }

  reset(): void {
    this.codes.clear();
    this.sessions.clear();
    this.sends.clear();
  }

  private prune(now: number): void {
    for (const [code, issued] of this.codes) {
      if (issued.expiresAt <= now) this.codes.delete(code);
    }
  }
}

export const testChannelStore = new TestChannelStore();
