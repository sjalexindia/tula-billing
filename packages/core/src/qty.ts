import { parseScaled, roundDiv } from './money';

/** Quantities are integer thousandths of a unit: 147.35 kg -> 147350. */
export type Milli = number;

export const toMilli = (qty: string | number): Milli => parseScaled(qty, 3, 'quantity');

/** 147350 -> "147.350" (decimals = 3) or "147.35" with trimZeros */
export function formatQty(milli: Milli, opts: { decimals?: number; trimZeros?: boolean } = {}): string {
  const decimals = opts.decimals ?? 3;
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const scaled = decimals === 3 ? abs : roundDiv(abs, 10 ** (3 - decimals));
  const whole = Math.floor(scaled / 10 ** decimals);
  let frac = decimals > 0 ? String(scaled % 10 ** decimals).padStart(decimals, '0') : '';
  if (opts.trimZeros) frac = frac.replace(/0+$/, '');
  const groupedWhole = whole.toLocaleString('en-IN');
  return `${neg ? '-' : ''}${groupedWhole}${frac ? '.' + frac : ''}`;
}

/**
 * Theoretical weight of one TMT rod in grams (= kg in milli):
 * kg/m = d² / 162, so kg per rod = d² × length / 162.
 * 12 mm × 12 m -> 10667 (10.667 kg)
 */
export function steelRodWeightMilli(diameterMm: number, lengthM: string | number = 12): Milli {
  const lengthMilli = toMilli(lengthM);
  return roundDiv(diameterMm * diameterMm * lengthMilli, 162);
}

/** One alternate unit of a product, e.g. BDL = 53333 base milli. */
export interface UnitFactor {
  unitCode: string;
  factorMilli: Milli; // base-unit milli in ONE of this unit
}

/**
 * Convert a mixed entry like { BDL: 10, ROD: 4 } (counts in milli) to base-unit milli.
 * Base unit itself uses factor 1000.
 */
export function toBaseMilli(entry: Record<string, Milli>, factors: UnitFactor[], baseUnitCode: string): Milli {
  let total = 0;
  for (const [code, countMilli] of Object.entries(entry)) {
    if (!countMilli) continue;
    if (code === baseUnitCode) {
      total += countMilli;
      continue;
    }
    const f = factors.find((u) => u.unitCode === code);
    if (!f) throw new RangeError(`Unknown unit ${code}`);
    total += roundDiv(countMilli * f.factorMilli, 1000);
  }
  return total;
}

/** Express base milli as whole alternate units + remainder, e.g. 2466.67 kg -> 46 BDL + 13.35 kg. */
export function splitIntoUnits(baseMilli: Milli, factorMilli: Milli): { whole: number; remainderMilli: Milli } {
  const whole = Math.floor(baseMilli / factorMilli);
  return { whole, remainderMilli: baseMilli - whole * factorMilli };
}

/**
 * Stock in the largest larger unit, exactly: "46 Bundle + 13.35 Kg" (whole larger units, then what is left
 * in the base unit). With a theoretical unit (a bundle or rod by calculated weight) it is an estimate: "≈ 46 Bundle…".
 * Empty when there is not even one larger unit.
 */
export function largerUnitText(baseMilli: Milli, factorMilli: Milli, largerName: string, baseName: string, theoretical = false): string {
  if (baseMilli <= 0 || factorMilli <= 0) return '';
  const { whole, remainderMilli } = splitIntoUnits(baseMilli, factorMilli);
  if (!whole) return '';
  const rest = remainderMilli ? ` + ${formatQty(remainderMilli, { decimals: 2, trimZeros: true })} ${baseName}` : '';
  return `${theoretical ? '≈ ' : ''}${whole.toLocaleString('en-IN')} ${largerName}${rest}`;
}
