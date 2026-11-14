import { readFileSync } from "node:fs";
import path from "node:path";
import { deterministicParser } from "../whatsapp/parser";

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

export interface ParsedLike {
  customerName?: string | null;
  amountPaise?: number | null;
  entryType?: string | null;
  direction?: string | null;
  isCreditSale?: boolean | null;
  typeUnclear?: boolean | null;
}

interface Result { case: Case; outcome: Outcome; parsed: ParsedLike | null }

export function classify(c: Case, parsed: ParsedLike | null, isClarificationResult: boolean): Outcome {
  // A case with expectClarification counts as correct ONLY if the parser returned
  // NEEDS_CLARIFICATION. A parser result on such a case is a FAILURE.
  if (c.expectClarification) {
    if (isClarificationResult) return "correct";
    // parser returned a result without flagging ambiguity -> failure
    if (parsed && c.expected && parsed.amountPaise !== c.expected.amountPaise) return "wrong_amount_no_clarification";
    if (parsed && c.expected && parsed.entryType !== c.expected.entryType) return "wrong_type";
    if (parsed && c.expected && parsed.customerName !== c.expected.customerName) return "wrong_customer";
    return "other";
  }
  if (c.expected === null) {
    // Unparseable: a NOT_AN_ENTRY (help reply) is correct.
    if (parsed === null) return "correct";
    return "other";
  }
  if (parsed === null) {
    return c.text.trim().toLowerCase() === "hello" ? "extraction_failed" : "clarification";
  }
  if (parsed.customerName !== c.expected.customerName) return "wrong_customer";
  if (parsed.entryType !== c.expected.entryType) return "wrong_type";
  if (parsed.amountPaise !== c.expected.amountPaise) return "wrong_amount_no_clarification";
  return "correct";
}

function run(cases: Case[]): { results: Result[]; summary: Record<Outcome, number> } {
  const summary: Record<Outcome, number> = {
    correct: 0, clarification: 0, extraction_failed: 0, wrong_customer: 0,
    wrong_type: 0, wrong_amount_no_clarification: 0, other: 0,
  };
  const results: Result[] = [];
  for (const c of cases) {
    const parsedResult = deterministicParser.parse(c.text, { maxAmountPaise: 100_000_000_000 });
    const parsed = parsedResult.kind === "PARSED" ? parsedResult.entry : null;
    const isClarification = parsedResult.kind === "NEEDS_CLARIFICATION";
    const outcome = classify(c, parsed, isClarification);
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
  const sum = Object.values(summary).reduce((a, b) => a + b, 0);
  if (sum !== cases.length) {
    console.error(`CHECK FAILED: category sum ${sum} != total ${cases.length}`);
    process.exit(1);
  }
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

/**
 * Self-test for the eval classifier: feed it deliberately wrong parser outputs and assert
 * that it flags each one (wrong_customer / wrong_type / wrong_amount_no_clarification).
 * Guards against the classifier drifting into always-passing behaviour.
 */
export function runClassifierSelfTest(): void {
  const selfCases: Case[] = [
    { id: "self-1", lang: "en", text: "Ramesh paune teen sau udhaar", expected: { customerName: "Ramesh", amountPaise: 27500, entryType: "SALE" }, holdout: true, synthetic: true, hard: true, expectClarification: false },
    { id: "self-2", lang: "en", text: "Ramesh ne 1234 diya", expected: { customerName: "Ramesh", amountPaise: 123400, entryType: "PAYMENT_IN" }, holdout: true, synthetic: true, hard: true, expectClarification: false },
    { id: "self-3", lang: "en", text: "Ramesh 300 udhaar", expected: { customerName: "Ramesh", amountPaise: 30000, entryType: "SALE" }, holdout: true, synthetic: true, hard: true, expectClarification: false },
  ];
  // Deliberately wrong parser outputs the classifier MUST flag.
  const wrongOutputs: Array<{ caseId: string; parsed: ParsedLike; expectedOutcome: Outcome }> = [
    { caseId: "self-1", parsed: { customerName: "Ramesh", amountPaise: 75, entryType: "SALE", direction: "DEBIT", isCreditSale: true, typeUnclear: false }, expectedOutcome: "wrong_amount_no_clarification" },
    { caseId: "self-2", parsed: { customerName: "Ramesh", amountPaise: 123400, entryType: "SALE", direction: "DEBIT", isCreditSale: true, typeUnclear: false }, expectedOutcome: "wrong_type" },
    { caseId: "self-3", parsed: { customerName: "Mahesh", amountPaise: 30000, entryType: "SALE", direction: "DEBIT", isCreditSale: true, typeUnclear: false }, expectedOutcome: "wrong_customer" },
  ];
  let failures = 0;
  for (const w of wrongOutputs) {
    const c = selfCases.find((x) => x.id === w.caseId)!;
    const outcome = classify(c, w.parsed, false);
    const ok = outcome === w.expectedOutcome;
    if (!ok) failures += 1;
    console.log(`self-test ${w.caseId}: "${c.text}" with deliberately wrong parser output -> ${outcome} (expected ${w.expectedOutcome}) ${ok ? "OK" : "FAIL"}`);
  }
  if (failures > 0) {
    console.error(`SELF-TEST FAILED: ${failures} of ${wrongOutputs.length} deliberately-wrong parser outputs were not flagged.`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: all ${wrongOutputs.length} deliberately-wrong parser outputs were correctly flagged.`);
}

function main(): void {
  if (process.argv.includes("--self-test")) {
    runClassifierSelfTest();
    return;
  }
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
