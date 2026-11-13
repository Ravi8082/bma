import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** Propagate a caller's request id when it is safe, otherwise mint one. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};

export function getRequestId(res: { locals: Record<string, unknown> }): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
}
