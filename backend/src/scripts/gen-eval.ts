import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface Case {
  id: string;
  lang: "hi" | "en" | "hinglish";
  text: string;
  expected: { customerName: string; amountPaise: number; entryType: string } | null;
  holdout: boolean;
  synthetic: boolean;
  hard: boolean;
  expectClarification: boolean;
}

const names = ["Ramesh", "Suresh", "Mahesh", "Rajesh", "Dinesh", "Priya", "Sunita", "Anita"];
const amounts = [100, 150, 200, 300, 450, 500, 750, 1000, 1234, 2500];

function makeCase(i: number, lang: "hi" | "en" | "hinglish", holdout: boolean, hard: boolean): Case {
  const name = names[i % names.length]!;
  const amount = amounts[i % amounts.length]!;
  const paise = amount * 100;

  if (hard) {
    const hardCases: Array<{ text: string; expected: Case["expected"]; expectClarification: boolean }> = [
      { text: `${name} ${amount} udhaar, 50 wapas aaye`, expected: null, expectClarification: true },
      { text: `${name} dedh sau udhaar`, expected: { customerName: name, amountPaise: 15000, entryType: "SALE" }, expectClarification: false },
      { text: `${name} paune teen sau udhaar`, expected: { customerName: name, amountPaise: 27500, entryType: "SALE" }, expectClarification: false },
      { text: `${name} ३०० udhaar`, expected: { customerName: name, amountPaise: 30000, entryType: "SALE" }, expectClarification: false },
      { text: `${name} 1,23,456 udhaar`, expected: { customerName: name, amountPaise: 12345600, entryType: "SALE" }, expectClarification: false },
      { text: `Ramesh ${amount} udhaar, Suresh 200 udhaar`, expected: null, expectClarification: true },
      { text: `${name} ${amount} udhaar Ramesh`, expected: null, expectClarification: true },
      { text: "hello", expected: null, expectClarification: false },
      { text: `${name} paid ${amount} and ${amount + 50} udhaar`, expected: null, expectClarification: true },
      { text: `${name} ${amount} ka maal`, expected: { customerName: name, amountPaise: paise, entryType: "SALE" }, expectClarification: false },
    ];
    const hc = hardCases[i % hardCases.length]!;
    return { id: `hard-${lang}-${i}`, lang, text: hc.text, expected: hc.expected, holdout, synthetic: true, hard: true, expectClarification: hc.expectClarification };
  }

  let text: string;
  let entryType = "SALE";
  if (lang === "en") {
    const variants = [`${name} ${amount} udhaar`, `${name} ${amount}`, `${name} paid ${amount}`, `Credit ${amount} to ${name}`];
    text = variants[i % variants.length]!;
    if (text.includes("paid")) entryType = "PAYMENT_IN";
  } else if (lang === "hi") {
    const variants = [`${name} ${amount} udhaar`, `${name} ${amount} jama`, `${name} ko ${amount} diye`];
    text = variants[i % variants.length]!;
    if (text.includes("jama")) entryType = "PAYMENT_IN";
  } else {
    const variants = [`${name} ${amount} udhaar`, `${name} ${amount} ka maal`, `${name} ne ${amount} diya`];
    text = variants[i % variants.length]!;
    if (text.includes("diya")) entryType = "PAYMENT_IN";
  }
  if (i % 17 === 0) return { id: `${lang}-${i}`, lang, text: "hello", expected: null, holdout, synthetic: true, hard: false, expectClarification: false };
  if (i % 19 === 0) return { id: `${lang}-${i}`, lang, text: `${name} ${amount} udhaar, 50 wapas aaye`, expected: null, holdout, synthetic: true, hard: false, expectClarification: true };
  return { id: `${lang}-${i}`, lang, text, expected: { customerName: name, amountPaise: paise, entryType }, holdout, synthetic: true, hard: false, expectClarification: false };
}

const cases: Case[] = [];
let idx = 0;
for (const lang of ["hi", "en", "hinglish"] as const) {
  for (let i = 0; i < 40; i++) cases.push(makeCase(idx++, lang, false, false));
  // 20+ hard cases per... actually 8 hard per lang = 24 total
  for (let i = 0; i < 8; i++) cases.push(makeCase(5000 + idx++, lang, false, true));
}
const holdout: Case[] = [];
for (const lang of ["hi", "en", "hinglish"] as const) {
  for (let i = 0; i < 12; i++) holdout.push(makeCase(1000 + idx++, lang, true, false));
}

mkdirSync(path.join(process.cwd(), "src", "eval"), { recursive: true });
writeFileSync(path.join(process.cwd(), "src", "eval", "cases.json"), JSON.stringify(cases, null, 2));
writeFileSync(path.join(process.cwd(), "src", "eval", "holdout.json"), JSON.stringify(holdout, null, 2));
// Mark holdout as synthetic
writeFileSync(path.join(process.cwd(), "src", "eval", "holdout.meta.json"), JSON.stringify({ synthetic: true, note: "Synthetic hold-out. Real anonymised seller messages to be provided by reviewer." }, null, 2));
console.log(`wrote ${cases.length} cases (${cases.filter(c=>c.hard).length} hard) and ${holdout.length} synthetic holdout cases`);
