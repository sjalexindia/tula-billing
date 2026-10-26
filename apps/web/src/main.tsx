import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/noto-sans-tamil/400.css';
import '@fontsource/noto-sans-tamil/600.css';
import '@fontsource/noto-sans-tamil/700.css';
import './styles.css';
import './i18n';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The Android app's build starts with the phone start screen (Tula on the phone, or the shop computer).
// The condition is fixed at build time, so the shop computer's build does not include the phone code.
const PhoneStart = import.meta.env.MODE === 'phone' ? lazy(() => import('./local/PhoneStart').then((m) => ({ default: m.PhoneStart }))) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {PhoneStart ? <Suspense fallback={null}><PhoneStart /></Suspense> : <App />}
  </StrictMode>,
);
