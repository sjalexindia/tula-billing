import { useTranslation } from 'react-i18next';
import { useApp } from '../App';
import { GROUPS, REPORTS } from '../api/reports';
import type { ScreenProps } from '../nav';
import { ReportView } from './reports/ReportView';
import '../styles/reports.css';

/** Reports: a grouped list; each report opens at #/reports/<id> with its period picker, table, Excel and print. */
export function Reports({ id }: ScreenProps) {
  const { t } = useTranslation();
  const { settings } = useApp();
  const scheme = settings?.values['gst.scheme'] ?? 'regular';
  const visible = REPORTS.filter((r) => !r.schemes || r.schemes.includes(scheme));
  const open = id ? visible.find((r) => r.id === id) : undefined;
  if (open) return <ReportView key={open.id} def={open} onBack={() => { location.hash = '#/reports'; }} />;

  return (
    <section className="page reports-home">
      <div className="page-head"><h1>{t('reports.title')}</h1></div>
      <div className="report-groups">
        {GROUPS.map((g) => {
          const items = visible.filter((r) => r.group === g);
          if (!items.length) return null;
          return (
            <section key={g} className="report-group" aria-labelledby={`rg-${g}`}>
              <h2 id={`rg-${g}`}>{t(`reports.groups.${g}`)}</h2>
              <ul>
                {items.map((r) => (
                  <li key={r.id}>
                    <a href={`#/reports/${r.id}`}>
                      <span className="report-name">{t(`reports.list.${r.id}.title`)}</span>
                      <span className="report-desc">{t(`reports.list.${r.id}.desc`)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
