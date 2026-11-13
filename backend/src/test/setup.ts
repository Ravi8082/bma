/**
 * Runs before every test file. Keeps the environment deterministic and quiet;
 * it does NOT touch the database (tests opt in with useMongoReplSet()).
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MESSAGING_PROVIDER = "simulator";
process.env.QUEUE_DRIVER = "inline";
process.env.JWT_SECRET_CURRENT = "test-secret-test-secret-test-secret-32";
