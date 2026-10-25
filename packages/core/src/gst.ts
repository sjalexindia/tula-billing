import { type Paise, roundDiv, roundToRupee } from './money';
import type { Milli } from './qty';

export type SupplyType = 'intra' | 'inter';

/** 18% = 1800 basis points */
export type BasisPoints = number;

export interface LineInput {
  /** quantity in the unit the rate is quoted in, thousandths */
  rateQtyMilli: Milli;
  /** rate per rate-unit, paise. Excl. GST unless `inclusive` */
  ratePaise: Paise;
  discountPaise?: Paise;
  gstBp: BasisPoints;
  /** rate includes GST (back-calculate taxable value) */
  inclusive?: boolean;
}

export interface LineAmounts {
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  total: Paise;
}

/** Tax for a taxable value. Intra-state splits equally into CGST + SGST, each rounded on its own. */
export function taxFor(taxable: Paise, gstBp: BasisPoints, supply: SupplyType) {
  if (supply === 'inter') {
    return { cgst: 0, sgst: 0, igst: roundDiv(taxable * gstBp, 10000) };
  }
  const half = roundDiv(taxable * gstBp, 20000);
  return { cgst: half, sgst: half, igst: 0 };
}

export function calcLine(input: LineInput, supply: SupplyType): LineAmounts {
  const { rateQtyMilli, ratePaise, gstBp } = input;
  const discount = input.discountPaise ?? 0;
  if (rateQtyMilli <= 0) throw new RangeError('Quantity must be more than zero');
  if (ratePaise < 0) throw new RangeError('Rate cannot be negative');
  if (gstBp < 0 || gstBp > 4000) throw new RangeError('GST rate out of range');

  const gross = roundDiv(rateQtyMilli * ratePaise, 1000);
  if (discount < 0 || discount > gross) throw new RangeError('Discount must be between 0 and the line value');

  if (input.inclusive) {
    // The quoted (GST-inclusive) amount is what the customer pays, to the paisa.
    // Taxable value is back-calculated; tax is the remainder, so line total = quoted amount exactly.
    const total = gross - discount;
    const taxable = roundDiv(total * 10000, 10000 + gstBp);
    const tax = total - taxable;
    const cgst = supply === 'inter' ? 0 : roundDiv(tax, 2);
    const sgst = supply === 'inter' ? 0 : tax - cgst;
    const igst = supply === 'inter' ? tax : 0;
    return { gross, discount, taxable, cgst, sgst, igst, total };
  }
  const taxable = gross - discount;
  const tax = taxFor(taxable, gstBp, supply);
  return { gross, discount, taxable, ...tax, total: taxable + tax.cgst + tax.sgst + tax.igst };
}

export interface BillTotals {
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  beforeRoundOff: Paise;
  roundOff: Paise;
  total: Paise;
  /** per GST rate, for the invoice tax summary and GSTR-1 */
  byRate: Array<{ gstBp: BasisPoints; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise }>;
}

export function calcBill(lines: Array<LineAmounts & { gstBp: BasisPoints }>, opts: { roundToRupee?: boolean } = {}): BillTotals {
  const sum = (k: keyof LineAmounts) => lines.reduce((a, l) => a + l[k], 0);
  const taxable = sum('taxable');
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  const beforeRoundOff = taxable + cgst + sgst + igst;
  const r = opts.roundToRupee === false ? { roundOff: 0, total: beforeRoundOff } : roundToRupee(beforeRoundOff);

  const rates = new Map<number, { gstBp: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const e = rates.get(l.gstBp) ?? { gstBp: l.gstBp, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    e.taxable += l.taxable;
    e.cgst += l.cgst;
    e.sgst += l.sgst;
    e.igst += l.igst;
    rates.set(l.gstBp, e);
  }
  return { taxable, cgst, sgst, igst, beforeRoundOff, ...r, byRate: [...rates.values()].sort((a, b) => a.gstBp - b.gstBp) };
}

/** Intra-state when the place of supply is the shop's own state. */
export const supplyTypeFor = (shopStateCode: string, placeOfSupply: string): SupplyType =>
  shopStateCode === placeOfSupply ? 'intra' : 'inter';

/** First two digits of a GSTIN are the state code. */
export function stateFromGstin(gstin?: string | null): string | null {
  if (!gstin) return null;
  const g = gstin.trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(g) ? g.slice(0, 2) : null;
}
