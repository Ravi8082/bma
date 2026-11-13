import { Router } from "express";
import { z } from "zod";
import { isProduction } from "../config/env";
import { messaging, simulatorStore } from "../container";
import { notFound } from "../errors/AppError";

const sendSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{7,14}$/, "expected E.164, e.g. +919876543210"),
  text: z.string().min(1).max(4096),
});

const mediaSchema = z.object({
  mediaId: z.string().min(1).max(128),
  mimeType: z.string().min(3).max(100),
  base64: z.string().min(1),
  fileName: z.string().max(200).optional(),
});

const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export function createSimulatorRouter(): Router {
  const router = Router();

  // Defence in depth: the router is not mounted in production, and it also
  // refuses to serve if that mount decision ever changes.
  router.use((_req, _res, next) => {
    if (isProduction) {
      next(notFound("NOT_FOUND", "Route not found"));
      return;
    }
    next();
  });

  router.get("/outbox", (req, res) => {
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const messages = simulatorStore.list(to ? { to } : {});
    res.json({ ok: true, data: messages });
  });

  router.post("/send", async (req, res, next) => {
    try {
      const input = sendSchema.parse(req.body);
      const result = await messaging.sendText({ to: input.to, text: input.text });
      res.status(201).json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/media", (req, res, next) => {
    try {
      const input = mediaSchema.parse(req.body);
      const data = Buffer.from(input.base64, "base64");
      if (data.byteLength === 0) {
        throw new Error("decoded media is empty");
      }
      if (data.byteLength > MAX_MEDIA_BYTES) {
        throw new Error("decoded media exceeds 16 MB");
      }
      simulatorStore.registerMedia(input.mediaId, {
        data,
        mimeType: input.mimeType,
        ...(input.fileName ? { fileName: input.fileName } : {}),
      });
      res.status(201).json({ ok: true, data: { mediaId: input.mediaId, bytes: data.byteLength } });
    } catch (error) {
      next(error);
    }
  });

  router.post("/reset", (_req, res) => {
    simulatorStore.reset();
    res.json({ ok: true, data: { reset: true } });
  });

  router.get("/", (_req, res) => {
    const messages = simulatorStore.list({ limit: 200 });
    const rows = messages
      .map(
        (message) => `
        <tr>
          <td><code>${escapeHtml(message.to)}</code></td>
          <td>${escapeHtml(message.kind)}</td>
          <td><pre>${escapeHtml(message.body)}</pre></td>
          <td>${message.sentAt.toISOString()}</td>
          <td>${message.status}</td>
        </tr>`,
      )
      .join("");

    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp simulator</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f6f6f4; color: #1c1c1c; }
    h1 { font-size: 1.25rem; }
    .note { color: #555; font-size: .875rem; margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #e5e5e5; vertical-align: top; font-size: .85rem; }
    th { background: #efece4; }
    pre { margin: 0; white-space: pre-wrap; font-family: inherit; }
    .empty { padding: 2rem; text-align: center; color: #777; background: #fff; }
  </style>
</head>
<body>
  <h1>WhatsApp simulator inbox</h1>
  <p class="note">Messages recorded by the local provider. Nothing here was sent to Meta.</p>
  ${
    messages.length === 0
      ? `<div class="empty">No outbound messages yet. Try <code>POST /simulator/send</code>.</div>`
      : `<table><thead><tr><th>To</th><th>Kind</th><th>Body</th><th>Sent</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
  }
</body>
</html>`);
  });

  return router;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
