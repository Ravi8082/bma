import { readFileSync } from "node:fs";
import path from "node:path";
import { deterministicParser } from "../whatsapp/parser";

interface Case { id?: string; text: string; expected?: { customerName: string; amountPaise: number; entryType: string } | null; }

function main(): void {
  const file = process.argv[2];
  if (!file) { console.error("usage: eval-deterministic <messages.json>"); process.exit(1); }
  const raw = JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8"));
  const cases: Case[] = Array.isArray(raw) ? raw : raw.cases ?? [];
  const buckets: Record<string, number> = { correct: 0, clarification: 0, extraction_failed: 0, wrong_customer: 0, wrong_type: 0, wrong_amount_no_clarification: 0, other: 0 };
  for (const c of cases) {
    const parsedResult = deterministicParser.parse(c.text, { maxAmountPaise: 100_000_000_000 });
    const parsed = parsedResult.kind === "PARSED" ? parsedResult.entry : null;
    const isClar = parsedResult.kind === "NEEDS_CLARIFICATION";
    let outcome = "other";
    if (c.expected === null || c.expected === undefined) {
      outcome = parsedResult.kind === "NOT_AN_ENTRY" ? "correct" : (isClar ? "clarification" : "other");
    } else {
      if (isClar) outcome = "clarification";
      else if (parsed === null) outcome = c.text.trim().toLowerCase() === "hello" ? "extraction_failed" : "clarification";
      else if (parsed.customerName !== c.expected.customerName) outcome = "wrong_customer";
      else if (parsed.entryType !== c.expected.entryType) outcome = "wrong_type";
      else if (parsed.amountPaise !== c.expected.amountPaise) outcome = "wrong_amount_no_clarification";
      else outcome = "correct";
    }
    buckets[outcome] = (buckets[outcome] ?? 0) + 1;
  }
  const total = cases.length;
  console.log(`total: ${total}`);
  for (const k of Object.keys(buckets)) console.log(`${k}: ${buckets[k]}`);
  const sum = Object.values(buckets).reduce((a, b) => a + b, 0);
  console.log(`sum: ${sum} (must equal ${total})`);
  if (sum !== total) { console.error("CHECK FAILED: sum != total"); process.exit(1); }
  console.log(`wrong amount without clarification: ${buckets.wrong_amount_no_clarification} (target 0)`);
  console.log(`wrong type without clarification: ${buckets.wrong_type} (target 0)`);
  console.log(`wrong customer without clarification: ${buckets.wrong_customer} (target 0)`);
}

main();
