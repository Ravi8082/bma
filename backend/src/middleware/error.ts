import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError";
import { TenantContextError } from "../db/tenant";
import { logger } from "../config/logger";
import { getRequestId } from "./requestId";

interface ErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    messageKey?: string;
    details?: unknown;
    requestId: string;
  };
}

function body(
  code: string,
  message: string,
  requestId: string,
  extra: { messageKey?: string; details?: unknown } = {},
): ErrorBody {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId,
      ...(extra.messageKey === undefined ? {} : { messageKey: extra.messageKey }),
      ...(extra.details === undefined ? {} : { details: extra.details }),
    },
  };
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const requestId = getRequestId(res);

  if (error instanceof AppError) {
    res.status(error.status).json(
      body(error.code, error.message, requestId, {
        ...(error.messageKey === undefined ? {} : { messageKey: error.messageKey }),
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
    );
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json(
      body("VALIDATION_ERROR", "Request validation failed", requestId, {
        messageKey: "error.validation",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      }),
    );
    return;
  }

  if (error instanceof TenantContextError) {
    // Reaching this means a tenant-scoped transaction could not be established. It is a
    // programming or misconfiguration error; never expose the internal reason to the client.
    logger.error({ err: error }, "tenant context error");
    res.status(500).json(
      body("TENANT_SCOPE_REQUIRED", "Tenant context could not be established", requestId, {
        messageKey: "error.internal",
      }),
    );
    return;
  }

  logger.error({ err: error }, "unhandled error");
  res.status(500).json(
    body("INTERNAL_ERROR", "Something went wrong on our side", requestId, {
      messageKey: "error.internal",
    }),
  );
};
