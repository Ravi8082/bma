/**
 * Runs before every test file. Keeps the environment deterministic and quiet;
 * it does NOT touch the database (tests opt in with usePostgres()).
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MESSAGING_PROVIDER = "simulator";
process.env.QUEUE_DRIVER = "inline";
process.env.JWT_SECRET_CURRENT = "test-secret-test-secret-test-secret-32";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://bma_app:dev-app-password@localhost:5432/business_memory";
process.env.BMA_APP_PASSWORD = process.env.BMA_APP_PASSWORD ?? "dev-app-password";
process.env.BMA_MIGRATOR_PASSWORD = process.env.BMA_MIGRATOR_PASSWORD ?? "dev-migrator-password";
process.env.BMA_REPORTING_PASSWORD = process.env.BMA_REPORTING_PASSWORD ?? "dev-reporting-password";
process.env.OTP_PEPPER = process.env.OTP_PEPPER ?? "dev-only-otp-pepper-32-bytes-minimum";
process.env.CSRF_SECRET = process.env.CSRF_SECRET ?? "dev-only-csrf-secret-32-bytes-minimum";
process.env.PHONE_BLIND_INDEX_KEY = process.env.PHONE_BLIND_INDEX_KEY ?? "dev-only-blind-index-key-32-bytes";
process.env.FIELD_ENCRYPTION_KEY_REF = process.env.FIELD_ENCRYPTION_KEY_REF ?? "dev-local-kms-key";
