import { describe, expect, it } from 'vitest';
import {
  amountInWords, calcBill, calcLine, financialYear, financialYearRange, formatDocNo, formatQty, formatRs,
  numberToWordsEn, numberToWordsTa, roundDiv, roundToRupee, splitIntoUnits, stateFromGstin, steelRodWeightMilli,
  supplyTypeFor, taxFor, toBaseMilli, toMilli, toPaise, todayIST,
} from '../src';

describe('money', () => {
  it('parses rupee strings exactly', () => {
    expect(toPaise('10.50')).toBe(1050);
    expect(toPaise('10.5')).toBe(1050);
    expect(toPaise('0.10')).toBe(10);
    expect(toPaise('1,23,456.78')).toBe(12345678);
    expect(toPaise('-5')).toBe(-500);
    expect(toPaise('7.000')).toBe(700);
    expect(() => toPaise('7.005')).toThrow();
    expect(() => toPaise('abc')).toThrow();
    expect(() => toPaise('')).toThrow();
  });
  it('formats in Indian grouping', () => {
    expect(formatRs(123456789)).toBe('₹12,34,567.89');
    expect(formatRs(1050)).toBe('₹10.50');
    expect(formatRs(5)).toBe('₹0.05');
    expect(formatRs(-100000)).toBe('-₹1,000.00');
    expect(formatRs(99900, { symbol: false })).toBe('999.00');
  });
  it('rounds half away from zero', () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(1499, 1000)).toBe(1);
    expect(roundDiv(1500, 1000)).toBe(2);
  });
  it('rounds bills to the rupee', () => {
    expect(roundToRupee(3775976)).toEqual({ roundOff: 24, total: 3776000 });
    expect(roundToRupee(1050)).toEqual({ roundOff: -50 + 100, total: 1100 });
    expect(roundToRupee(1049)).toEqual({ roundOff: -49, total: 1000 });
  });
  it('has no floating point drift over many additions', () => {
    let total = 0;
    for (let i = 0; i < 10000; i++) total += toPaise('0.10');
    expect(total).toBe(100000);
  });
});

describe('quantities and steel', () => {
  it('parses and formats quantities', () => {
    expect(toMilli('147.35')).toBe(147350);
    expect(formatQty(147350)).toBe('147.350');
    expect(formatQty(147350, { trimZeros: true })).toBe('147.35');
    expect(formatQty(2466670, { decimals: 2 })).toBe('2,466.67');
  });
  it('computes theoretical rod weights (d²/162 × length)', () => {
    expect(steelRodWeightMilli(12, 12)).toBe(10667);
    expect(steelRodWeightMilli(8, 12)).toBe(4741);
    expect(steelRodWeightMilli(16, 12)).toBe(18963);
    expect(steelRodWeightMilli(10, '12')).toBe(7407);
  });
  it('converts bundles + rods + kg into base kg', () => {
    const factors = [
      { unitCode: 'ROD', factorMilli: 10667 },
      { unitCode: 'BDL', factorMilli: 53333 },
    ];
    expect(toBaseMilli({ BDL: 10000, ROD: 4000 }, factors, 'KG')).toBe(533330 + 42668);
    expect(toBaseMilli({ KG: 147350 }, factors, 'KG')).toBe(147350);
    expect(() => toBaseMilli({ BAG: 1000 }, factors, 'KG')).toThrow();
  });
  it('splits stock into whole bundles + remainder', () => {
    expect(splitIntoUnits(2466670, 53333)).toEqual({ whole: 46, remainderMilli: 2466670 - 46 * 53333 });
  });
});

