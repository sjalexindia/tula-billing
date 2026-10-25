import type { Paise } from './money';

// ---------------- English (Indian system: thousand, lakh, crore) ----------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function enBelow100(n: number): string {
  if (n < 20) return ONES[n]!;
  return TENS[Math.floor(n / 10)]! + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function enBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? enBelow100(r) : ''].filter(Boolean).join(' ');
}
export function numberToWordsEn(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('Non-negative integer expected');
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  return [
    crore ? `${numberToWordsEn(crore)} Crore` : '',
    lakh ? `${enBelow100(lakh)} Lakh` : '',
    thousand ? `${enBelow100(thousand)} Thousand` : '',
    rest ? enBelow1000(rest) : '',
  ].filter(Boolean).join(' ');
}

// ---------------- Tamil ----------------
// Combining forms (…த்து / …ற்று) are used when another number follows.
// Spaced style ("முப்பத்து ஏழு") is used for readability on invoices.
// NOTE: to be reviewed by a native reader before go-live.
const TA_ONES = ['', 'ஒன்று', 'இரண்டு', 'மூன்று', 'நான்கு', 'ஐந்து', 'ஆறு', 'ஏழு', 'எட்டு', 'ஒன்பது'];
const TA_TEENS = ['பத்து', 'பதினொன்று', 'பன்னிரண்டு', 'பதின்மூன்று', 'பதினான்கு', 'பதினைந்து', 'பதினாறு', 'பதினேழு', 'பதினெட்டு', 'பத்தொன்பது'];
const TA_TENS = ['', '', 'இருபது', 'முப்பது', 'நாற்பது', 'ஐம்பது', 'அறுபது', 'எழுபது', 'எண்பது', 'தொண்ணூறு'];
const TA_TENS_C = ['', '', 'இருபத்து', 'முப்பத்து', 'நாற்பத்து', 'ஐம்பத்து', 'அறுபத்து', 'எழுபத்து', 'எண்பத்து', 'தொண்ணூற்று'];
const TA_HUND = ['', 'நூறு', 'இருநூறு', 'முன்னூறு', 'நானூறு', 'ஐநூறு', 'அறுநூறு', 'எழுநூறு', 'எண்ணூறு', 'தொள்ளாயிரம்'];
const TA_HUND_C = ['', 'நூற்று', 'இருநூற்று', 'முன்னூற்று', 'நானூற்று', 'ஐநூற்று', 'அறுநூற்று', 'எழுநூற்று', 'எண்ணூற்று', 'தொள்ளாயிரத்து'];

function taBelow100(n: number): string {
  if (n < 10) return TA_ONES[n]!;
  if (n < 20) return TA_TEENS[n - 10]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TA_TENS_C[t]} ${TA_ONES[o]}` : TA_TENS[t]!;
}
function taBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (!h) return taBelow100(r);
  return r ? `${TA_HUND_C[h]} ${taBelow100(r)}` : TA_HUND[h]!;
}
/** Scale word with standalone/combining forms, e.g. ஆயிரம் / ஆயிரத்து */
function taScale(count: number, standalone: string, combining: string, more: boolean, countWords: (n: number) => string) {
  // "ஆயிரம்" alone for 1000; "ஒரு இலட்சம்" / "ஒரு கோடி" for one lakh / crore
  const head = count === 1 ? (standalone === 'ஆயிரம்' ? '' : 'ஒரு ') : countWords(count) + ' ';
  return head + (more ? combining : standalone);
}
export function numberToWordsTa(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('Non-negative integer expected');
  if (n === 0) return 'பூஜ்ஜியம்';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(taScale(crore, 'கோடி', 'கோடியே', lakh + thousand + rest > 0, numberToWordsTa));
  if (lakh) parts.push(taScale(lakh, 'இலட்சம்', 'இலட்சத்து', thousand + rest > 0, taBelow100));
  if (thousand) parts.push(taScale(thousand, 'ஆயிரம்', 'ஆயிரத்து', rest > 0, taBelow100));
  if (rest) parts.push(taBelow1000(rest));
  return parts.join(' ');
}

/** Amount in words for invoices, e.g. "Rupees Thirty Seven Thousand Seven Hundred Sixty Only" */
export function amountInWords(paise: Paise, lang: 'en' | 'ta' = 'en'): string {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new RangeError('Non-negative paise expected');
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  if (lang === 'ta') {
    const r = `${numberToWordsTa(rupees)} ரூபாய்`;
    return p ? `${r} ${numberToWordsTa(p)} பைசா மட்டும்` : `${r} மட்டும்`;
  }
  const r = `Rupees ${numberToWordsEn(rupees)}`;
  return p ? `${r} and ${numberToWordsEn(p)} Paise Only` : `${r} Only`;
}
