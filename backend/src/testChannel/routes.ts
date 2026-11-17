/**
 * Local web chat test channel.
 *
 * This is a simulator UI, not a WhatsApp client. It deliberately reuses the webhook's
 * persist-before-acknowledge path (`persistInboundMessage`) so an inbound message is
 * committed to `app.inbox_messages` before the page receives a success response.
 *
 * It does not test templates, the 24-hour service window, status webhooks, or real
 * WhatsApp button payloads. See docs/test-channel.md.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { withTransaction } from "../config/db";
import { phoneBlindIndex } from "../crypto/blindIndex";
import { notFound, tooManyRequests, unauthorized, unprocessable } from "../errors/AppError";
import { simulatorStore } from "../container";
import { queryWithoutTenant, withTenant } from "../db/tenant";
import { sql } from "../db/sql";
import {
  persistInboundMessage,
  type InboundMessageToPersist,
  type PersistedInbound,
} from "../whatsapp/webhookController";
import { testChannelStore, type TestChannelStore } from "./store";

const COOKIE_NAME = "bma_test_channel";
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;

export type TestChannelPersist = (
  message: InboundMessageToPersist,
) => Promise<PersistedInbound | null>;

export interface TestChannelOptions {
  /** Override the production/flag decision (tests only). */
  enabled?: boolean;
  rateLimitPerMinute?: number;
  store?: TestChannelStore;
  adminToken?: string;
  /** Test seam for the persistence failure path; production uses the shared webhook path. */
  persist?: TestChannelPersist;
}

/** Disabled in production unless TEST_CHANNEL is explicitly true. */
export function isTestChannelEnabled(config: { nodeEnv: string; enabled: boolean }): boolean {
  return config.nodeEnv !== "production" || config.enabled;
}

const codeSchema = z.object({ code: z.string().min(10).max(200) });

const sendSchema = z
  .object({
    text: z.string().min(1).max(4096).optional(),
    buttonId: z.string().min(1).max(200).optional(),
    listRowId: z.string().min(1).max(200).optional(),
    listRowTitle: z.string().max(200).optional(),
    contact: z
      .object({
        name: z.string().min(1).max(80),
        phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "expected E.164"),
      })
      .optional(),
    clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  })
  .refine(
    (value) =>
      (value.text !== undefined ? 1 : 0) +
        (value.buttonId !== undefined ? 1 : 0) +
        (value.listRowId !== undefined ? 1 : 0) +
        (value.contact !== undefined ? 1 : 0) ===
      1,
    { message: "send exactly one of text, buttonId, listRowId or contact" },
  );

const adminSchema = z.object({
  shopId: z.string().uuid(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "expected E.164"),
});

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function tokenMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionFrom(
  req: Request,
  store: TestChannelStore,
): { token: string; shopId: string; phone: string } | null {
  const token = cookieValue(req.headers.cookie, COOKIE_NAME);
  const session = store.getSession(token);
  if (!session || !token) return null;
  return { token, shopId: session.shopId, phone: session.phone };
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
    path: "/test-channel",
    maxAge: SESSION_TTL_MS,
  });
}

function inboundFromSend(
  phone: string,
  input: z.infer<typeof sendSchema>,
): { messageType: string; body: Record<string, unknown> } {
  if (input.text !== undefined) {
    return {
      messageType: "TEXT",
      body: { from: phone, type: "text", text: { body: input.text } },
    };
  }
  if (input.buttonId !== undefined) {
    return {
      messageType: "INTERACTIVE",
      body: {
        from: phone,
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: input.buttonId, title: "Button" },
        },
      },
    };
  }
  if (input.listRowId !== undefined) {
    return {
      messageType: "INTERACTIVE",
      body: {
        from: phone,
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: input.listRowId, title: input.listRowTitle ?? "Row" },
        },
      },
    };
  }
  const contact = input.contact!;
  return {
    messageType: "CONTACT",
    body: {
      from: phone,
      type: "contacts",
      contacts: [{ name: { formatted_name: contact.name }, phones: [{ phone: contact.phone }] }],
    },
  };
}