describe('GST', () => {
  it('splits CGST/SGST for intra-state and IGST for inter-state', () => {
    expect(taxFor(3199980, 1800, 'intra')).toEqual({ cgst: 287998, sgst: 287998, igst: 0 });
    expect(taxFor(3199980, 1800, 'inter')).toEqual({ cgst: 0, sgst: 0, igst: 575996 });
  });
  it('calculates a steel line: 533.330 kg × ₹60.00', () => {
    const l = calcLine({ rateQtyMilli: 533330, ratePaise: 6000, gstBp: 1800 }, 'intra');
    expect(l).toMatchObject({ gross: 3199980, taxable: 3199980, cgst: 287998, sgst: 287998, total: 3775976 });
  });
  it('applies line discount before tax', () => {
    const l = calcLine({ rateQtyMilli: 142500, ratePaise: 6100, discountPaise: 5000, gstBp: 1800 }, 'intra');
    expect(l.gross).toBe(869250);
    expect(l.taxable).toBe(864250);
    expect(l.cgst).toBe(77783); // 864250 × 9% = 77782.5 -> 77783
  });
  it('back-calculates taxable value from GST-inclusive rates', () => {
    const l = calcLine({ rateQtyMilli: 1000, ratePaise: 11800, gstBp: 1800, inclusive: true }, 'intra');
    expect(l.taxable).toBe(10000);
    expect(l.cgst + l.sgst).toBe(1800);
    expect(l.total).toBe(11800);
  });
  it('rejects bad input', () => {
    expect(() => calcLine({ rateQtyMilli: 0, ratePaise: 100, gstBp: 1800 }, 'intra')).toThrow();
    expect(() => calcLine({ rateQtyMilli: 1000, ratePaise: 100, discountPaise: 200, gstBp: 1800 }, 'intra')).toThrow();
    expect(() => calcLine({ rateQtyMilli: 1000, ratePaise: 100, gstBp: 9000 }, 'intra')).toThrow();
  });
  it('totals a bill with mixed rates and rounds to the rupee', () => {
    const steel = { ...calcLine({ rateQtyMilli: 533330, ratePaise: 6000, gstBp: 1800 }, 'intra'), gstBp: 1800 };
    const transport = { ...calcLine({ rateQtyMilli: 1000, ratePaise: 80000, gstBp: 1800 }, 'intra'), gstBp: 1800 };
    const zero = { ...calcLine({ rateQtyMilli: 1000, ratePaise: 5000, gstBp: 0 }, 'intra'), gstBp: 0 };
    const b = calcBill([steel, transport, zero]);
    expect(b.taxable).toBe(3199980 + 80000 + 5000);
    expect(b.total % 100).toBe(0);
    expect(b.total).toBe(b.beforeRoundOff + b.roundOff);
    expect(b.byRate.map((r) => r.gstBp)).toEqual([0, 1800]);
  });
  it('derives supply type and state from GSTIN', () => {
    expect(stateFromGstin('33ABCDE1234F1Z5')).toBe('33');
    expect(stateFromGstin('bad')).toBeNull();
    expect(supplyTypeFor('33', '33')).toBe('intra');
    expect(supplyTypeFor('33', '32')).toBe('inter');
  });
});

