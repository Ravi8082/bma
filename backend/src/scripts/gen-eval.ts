import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface Case {
  id: string;
  lang: "hi" | "en" | "hinglish";
  text: string;
  expected: { customerName: string; amountPaise: number; entryType: string } | null;
  holdout: boolean;
}

const names = ["Ramesh", "Suresh", "Mahesh", "Rajesh", "Dinesh", "Priya", "Sunita", "Anita"];
const amounts = [100, 150, 200, 300, 450, 500, 750, 1000, 1234, 2500];

function makeCase(i: number, lang: "hi" | "en" | "hinglish", holdout: boolean): Case {
  const name = names[i % names.length]!;
  const amount = amounts[i % amounts.length]!;
  const paise = amount * 100;
  let text: string;
  let entryType = "SALE";
  if (lang === "en") {
    const variants = [
      `${name} ${amount} udhaar`,
      `${name} ${amount}`,
      `${name} paid ${amount}`,
      `Credit ${amount} to ${name}`,
    ];
    text = variants[i % variants.length]!;
    if (text.includes("paid")) entryType = "PAYMENT_IN";
  } else if (lang === "hi") {
    const variants = [
      `${name} ${amount} udhaar`,
      `${name} ${amount} jama`,
      `${name} ko ${amount} diye`,
    ];
    text = variants[i % variants.length]!;
    if (text.includes("jama")) entryType = "PAYMENT_IN";
  } else {
    const variants = [
      `${name} ${amount} udhaar`,
      `${name} ${amount} ka maal`,
      `${name} ne ${amount} diya`,
    ];
    text = variants[i % variants.length]!;
    if (text.includes("diya")) entryType = "PAYMENT_IN";
  }
  // A few unparseable cases.
  if (i % 17 === 0) {
    return { id: `${lang}-${i}`, lang, text: "hello", expected: null, holdout };
  }
  // A few multi-number cases that should route to clarification (expected null here means "no auto-post").
  if (i % 19 === 0) {
    return { id: `${lang}-${i}`, lang, text: `${name} ${amount} udhaar, 50 wapas aaye`, expected: null, holdout };
  }
  return { id: `${lang}-${i}`, lang, text, expected: { customerName: name, amountPaise: paise, entryType }, holdout };
}

const cases: Case[] = [];
let idx = 0;
for (const lang of ["hi", "en", "hinglish"] as const) {
  for (let i = 0; i < 40; i++) {
    cases.push(makeCase(idx++, lang, false));
  }
}
// hold-out set
const holdout: Case[] = [];
for (const lang of ["hi", "en", "hinglish"] as const) {
  for (let i = 0; i < 12; i++) {
    holdout.push(makeCase(1000 + idx++, lang, true));
  }
}

mkdirSync(path.join(process.cwd(), "src", "eval"), { recursive: true });
writeFileSync(path.join(process.cwd(), "src", "eval", "cases.json"), JSON.stringify(cases, null, 2));
writeFileSync(path.join(process.cwd(), "src", "eval", "holdout.json"), JSON.stringify(holdout, null, 2));
console.log(`wrote ${cases.length} cases and ${holdout.length} holdout cases`);
