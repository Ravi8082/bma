import { readFileSync } from "node:fs";
import path from "node:path";
import { deterministicParser } from "../whatsapp/parser";
import { LlmExtractionParser, StubLlmProvider } from "../whatsapp/extraction";

interface Case {
  id: string;
  lang: string;
  text: string;
  expected: { customerName: string; amountPaise: number; entryType: string } | null;
}

async function run(cases: Case[], useLlm: boolean): Promise<{ total: number; correct: number; clarification: number; wrongAmount: number }> {
  let correct = 0;
  let clarification = 0;
  let wrongAmount = 0;
  const stub = new StubLlmProvider();
  const parser = useLlm
    ? new LlmExtractionParser(stub, "eval-shop", { isOpen: () => false, recordFailure: () => {}, recordSuccess: () => {} }, 1000, { callsToday: 0 })
    : null;

  for (const c of cases) {
    let result: ReturnType<typeof deterministicParser.parse> = null;
    if (parser && typeof parser.parseAsync === "function") {
      result = await parser.parseAsync(c.text, { maxAmountPaise: 100_000_000_000 });
    } else {
      result = deterministicParser.parse(c.text, { maxAmountPaise: 100_000_000_000 });
    }
    const isClarification = result === null && c.expected !== null && c.text.includes(",");
    if (isClarification) clarification += 1;
    if (c.expected === null) {
      if (result === null) correct += 1;
      continue;
    }
    if (result && result.customerName === c.expected.customerName && result.amountPaise === c.expected.amountPaise && result.entryType === c.expected.entryType) {
      correct += 1;
    } else if (result && result.amountPaise !== c.expected.amountPaise) {
      wrongAmount += 1;
    } else if (result === null) {
      clarification += 1;
    }
  }
  return { total: cases.length, correct, clarification, wrongAmount };
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? "src/eval/cases.json";
  const cases = JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8")) as Case[];
  const det = await run(cases, false);
  console.log("=== Deterministic parser ===");
  console.log(`total: ${det.total}`);
  console.log(`correct: ${det.correct} (${((det.correct / det.total) * 100).toFixed(1)}%)`);
  console.log(`clarification: ${det.clarification} (${((det.clarification / det.total) * 100).toFixed(1)}%)`);
  console.log(`wrong amount without clarification: ${det.wrongAmount}`);
  console.log("");
  const llm = await run(cases, true);
  console.log("=== LLM (stub) parser ===");
  console.log(`total: ${llm.total}`);
  console.log(`correct: ${llm.correct} (${((llm.correct / llm.total) * 100).toFixed(1)}%)`);
  console.log(`clarification: ${llm.clarification} (${((llm.clarification / llm.total) * 100).toFixed(1)}%)`);
  console.log(`wrong amount without clarification: ${llm.wrongAmount}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
