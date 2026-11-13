import type { RequestHandler } from "express";
import { getRequestId } from "./requestId";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: getRequestId(res),
    },
  });
};
