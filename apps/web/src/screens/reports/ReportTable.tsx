import { formatQty, formatRs } from '@tula/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cell, Col, Row, Table } from '../../api/reports';
import { nameIn } from '../../i18n';

const NUMERIC = new Set(['money', 'qty', 'int', 'pct', 'rate']);

export const showDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : iso);

/** Format one cell for the screen and for print. */
export function useCellText() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (c: Col, v: Cell): string => {
    if (v === null || v === undefined || v === '') return '';
    switch (c.type) {
      case 'money': return formatRs(Number(v), { symbol: false });
      case 'qty': return formatQty(Number(v), { decimals: 3, trimZeros: true });
      case 'int': return Number(v).toLocaleString('en-IN');
      case 'pct': return `${(Number(v) / 100).toFixed(2)}%`;
      case 'rate': return `${Number(v) / 100}%`;
      case 'date': return showDate(String(v));
      case 'name': {
        if (typeof v !== 'object') return String(v);
        const o = v as { en?: string; ta?: string | null; code?: string };
        return o.code ? t(`reports.lines.${o.code}`) : nameIn(lang, o.en ?? '', o.ta);
      }
      case 'alt': {
        const a = v as { whole: number; en: string; ta: string | null };
        return `${a.whole.toLocaleString('en-IN')} ${nameIn(lang, a.en, a.ta)}`;
      }
      default:
        if (c.type === 'code' && /^\d{4}-\d{2}$/.test(String(v))) {
          const [y, m] = String(v).split('-').map(Number);
          return new Intl.DateTimeFormat(`${lang}-IN`, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
        }
        return c.translate ? t(`reports.values.${String(v)}`, { defaultValue: String(v) }) : String(v);
    }
  };
}

function sortValue(c: Col, v: Cell, text: string): number | string {
  if (v === null || v === undefined || v === '') return NUMERIC.has(c.type) ? Number.NEGATIVE_INFINITY : '';
  return NUMERIC.has(c.type) ? Number(v) : c.type === 'date' ? String(v) : text.toLocaleLowerCase();
}

/** One report table: scrolls sideways inside its box on a phone, sorts by any column when the report allows it. */
export function ReportTable({ table }: { table: Table }) {
  const { t } = useTranslation();
  const text = useCellText();
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const header = (c: Col) => t(`reports.colsBy.${table.id}.${c.key}`, { defaultValue: t(`reports.cols.${c.key}`, { defaultValue: c.header }) });

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const col = table.columns.find((c) => c.key === sort.key);
    if (!col) return table.rows;
    return [...table.rows].sort((a, b) => {
      const x = sortValue(col, a[col.key], text(col, a[col.key]));
      const y = sortValue(col, b[col.key], text(col, b[col.key]));
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [sort, table, text]);

  const onSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: NUMERIC.has(table.columns.find((c) => c.key === key)!.type) ? -1 : 1 }));
  const cls = (c: Col) => (NUMERIC.has(c.type) ? 'r' : c.type === 'code' || c.type === 'date' ? 'nowrap' : undefined);

  return (
    <div className="table-box">
      <table className="grid compact report-table">
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} className={cls(c)} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                {table.sortable ? (
                  <button type="button" className="sort-btn" onClick={() => onSort(c.key)}>
                    {header(c)}<span aria-hidden="true" className="sort-mark">{sort?.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                  </button>
                ) : header(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={table.columns.length} className="empty-row">{t('reports.noRows')}</td></tr>}
          {rows.map((r: Row, i) => (
            <tr key={i} className={[r._cancelled && 'cancelled', r._strong && 'strong', r._indent && 'indent', r._opening && 'opening'].filter(Boolean).join(' ') || undefined}>
              {table.columns.map((c) => (
                <td key={c.key} className={cls(c)}>
                  {r._opening && c.key === 'narration' ? t('reports.openingBalance') : text(c, r[c.key])}
                  {r._cancelled && c.key === table.columns[0]!.key && <span className="sub">{t('reports.values.cancelled')}</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {table.totals && rows.length > 0 && (
          <tfoot>
            <tr>
              {table.columns.map((c, i) => (
                <td key={c.key} className={cls(c)}>{i === 0 && table.totals![c.key] === undefined ? t('reports.total') : text(c, table.totals![c.key])}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
