/**
 * Money is always an integer number of paise. These helpers are the only
 * place where rupee strings are parsed or produced.
 */
export type Paise = number;

const assertInt = (n: number, what: string) => {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
};

/**
 * Integer division rounded half away from zero: roundDiv(5, 2) = 3, roundDiv(-5, 2) = -3.
 * All rounding in the app goes through this function.
 */
export function roundDiv(numerator: number, denominator: number): number {
  assertInt(numerator, 'numerator');
  assertInt(denominator, 'denominator');
  if (denominator === 0) throw new RangeError('division by zero');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (2 * r >= d ? q + 1 : q);
}

/** Parse a decimal string with up to `scale` fraction digits into an integer (no floating point). */
export function parseScaled(input: string | number, scale: number, what = 'value'): number {
  const s = String(input).trim().replace(/,/g, '');
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`Invalid ${what}: "${input}"`);
  const [, neg, whole = '', frac = ''] = m;
  if (frac.length > scale) {
    // allow trailing zeros beyond scale, reject real extra precision
    if (/[^0]/.test(frac.slice(scale))) throw new RangeError(`${what} "${input}" has more than ${scale} decimals`);
  }
  const fracPadded = (frac + '0'.repeat(scale)).slice(0, scale);
  const value = Number(whole || '0') * 10 ** scale + Number(fracPadded || '0');
  assertInt(value, what);
  return neg ? -value : value;
}

/** "10.50" -> 1050 */
export const toPaise = (rupees: string | number): Paise => parseScaled(rupees, 2, 'amount');

const groupIndian = (n: number): string => {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
};

/** 123456789 -> "₹12,34,567.89" */
export function formatRs(paise: Paise, opts: { symbol?: boolean } = {}): string {
  assertInt(paise, 'paise');
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const body = `${groupIndian(rupees)}.${String(p).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${opts.symbol === false ? '' : '₹'}${body}`;
}

/** Round a paise amount to the nearest rupee; returns the round-off adjustment and rounded total. */
export function roundToRupee(paise: Paise): { roundOff: Paise; total: Paise } {
  const total = roundDiv(paise, 100) * 100;
  return { roundOff: total - paise, total };
}
