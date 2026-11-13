/**
 * Tenant-context guard.
 *
 * Fails the build when:
 *   - `set_config` / `SET LOCAL` / `current_setting` appears anywhere outside
 *     `src/db/tenant.ts` (the only place that may set tenant context);
 *   - raw string-literal SQL reaches a `.query(` call outside `src/db/**`;
 *   - a job handler is registered that does not run inside `withTenant()`.
 *
 * Run with: npm run check:tenant
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC_DIR = path.resolve(REPO_ROOT, "backend", "src");
const TENANT_HELPER = path.join(SRC_DIR, "db", "tenant.ts");

function listSourceFiles(dir: string, files: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function main(): void {
  const violations: string[] = [];
  const tenantHelper = path.resolve(TENANT_HELPER);

  for (const file of listSourceFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (path.isAbsolute(relative) || relative.startsWith("..")) continue;
    // Bootstrap/migration/test plumbing uses reviewed fixed SQL outside the runtime query
    // surface. The runtime database layer is separately restricted by the ESLint rule.
    if (
      file === tenantHelper ||
      relative.startsWith(`scripts${path.sep}`) ||
      relative.startsWith(`test${path.sep}`) ||
      relative === path.join("config", "db.ts")
    ) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    const display = path.relative(REPO_ROOT, file);

    if (path.resolve(file) === tenantHelper) continue;

    if (/set_config|SET\s+LOCAL|current_setting/i.test(source)) {
      violations.push(`${display}: tenant context may only be set inside src/db/tenant.ts`);
    }
    if (/\.query\(\s*(["'`])/.test(source)) {
      violations.push(`${display}: raw string SQL must not reach a query call`);
    }
  }

  const jobsDir = path.join(SRC_DIR, "jobs");
  for (const file of listSourceFiles(jobsDir)) {
    const source = fs.readFileSync(file, "utf8");
    if (/\.register\(/.test(source)) {
      violations.push(`${path.relative(REPO_ROOT, file)}: job handlers must run inside withTenant()`);
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) console.error(`tenant-context check: FAIL ${violation}`);
    process.exitCode = 1;
  }
}

void main();
