import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScreenProps } from '../nav';
import '../styles/help.css';

/*
 * Help: the user guide, from locales/<lang>/help.json, so it follows the language switch and
 * works in the phone app too. Text uses a small markup:
 *   [Billing > New bill]  menu path, drawn like the app's menu
 *   {Save bill}           a button
 *   **bold**  *italic*  `code`
 *   [[excel|part 11]]     link to another part of help (#/help/excel)
 */

type Block =
  | { p: string } | { h: string } | { note: string } | { warn: string }
  | { steps: string[] } | { list: string[] }
  | { table: { head: string[]; rows: string[][] } };
interface Section { id: string; group: string; title: string; blocks: Block[] }

const TOKEN = /(\[\[[a-z-]+\|[^\]]+\]\]|\[[^\]]+\]|\{[^}]+\}|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

function Rich({ text }: { text: string }) {
  const parts = text.split(TOKEN).filter((s) => s !== '');
  return (
    <>
      {parts.map((s, i) => {
        if (s.startsWith('[[')) {
          const [id, label] = s.slice(2, -2).split('|');
          return <a key={i} href={`#/help/${id}`}>{label}</a>;
        }
        if (s.startsWith('[')) {
          const steps = s.slice(1, -1).split('>').map((x) => x.trim());
          return (
            <span key={i} className="help-path">
              {steps.map((x, j) => <Fragment key={j}>{j > 0 && <i aria-hidden="true">›</i>}<span>{x}</span></Fragment>)}
            </span>
          );
        }
        if (s.startsWith('{')) return <span key={i} className="help-btn">{s.slice(1, -1)}</span>;
        if (s.startsWith('**')) return <strong key={i}>{s.slice(2, -2)}</strong>;
        if (s.startsWith('*')) return <em key={i}>{s.slice(1, -1)}</em>;
        if (s.startsWith('`')) return <code key={i}>{s.slice(1, -1)}</code>;
        return <Fragment key={i}>{s}</Fragment>;
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }): ReactNode {
  if ('p' in b) return <p><Rich text={b.p} /></p>;
  if ('h' in b) return <h3>{b.h}</h3>;
  if ('note' in b) return <p className="help-note"><Rich text={b.note} /></p>;
  if ('warn' in b) return <p className="help-note warn"><Rich text={b.warn} /></p>;
  if ('steps' in b) return <ol>{b.steps.map((s, i) => <li key={i}><Rich text={s} /></li>)}</ol>;
  if ('list' in b) return <ul>{b.list.map((s, i) => <li key={i}><Rich text={s} /></li>)}</ul>;
  return (
    <div className="scroll-x help-table">
      <table className="grid compact">
        <thead><tr>{b.table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{b.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Rich text={c} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Plain text of a section, for searching (markup removed). */
const plain = (s: Section) => [s.title, ...s.blocks.flatMap((b) => Object.values(b).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flat() : [...v.head, ...v.rows.flat()])))]
  .join(' ').replace(/[[\]{}*`|>]/g, ' ').toLowerCase();

export function Help({ id }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const [find, setFind] = useState('');
  const sections = t('help.sections', { returnObjects: true }) as Section[];
  const groups = t('help.groups', { returnObjects: true }) as Record<string, string>;
  const index = useMemo(() => sections.map(plain), [sections, i18n.language]); // eslint-disable-line react-hooks/exhaustive-deps

  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = sections.filter((_, i) => words.every((w) => index[i]!.includes(w)));

  // #/help/<part> opens at that part
  useEffect(() => {
    if (id) document.getElementById(`help-${id}`)?.scrollIntoView({ block: 'start' });
  }, [id]);

  return (
    <div className="help-screen">
      <section className="page help-head">
        <div className="page-head"><h1>{t('help.title')}</h1></div>
        <p className="hint"><Rich text={t('help.lead')} /></p>
        <div className="field help-find">
          <label htmlFor="help-find">{t('help.find')}</label>
          <input id="help-find" type="search" value={find} placeholder={t('help.findPlaceholder')} autoComplete="off" onChange={(e) => setFind(e.target.value)} />
        </div>
      </section>

      <div className="help-body">
        <nav className="help-toc" aria-label={t('help.contents')}>
          {Object.entries(groups).map(([g, label]) => {
            const items = shown.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <h2>{label}</h2>
                <ol>
                  {items.map((s) => (
                    <li key={s.id}><a href={`#/help/${s.id}`}><b>{sections.indexOf(s) + 1}</b>{s.title}</a></li>
                  ))}
                </ol>
              </div>
            );
          })}
        </nav>

        <div className="help-parts">
          {shown.map((s) => (
            <section key={s.id} id={`help-${s.id}`} className="page help-part">
              <h2><span className="help-n" aria-label={t('help.part', { n: sections.indexOf(s) + 1 })}>{sections.indexOf(s) + 1}</span>{s.title}</h2>
              {s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
            </section>
          ))}
          {!shown.length && <p className="empty">{t('help.nothing')}</p>}
        </div>
      </div>
    </div>
  );
}
