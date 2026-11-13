import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (value === "" ? undefined : value);

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    APP_BASE_URL: z.string().url().default("http://localhost:4000"),
    DASHBOARD_ORIGIN: z.string().default("http://localhost:5173"),

    MONGODB_URI: z
      .string()
      .min(1)
      .default("mongodb://localhost:27017/business_memory?replicaSet=rs0"),
    MONGODB_DB_NAME: z.string().default("business_memory"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    QUEUE_DRIVER: z.enum(["inline", "bullmq"]).default("inline"),

    JWT_SECRET_CURRENT: z.string().min(1).default("dev-only-change-me-32-bytes-minimum-secret"),
    ACCESS_TOKEN_TTL: z.string().default("15m"),
    REFRESH_TOKEN_TTL: z.string().default("30d"),
    COOKIE_SECURE: z.preprocess(emptyToUndefined, booleanString.default("false")),

    MESSAGING_PROVIDER: z.enum(["simulator", "meta"]).default("simulator"),
    WHATSAPP_VERIFY_TOKEN: z.string().default("dev-verify-token"),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),

    LLM_PROVIDER: z.enum(["stub", "openai"]).default("stub"),
    LLM_API_KEY: z.string().optional(),
    STT_PROVIDER: z.enum(["stub", "whisper"]).default("stub"),
    STT_API_KEY: z.string().optional(),

    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./.data/media"),

    DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),
    DRAFT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    MAX_ENTRY_PAISE: z.coerce.number().int().positive().default(100_000_000_000),

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
    if (!value.WHATSAPP_APP_SECRET || !value.WHATSAPP_ACCESS_TOKEN || !value.WHATSAPP_PHONE_NUMBER_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WHATSAPP_APP_SECRET"],
        message:
          "production requires WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID",
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
