import { useTranslation } from 'react-i18next';

/** Shown for a screen that is still being built. */
export function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <section className="page">
      <div className="page-head"><h1>{t(title)}</h1></div>
      <p className="empty">{t('common.comingSoon')}</p>
    </section>
  );
}