describe('numbering', () => {
  it('derives the financial year (April–March)', () => {
    expect(financialYear('2026-10-25')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2027-04-01')).toBe('27-28');
    expect(financialYear('2099-12-01')).toBe('99-00');
    expect(financialYearRange('26-27')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
  it('formats invoice numbers within the 16-character GST limit', () => {
    expect(formatDocNo({ prefix: 'ST', fy: '26-27', seriesCode: '', pad: 4 }, 1)).toBe('ST/26-27/0001');
    expect(formatDocNo({ prefix: 'ST', fy: '26-27', seriesCode: 'M1', pad: 4 }, 12)).toBe('ST/26-27/M10012');
    expect(() => formatDocNo({ prefix: 'STEEL', fy: '26-27', seriesCode: 'M1', pad: 4 }, 1)).toThrow(/16/);
    expect(() => formatDocNo({ prefix: 'S T', fy: '26-27', seriesCode: '', pad: 4 }, 1)).toThrow();
  });
  it('uses the India date regardless of server time zone', () => {
    expect(todayIST(new Date('2026-10-24T19:00:00Z'))).toBe('2026-10-25');
    expect(todayIST(new Date('2026-10-24T18:00:00Z'))).toBe('2026-10-24');
  });
});

describe('amount in words', () => {
  it('English, Indian system', () => {
    expect(numberToWordsEn(37760)).toBe('Thirty Seven Thousand Seven Hundred Sixty');
    expect(numberToWordsEn(1234567)).toBe('Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven');
    expect(numberToWordsEn(250000000)).toBe('Twenty Five Crore');
    expect(amountInWords(3776000)).toBe('Rupees Thirty Seven Thousand Seven Hundred Sixty Only');
    expect(amountInWords(105050)).toBe('Rupees One Thousand Fifty and Fifty Paise Only');
  });
  it('Tamil', () => {
    expect(numberToWordsTa(37760)).toBe('முப்பத்து ஏழு ஆயிரத்து எழுநூற்று அறுபது');
    expect(numberToWordsTa(1000)).toBe('ஆயிரம்');
    expect(numberToWordsTa(100000)).toBe('ஒரு இலட்சம்');
    expect(numberToWordsTa(215)).toBe('இருநூற்று பதினைந்து');
    expect(amountInWords(3776000, 'ta')).toBe('முப்பத்து ஏழு ஆயிரத்து எழுநூற்று அறுபது ரூபாய் மட்டும்');
  });
});

import { checkSettingsConsistency, missingForBilling, validateSetting, withDefaults, stateName } from '../src';

describe('GST-inclusive rates', () => {
  it('keeps the line total equal to the quoted amount, to the paisa', () => {
    const cement = calcLine({ rateQtyMilli: 50000, ratePaise: 42000, gstBp: 1800, inclusive: true }, 'intra');
    expect(cement.total).toBe(2_100_000);
    expect(cement.taxable).toBe(1_779_661);
    expect(cement.cgst + cement.sgst).toBe(2_100_000 - 1_779_661);
    expect(Math.abs(cement.cgst - cement.sgst)).toBeLessThanOrEqual(1);
    const transport = calcLine({ rateQtyMilli: 1000, ratePaise: 80000, gstBp: 1800, inclusive: true }, 'inter');
    expect(transport.total).toBe(80000);
    expect(transport.igst).toBe(80000 - transport.taxable);
    const discounted = calcLine({ rateQtyMilli: 10000, ratePaise: 11800, discountPaise: 1800, gstBp: 1800, inclusive: true }, 'intra');
    expect(discounted.total).toBe(116200);
  });
});

describe('settings registry', () => {
  it('validates values by type', () => {
    expect(validateSetting('business.state_code', '33')).toBe('33');
    expect(() => validateSetting('business.state_code', '00')).toThrow();
    expect(validateSetting('gst.gstin', '33abcde1234f1z5')).toBe('33ABCDE1234F1Z5');
    expect(() => validateSetting('gst.gstin', '12345')).toThrow(/GSTIN/);
    expect(validateSetting('app.languages', 'en, ta,en')).toBe('en,ta');
    expect(() => validateSetting('app.languages', 'en,fr')).toThrow();
    expect(validateSetting('invoice.prefix', 'st')).toBe('ST');
    expect(() => validateSetting('invoice.prefix', 'TOOLONG1')).toThrow();
    expect(() => validateSetting('billing.stock_check', 'maybe')).toThrow();
    expect(() => validateSetting('shop.secret', 'x')).toThrow(/Unknown/);
  });
  it('reports what must be filled before billing', () => {
    const s = withDefaults({});
    expect(missingForBilling(s).sort()).toEqual(['business.address', 'business.name_en', 'business.state_code', 'gst.gstin']);
    expect(missingForBilling(withDefaults({ 'gst.scheme': 'unregistered', 'business.name_en': 'A', 'business.address': 'B', 'business.state_code': '29' }))).toEqual([]);
  });
  it('flags inconsistent settings', () => {
    const s = withDefaults({ 'gst.gstin': '33ABCDE1234F1Z5', 'business.state_code': '29', 'app.languages': 'en', 'app.default_lang': 'ta' });
    expect(checkSettingsConsistency(s)).toHaveLength(2);
    expect(stateName('29')).toBe('Karnataka');
  });
});

import { validateDocFormat } from '../src';

describe('configurable invoice numbering', () => {
  const base = { prefix: 'RE', fy: '26-27', seriesCode: '', pad: 4 };
  it('supports custom formats, including a plain running number', () => {
    expect(formatDocNo({ ...base, format: '{seq}', pad: 1 }, 246)).toBe('246');
    expect(formatDocNo({ ...base, format: '{prefix}-{yy}-{seq}' }, 7)).toBe('RE-26-0007');
    expect(formatDocNo({ ...base, format: '{seq}/{fy}', seriesCode: 'M1' }, 3)).toBe('M10003/26-27');
    expect(formatDocNo(base, 1)).toBe('RE/26-27/0001'); // default format
  });
  it('rejects bad formats', () => {
    expect(() => validateDocFormat('{prefix}/{fy}')).toThrow(/\{seq\}/);
    expect(() => validateDocFormat('{seq}{month}')).toThrow(/Unknown token/);
    expect(() => validateDocFormat('INV #{seq}')).toThrow();
  });
  it('validates the new numeric settings', () => {
    expect(validateSetting('invoice.start_number', '0246')).toBe('246');
    expect(() => validateSetting('invoice.start_number', '0')).toThrow();
    expect(() => validateSetting('invoice.seq_digits', '2.5')).toThrow();
    expect(validateSetting('eway.threshold_intra', '1,00,000')).toBe('100000');
    expect(validateSetting('credit.interest_pa', '18')).toBe('18');
    expect(validateSetting('credit.interest_pa', '1.5')).toBe('1.5');
    expect(() => validateSetting('credit.interest_pa', '40')).toThrow();
    expect(validateSetting('invoice.prefix', '')).toBe('');
  });
  it('catches settings that would break numbering or bilingual printing', () => {
    expect(checkSettingsConsistency(withDefaults({ 'invoice.prefix': '' }))).toContain('The number format uses {prefix}, so the invoice prefix cannot be empty');
    expect(checkSettingsConsistency(withDefaults({ 'invoice.prefix': 'LONGPX', 'invoice.seq_digits': '8' })).join()).toMatch(/16 characters/);
    expect(checkSettingsConsistency(withDefaults({ 'invoice.label_mode': 'bilingual' }))).toContain('Bilingual bills need two enabled languages');
    expect(checkSettingsConsistency(withDefaults({ 'invoice.prefix': '', 'invoice.number_format': '{seq}', 'invoice.seq_digits': '1' }))).toEqual([]);
  });
});
