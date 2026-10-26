/*
 * Where this copy of the web app runs. The shop computer serves the normal build; the Android
 * app carries the phone build (vite build --mode phone), which can run Tula on the phone itself
 * (src/local). Everything that differs between the two is decided here.
 */

/** The Android app's build. Phone-only code is loaded only when this is true, so the shop build stays small. */
export const IS_PHONE = import.meta.env.MODE === 'phone';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let transport: Fetch = (url, init) => fetch(url, init);

/** Every /api call goes through here: the network on the shop computer, the in-app router on a phone working on its own. */
export const apiFetch: Fetch = (url, init) => transport(url, init);
export const setTransport = (f: Fetch) => { transport = f; };

/** True when Tula is running on this phone (not opened from a shop computer). Set by src/local/phone.ts. */
export let runsLocally = false;
export const setRunsLocally = (v: boolean) => { runsLocally = v; };