export function createTestChannelRouter(options: TestChannelOptions = {}): Router {
  const router = Router();
  const store = options.store ?? testChannelStore;
  const enabled =
    options.enabled ??
    isTestChannelEnabled({ nodeEnv: env.NODE_ENV, enabled: env.TEST_CHANNEL });
  const rateLimit = options.rateLimitPerMinute ?? env.TEST_CHANNEL_RATE_LIMIT_PER_MINUTE;
  const adminToken = options.adminToken ?? env.TEST_CHANNEL_ADMIN_TOKEN;
  const persist: TestChannelPersist =
    options.persist ??
    ((message) => withTransaction((client) => persistInboundMessage(client, message)));

  router.use((_req, _res, next) => {
    if (!enabled) {
      next(notFound("NOT_FOUND", "Route not found"));
      return;
    }
    next();
  });

  router.get("/", async (req, res, next) => {
    try {
      const session = sessionFrom(req, store);
      if (!session) {
        res.type("html").send(loginPage());
        return;
      }
      const shopName = await withTenant(
        { shopId: session.shopId, actorType: "USER", actorId: "test-channel" },
        async (db) =>
          (await db.queryOne<{ name: string }>(sql`SELECT name FROM app.shops WHERE id = ${session.shopId}`))
            ?.name ?? "Test shop",
      ).catch(() => "Test shop");
      res.type("html").send(chatPage(shopName, session.phone));
    } catch (error) {
      next(error);
    }
  });

  router.post("/session", (req, res, next) => {
    try {
      const input = codeSchema.parse(req.body);
      const redeemed = store.redeemCode(input.code);
      if (!redeemed) {
        next(unauthorized("INVALID_CODE", "That link has already been used or has expired."));
        return;
      }
      const session = store.createSession(redeemed.shopId, redeemed.phone, SESSION_TTL_MS);
      setSessionCookie(res, session.token);
      res.status(201).json({ ok: true, data: { shopId: session.shopId, phone: session.phone } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/messages", (req, res, next) => {
    try {
      const session = sessionFrom(req, store);
      if (!session) {
        next(unauthorized("NO_SESSION", "Open the one-time link first."));
        return;
      }
      const messages = simulatorStore.list({ to: session.phone, limit: 100 }).map((message) => ({
        id: message.id,
        kind: message.kind,
        body: message.body,
        ...(message.buttons ? { buttons: message.buttons } : {}),
        ...(message.rows ? { rows: message.rows } : {}),
        sentAt: message.sentAt.toISOString(),
        status: message.status,
      }));
      res.json({ ok: true, data: messages });
    } catch (error) {
      next(error);
    }
  });

  router.post("/messages", async (req, res, next) => {
    try {
      const session = sessionFrom(req, store);
      if (!session) {
        next(unauthorized("NO_SESSION", "Open the one-time link first."));
        return;
      }
      if (!store.allowSend(session.token, rateLimit, RATE_WINDOW_MS)) {
        next(tooManyRequests("RATE_LIMITED", "Too many messages. Wait a minute and try again."));
        return;
      }

      const input = sendSchema.parse(req.body);
      const { messageType, body } = inboundFromSend(session.phone, input);
      const waMessageId = `tc_${input.clientMessageId ?? randomUUID()}`;

      // Persist first. The 201 below is sent only after this transaction commits.
      const persisted = await persist({
        waMessageId,
        from: session.phone,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: messageType,
        body,
      });
      if (!persisted) {
        next(unprocessable("SELLER_NOT_FOUND", "That phone is not a seller in this shop."));
        return;
      }

      res.status(201).json({
        ok: true,
        data: { persisted: persisted.persisted, shopId: persisted.shopId, waMessageId },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/codes", async (req, res, next) => {
    try {
      if (!tokenMatches(req.header("x-test-channel-admin-token"), adminToken)) {
        next(unauthorized("ADMIN_TOKEN_REQUIRED", "A valid test-channel admin token is required."));
        return;
      }
      const input = adminSchema.parse(req.body);
      const bidx = phoneBlindIndex(input.phone, env.PHONE_BLIND_INDEX_KEY);
      const rows = await queryWithoutTenant<{ shop_id: string }>(
        sql`SELECT shop_id FROM app.resolve_seller_by_phone(${bidx})`,
      );
      if (rows[0]?.shop_id !== input.shopId) {
        next(notFound("SELLER_NOT_FOUND", "No seller with that phone belongs to that shop."));
        return;
      }

      const issued = store.issueCode(input.shopId, input.phone, CODE_TTL_MS);
      const base = env.APP_BASE_URL.replace(/\/+$/, "");
      res.status(201).json({
        ok: true,
        data: {
          code: issued.code,
          url: `${base}/test-channel/?code=${encodeURIComponent(issued.code)}`,
          expiresAt: new Date(issued.expiresAt).toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function loginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Test chat link</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="login">
    <h1>Test chat</h1>
    <p class="note">Paste the one-time link code your operator generated for this seller.</p>
    <form id="code-form">
      <input id="code" name="code" autocomplete="one-time-code" placeholder="One-time code" required />
      <button type="submit">Open chat</button>
    </form>
    <p id="error" class="error" role="alert"></p>
    <p class="note small">Local test channel only. No WhatsApp template, 24-hour window or status webhook is exercised here.</p>
  </main>
  <script>
    const form = document.getElementById('code-form');
    const code = document.getElementById('code');
    const error = document.getElementById('error');
    const fromUrl = new URLSearchParams(location.search).get('code');
    if (fromUrl) { code.value = fromUrl; }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const response = await fetch('/test-channel/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.value.trim() })
      });
      if (response.ok) { location.href = '/test-channel/'; return; }
      const payload = await response.json().catch(() => ({}));
      error.textContent = payload?.error?.message || 'That link is not valid.';
    });
    if (fromUrl) { form.requestSubmit(); }
  </script>
</body>
</html>`;
}

function chatPage(shopName: string, phone: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(shopName)} - test chat</title>
  <style>${BASE_CSS}${CHAT_CSS}</style>
</head>
<body>
  <main class="chat">
    <header>
      <div>
        <h1>${escapeHtml(shopName)}</h1>
        <p class="note small">${escapeHtml(phone)} · local simulator</p>
      </div>
      <span class="badge">TEST</span>
    </header>
    <section id="messages" class="messages" aria-live="polite"></section>
    <section class="composer">
      <label class="row">
        <input id="contact-name" placeholder="Contact name" maxlength="80" />
        <input id="contact-phone" placeholder="+919876543210" inputmode="tel" />
        <button type="button" id="contact-send">Share contact</button>
      </label>
      <label class="row voice">
        <input type="file" accept="audio/*" disabled />
        <span class="note small">Voice upload (coming later)</span>
      </label>
      <div class="row">
        <textarea id="text" rows="2" placeholder="Type a message"></textarea>
        <button type="button" id="send">Send</button>
      </div>
      <p id="error" class="error" role="alert"></p>
    </section>
  </main>
  <script>
    const messagesEl = document.getElementById('messages');
    const textEl = document.getElementById('text');
    const errorEl = document.getElementById('error');

    async function send(payload) {
      errorEl.textContent = '';
      const response = await fetch('/test-channel/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.status === 401) { location.href = '/test-channel/'; return; }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        errorEl.textContent = body?.error?.message || 'Could not send.';
        return;
      }
      await load();
    }

    function render(list) {
      messagesEl.textContent = '';
      for (const message of list) {
        const bubble = document.createElement('article');
        bubble.className = 'bubble ' + (message.status === 'READ' ? 'read' : '');
        const body = document.createElement('pre');
        body.textContent = message.body;
        bubble.appendChild(body);
        if (message.buttons) {
          const row = document.createElement('div');
          row.className = 'chips';
          for (const button of message.buttons) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = button.title;
            chip.addEventListener('click', () => send({ buttonId: button.id }));
            row.appendChild(chip);
          }
          bubble.appendChild(row);
        }
        if (message.rows) {
          const list = document.createElement('div');
          list.className = 'chips';
          for (const row of message.rows) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = row.title + (row.description ? ' - ' + row.description : '');
            chip.addEventListener('click', () => send({ listRowId: row.id, listRowTitle: row.title }));
            list.appendChild(chip);
          }
          bubble.appendChild(list);
        }
        messagesEl.appendChild(bubble);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function load() {
      const response = await fetch('/test-channel/messages');
      if (response.status === 401) { location.href = '/test-channel/'; return; }
      const payload = await response.json().catch(() => ({ data: [] }));
      render(payload.data || []);
    }

    document.getElementById('send').addEventListener('click', () => {
      const text = textEl.value.trim();
      if (!text) return;
      textEl.value = '';
      void send({ text });
    });
    textEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        document.getElementById('send').click();
      }
    });
    document.getElementById('contact-send').addEventListener('click', () => {
      const name = document.getElementById('contact-name').value.trim();
      const contactPhone = document.getElementById('contact-phone').value.trim();
      if (!name || !contactPhone) {
        errorEl.textContent = 'Contact name and phone are both required.';
        return;
      }
      void send({ contact: { name, phone: contactPhone } });
    });

    void load();
    setInterval(() => { void load(); }, 2000);
  </script>
</body>
</html>`;
}

const BASE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #e9ecef; color: #1c1c1c; }
  h1 { font-size: 1.05rem; margin: 0; }
  .note { color: #5f6368; }
  .small { font-size: .78rem; }
  .error { color: #b00020; min-height: 1.1rem; font-size: .85rem; }
  .login { max-width: 360px; margin: 12vh auto; background: #fff; padding: 1.25rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.12); }
  .login form { display: flex; gap: .5rem; margin: 1rem 0; }
  .login input { flex: 1; padding: .7rem; border: 1px solid #c7c7c7; border-radius: 8px; }
  button { border: 0; border-radius: 8px; padding: .65rem .9rem; background: #128c7e; color: #fff; font: inherit; cursor: pointer; }
  button:disabled { background: #9aa0a6; cursor: not-allowed; }
  .chat { max-width: 480px; height: 100dvh; margin: 0 auto; display: flex; flex-direction: column; background: #efeae2; }
  .chat header { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; background: #075e54; color: #fff; }
  .chat header .note { color: #d7f0eb; margin: .2rem 0 0; }
  .badge { background: #fff; color: #075e54; border-radius: 999px; font-size: .7rem; font-weight: 700; padding: .2rem .5rem; }
  .messages { flex: 1; overflow-y: auto; padding: .8rem; display: flex; flex-direction: column; gap: .5rem; }
  .bubble { background: #fff; border-radius: 10px; padding: .55rem .65rem; max-width: 92%; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
  .bubble.read { background: #d9fdd3; }
  .bubble pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .chips { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .45rem; }
  .chip { background: #e7f5f2; color: #075e54; border: 1px solid #b6ddd6; padding: .35rem .55rem; font-size: .82rem; }
  .composer { background: #f7f7f5; padding: .6rem; border-top: 1px solid #d7d7d7; }
  .row { display: flex; gap: .45rem; align-items: center; margin-bottom: .45rem; }
  .row input, .row textarea { flex: 1; padding: .55rem .6rem; border: 1px solid #c7c7c7; border-radius: 8px; font: inherit; background: #fff; }
  .row textarea { resize: none; }
  .row button { white-space: nowrap; }
  .voice { color: #5f6368; }
  .voice input { flex: 0 0 auto; }
`;

const CHAT_CSS = `
  body { background: #d1d7db; }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
