import type { ReactNode } from 'react';

/** Label + control + optional hint, laid out by the .form-grid / .field styles. */
export function Field({ id, label, children, wide, hint }: { id: string; label: string; children: ReactNode; wide?: boolean; hint?: string }) {
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
