import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    APP_BASE_URL: z.string().url().default("http://localhost:4000"),
    DASHBOARD_ORIGIN: z.string().default("http://localhost:5173"),

    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://bma_app:dev-app-password@localhost:5432/business_memory"),
    MIGRATION_DATABASE_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    DB_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),

    REDIS_URL: z.string().default("redis://localhost:6379"),
    QUEUE_DRIVER: z.enum(["inline", "bullmq"]).default("inline"),

    JWT_SECRET_CURRENT: z.string().min(1).default("dev-only-change-me-32-bytes-minimum-secret"),
    ACCESS_TOKEN_TTL: z.string().default("12m"),
    REFRESH_TOKEN_TTL: z.string().default("30d"),
    COOKIE_SECURE: z.preprocess(emptyToUndefined, booleanString.default("false")),
    CSRF_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().default("dev-only-csrf-secret-32-bytes-minimum"),
    ),

    OTP_PEPPER: z.preprocess(
      emptyToUndefined,
      z.string().default("dev-only-otp-pepper-32-bytes-minimum"),
    ),
    PHONE_BLIND_INDEX_KEY: z.preprocess(
      emptyToUndefined,
      z.string().default("dev-only-blind-index-key-32-bytes"),
    ),
    FIELD_ENCRYPTION_KEY_REF: z.preprocess(
      emptyToUndefined,
      z.string().default("dev-local-kms-key"),
    ),

    MESSAGING_PROVIDER: z.enum(["simulator", "meta"]).default("simulator"),
    WHATSAPP_VERIFY_TOKEN: z.string().default("dev-verify-token"),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com/v21.0"),

    LLM_PROVIDER: z.enum(["stub", "openai"]).default("stub"),
    LLM_API_KEY: z.string().optional(),
    /** Conservative per-call paise cost recorded for the free-pilot budget. */
    LLM_COST_PAISE_PER_CALL: z.coerce.number().int().min(0).default(25),
    STT_PROVIDER: z.enum(["stub", "whisper"]).default("stub"),
    STT_API_KEY: z.string().optional(),

    /** Free-pilot ceilings. Never converted into a payment request. */
    PILOT_DAILY_CAP_PAISE: z.coerce.number().int().positive().default(5_000),
    PILOT_MONTHLY_CAP_PAISE: z.coerce.number().int().positive().default(50_000),

    /** Local web chat test channel. Off in production unless explicitly enabled. */
    TEST_CHANNEL: z.preprocess(emptyToUndefined, booleanString.default("false")),
    TEST_CHANNEL_ADMIN_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    TEST_CHANNEL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),

    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./.data/media"),

    DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),
    DRAFT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    MAX_ENTRY_PAISE: z.coerce.number().int().positive().default(100_000_000_000),
    UNDO_EXTRA_CONFIRM_AGE_MS: z.coerce.number().int().positive().default(86_400_000),
    UNDO_EXTRA_CONFIRM_AMOUNT_PAISE: z.coerce.number().int().positive().default(1_000_000),

    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== "production") return;

    if (value.MESSAGING_PROVIDER !== "meta") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MESSAGING_PROVIDER"],
        message: "production requires MESSAGING_PROVIDER=meta; the simulator is disabled",
      });
    }
    if (value.QUEUE_DRIVER !== "bullmq") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["QUEUE_DRIVER"],
        message: "production requires QUEUE_DRIVER=bullmq for durable jobs and cross-instance locking",
      });
    }
    if (!value.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECURE"],
        message: "production requires COOKIE_SECURE=true",
      });
    }
    if (value.JWT_SECRET_CURRENT.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET_CURRENT"],
        message: "JWT_SECRET_CURRENT must be at least 32 characters in production",
      });
    }
    if (value.DB_SSL_MODE !== "verify-full") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DB_SSL_MODE"],
        message: "production requires DB_SSL_MODE=verify-full (TLS with a verified certificate)",
      });
    }
    if (/sslmode=(disable|prefer|allow)\b/.test(value.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "production DATABASE_URL must use sslmode=verify-full",
      });
    }
    if (value.OTP_PEPPER.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OTP_PEPPER"],
        message: "OTP_PEPPER must be at least 32 characters and come from the secret manager",
      });
    }
    if (value.PHONE_BLIND_INDEX_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PHONE_BLIND_INDEX_KEY"],
        message: "PHONE_BLIND_INDEX_KEY must be at least 32 characters and come from the secret manager",
      });
    }
    if (value.CSRF_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CSRF_SECRET"],
        message: "CSRF_SECRET must be at least 32 characters",
      });
    }
    if (value.FIELD_ENCRYPTION_KEY_REF === "dev-local-kms-key") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FIELD_ENCRYPTION_KEY_REF"],
        message: "FIELD_ENCRYPTION_KEY_REF must be a KMS key reference in production, not the default local key",
      });
    }
    if (value.TEST_CHANNEL && (!value.TEST_CHANNEL_ADMIN_TOKEN || value.TEST_CHANNEL_ADMIN_TOKEN.length < 24)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TEST_CHANNEL_ADMIN_TOKEN"],
        message: "TEST_CHANNEL requires TEST_CHANNEL_ADMIN_TOKEN of at least 24 characters in production",
      });
    }
    if (!value.WHATSAPP_APP_SECRET || !value.WHATSAPP_ACCESS_TOKEN || !value.WHATSAPP_PHONE_NUMBER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_APP_SECRET"],
        message:
          "production requires WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID",
      });
    }
    try {
      const graphUrl = new URL(value.WHATSAPP_GRAPH_BASE_URL);
      if (graphUrl.protocol !== "https:" || graphUrl.hostname !== "graph.facebook.com") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WHATSAPP_GRAPH_BASE_URL"],
          message: "production requires WHATSAPP_GRAPH_BASE_URL to be https://graph.facebook.com/...",
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_GRAPH_BASE_URL"],
        message: "WHATSAPP_GRAPH_BASE_URL must be a valid URL",
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** Validated once at import. A misconfigured process fails before it serves traffic. */
export const env: AppEnv = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
