import pino from "pino";
import { env, isProduction } from "./env";

/**
 * Phone numbers, tokens, OTP codes and transcripts must never reach logs.
 * Pino redaction is the last line of defence; call sites still avoid logging them.
 */
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-hub-signature-256']",
  "*.password",
  "*.passwordHash",
  "*.code",
  "*.otp",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.transcript",
  "*.phoneE164",
  "*.whatsappAccessToken",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: { service: "business-memory-ai" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }),
});

export type Logger = typeof logger;
