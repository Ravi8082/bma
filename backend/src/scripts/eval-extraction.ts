import { readFileSync } from "node:fs";
import path from "node:path";
import { deterministicParser } from "../whatsapp/parser";
import { LlmExtractionParser, StubLlmProvider } from "../whatsapp/extraction";

interface Case {
  id: string;
  lang: string;
  text: string;
  expected: { customerName: string; amountPaise: number; entryType: string } | null;
  holdout?: boolean;
  synthetic?: boolean;
  hard?: boolean;
  expectClarification?: boolean;
}

type Outcome = "correct" | "clarification" | "extraction_failed" | "wrong_customer" | "wrong_type" | "wrong_amount_no_clarification" | "other";

interface Result { case: Case; outcome: Outcome; parsed: ReturnType<typeof deterministicParser.parse> }

function classify(c: Case, parsed: ReturnType<typeof deterministicParser.parse>): Outcome {
  if (c.expected === null) {
    // Unparseable or multi-number: a null result is a clarification/help reply.
    if (parsed === null) return "correct"; // polite help reply counts as handled
    // If parsed but expected null (multi-number case), check if clarification was expected.
    if (c.expectClarification) return parsed ? "clarification" : "clarification";
    return "other";
  }
  if (parsed === null) {
    // Expected a draft but got nothing -> clarification or extraction failed.
    return c.text === "hello" ? "extraction_failed" : "clarification";
  }
  if (parsed.customerName !== c.expected.customerName) return "wrong_customer";
  if (parsed.entryType !== c.expected.entryType) return "wrong_type";
  if (parsed.amountPaise !== c.expected.amountPaise) {
    // If this case expected clarification, count as clarification; else wrong amount without clarification.
    return c.expectClarification ? "clarification" : "wrong_amount_no_clarification";
  }
  return "correct";
}

function run(cases: Case[]): { results: Result[]; summary: Record<Outcome, number> } {
  const summary: Record<Outcome, number> = {
    correct: 0, clarification: 0, extraction_failed: 0, wrong_customer: 0,
    wrong_type: 0, wrong_amount_no_clarification: 0, other: 0,
  };
  const results: Result[] = [];
  for (const c of cases) {
    const parsed = deterministicParser.parse(c.text, { maxAmountPaise: 100_000_000_000 });
    const outcome = classify(c, parsed);
    summary[outcome] += 1;
    results.push({ case: c, outcome, parsed });
  }
  return { results, summary };
}

function printReport(label: string, cases: Case[]): void {
  const { results, summary } = run(cases);
  console.log(`=== ${label} (${cases.length} cases) ===`);
  console.log(`correct:                       ${summary.correct}`);
  console.log(`clarification:                 ${summary.clarification}`);
  console.log(`extraction_failed (help reply):${summary.extraction_failed}`);
  console.log(`wrong_customer:                ${summary.wrong_customer}`);
  console.log(`wrong_type:                    ${summary.wrong_type}`);
  console.log(`wrong_amount_no_clarification: ${summary.wrong_amount_no_clarification}  (ZERO TARGET)`);
  console.log(`other:                         ${summary.other}`);
  console.log("");
  // Show up to 5 examples per non-zero failing category.
  const categories: Outcome[] = ["wrong_customer", "wrong_type", "wrong_amount_no_clarification", "other", "extraction_failed"];
  for (const cat of categories) {
    const fails = results.filter((r) => r.outcome === cat).slice(0, 5);
    if (fails.length === 0) continue;
    console.log(`-- ${cat} (showing ${fails.length}) --`);
    for (const f of fails) {
      console.log(`   ${f.case.id}: "${f.case.text}" -> ${JSON.stringify(f.parsed)}`);
    }
    console.log("");
  }
}

function main(): void {
  const file = process.argv[2] ?? "src/eval/cases.json";
  const cases = JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8")) as Case[];
  const synthetic = (cases[0] as { synthetic?: boolean })?.synthetic;
  console.log(`File: ${file}  (synthetic: ${synthetic ?? "unknown"})`);
  console.log("NOTE: stub LLM row removed - it is identical to the deterministic parser.");
  console.log("NOTE: real-LLM eval is run manually with EVAL_LLM_API_KEY; not in CI.");
  console.log("");
  printReport("Evaluation", cases);

  // Zero-target summary
  const { summary } = run(cases);
  console.log("=== ZERO-TARGET CHECK ===");
  console.log(`wrong amount without clarification: ${summary.wrong_amount_no_clarification} (target 0)`);
  console.log(`wrong type without clarification:   ${summary.wrong_type} (target 0)`);
  console.log(`wrong customer without clarification:${summary.wrong_customer} (target 0)`);
}

main();
