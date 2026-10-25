/**
 * Financial year and document numbers.
 * CGST Rule 46: invoice serial number unique per financial year,
 * max 16 characters, only letters, digits, '-' and '/'.
 */

/** '2026-10-25' -> '26-27'; '2027-03-31' -> '26-27'; '2027-04-01' -> '27-28' */
export function financialYear(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`Invalid date ${isoDate}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(start)}-${yy(start + 1)}`;
}

export function financialYearRange(fy: string): { from: string; to: string } {
  const m = /^(\d{2})-(\d{2})$/.exec(fy);
  if (!m) throw new RangeError(`Invalid FY ${fy}`);
  const start = 2000 + Number(m[1]);
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export const DOC_NO_MAX = 16;
const DOC_NO_PATTERN = /^[A-Za-z0-9/-]+$/;

export interface SeriesSpec {
  prefix: string; // 'ST'
  fy: string; // '26-27'
  seriesCode: string; // '' for the PC, 'M1' for phone 1
  pad: number; // 4
}

export function formatDocNo(spec: SeriesSpec, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('Document number must be a positive integer');
  const docNo = `${spec.prefix}/${spec.fy}/${spec.seriesCode}${String(n).padStart(spec.pad, '0')}`;
  validateDocNo(docNo);
  return docNo;
}

export function validateDocNo(docNo: string): void {
  if (docNo.length > DOC_NO_MAX) throw new RangeError(`"${docNo}" is longer than ${DOC_NO_MAX} characters (GST rule)`);
  if (!DOC_NO_PATTERN.test(docNo)) throw new RangeError(`"${docNo}" may only contain letters, digits, - and /`);
}

/** Today's date in India as YYYY-MM-DD, independent of the machine's time zone. */
export function todayIST(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
