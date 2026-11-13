import { MoneyError, divRoundHalfUp, paise, percentOf, sum, type Paise } from "./money";
import { allocate } from "./allocate";

export type TaxRounding = "PER_LINE" | "PER_INVOICE";

export interface TaxableLineInput {
  key: string;
  taxablePaise: Paise;
  /** GST rate in basis points: 18% = 1800, 5% = 500. */
  rateBasisPoints: number;
}

export interface TaxedLine extends TaxableLineInput {
  taxPaise: Paise;
}

export interface DocumentTaxOptions {
  /** Per-line is the default and is the documented product decision (D2). */
  rounding: TaxRounding;
  /** true → IGST; false → CGST + SGST. */
  interState: boolean;
}

export interface DocumentTaxResult {
  lines: TaxedLine[];
  taxableTotalPaise: Paise;
  taxTotalPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  grandTotalPaise: Paise;
}

function assertRate(rateBasisPoints: number): void {
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10_000) {
    throw new MoneyError(`invalid GST rate: ${rateBasisPoints} basis points`);
  }
}

function assertTaxable(taxablePaise: Paise): void {
  if (!Number.isInteger(taxablePaise) || taxablePaise < 0) {
    throw new MoneyError(`taxable amount must be a non-negative integer of paise, received ${taxablePaise}`);
  }
}

/** Tax for one line at one rate, rounded half-up to the paise. */
export function computeLineTax(taxablePaise: Paise, rateBasisPoints: number): Paise {
  assertTaxable(taxablePaise);
  assertRate(rateBasisPoints);
  return percentOf(taxablePaise, rateBasisPoints);
}

/**
 * Compute document tax.
 *
 * PER_LINE: each line is rounded independently; the document tax is the sum,
 * so the printed lines always add up to the printed total.
 *
 * PER_INVOICE: tax is computed once per rate group and then attributed back to
 * the lines with `allocate()`, so line tax still sums to the document tax.
 */
export function computeDocumentTax(
  lines: readonly TaxableLineInput[],
  options: DocumentTaxOptions,
): DocumentTaxResult {
  const taxed: TaxedLine[] = [];

  if (options.rounding === "PER_LINE") {
    for (const line of lines) {
      assertTaxable(line.taxablePaise);
      assertRate(line.rateBasisPoints);
      taxed.push({ ...line, taxPaise: computeLineTax(line.taxablePaise, line.rateBasisPoints) });
    }
  } else {
    const groups = new Map<number, TaxableLineInput[]>();
    for (const line of lines) {
      assertTaxable(line.taxablePaise);
      assertRate(line.rateBasisPoints);
      const group = groups.get(line.rateBasisPoints) ?? [];
      group.push(line);
      groups.set(line.rateBasisPoints, group);
    }

    const taxByKey = new Map<string, Paise>();
    for (const [rateBasisPoints, group] of groups) {
      const groupTaxable = sum(group.map((line) => line.taxablePaise));
      const groupTax = computeLineTax(groupTaxable, rateBasisPoints);
      const shares = allocate(
        groupTax,
        group.map((line) => line.taxablePaise),
      );
      group.forEach((line, index) => {
        taxByKey.set(line.key, shares[index] as Paise);
      });
    }

    for (const line of lines) {
      taxed.push({ ...line, taxPaise: taxByKey.get(line.key) ?? paise(0) });
    }
  }

  const taxableTotalPaise = sum(taxed.map((line) => line.taxablePaise));
  const taxTotalPaise = sum(taxed.map((line) => line.taxPaise));
  const grandTotalPaise = (taxableTotalPaise + taxTotalPaise) as Paise;

  // Half of an odd paise goes to SGST so CGST + SGST always equals the tax total.
  const cgstPaise = (options.interState ? 0 : divRoundHalfUp(taxTotalPaise, 2)) as Paise;
  const sgstPaise = (options.interState ? 0 : taxTotalPaise - cgstPaise) as Paise;
  const igstPaise = (options.interState ? taxTotalPaise : 0) as Paise;

  return {
    lines: taxed,
    taxableTotalPaise,
    taxTotalPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    grandTotalPaise,
  };
}
