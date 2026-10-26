import type { SessionUser } from './auth';

/*
 * The part of Fastify the API routes use. Route modules are written against these types so the
 * same code runs on the shop computer (Fastify, see app.ts) and inside the phone app (an
 * in-process router, apps/web/src/local/router.ts). Use only what is declared here in route code;
 * anything else (static files, streams, the network address) belongs in the Node-only parts.
 */

export interface Req {
  method: string;
  /** path and query string, e.g. "/api/bills?from=2026-04-01" */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params: unknown;
  query: unknown;
  body: unknown;
  /** set by the auth hook for signed-in requests */
  user?: SessionUser;
}

export interface Reply {
  status(code: number): Reply;
  header(name: string, value: string): Reply;
  send(payload?: unknown): Reply;
}

export type Handler = (req: Req, reply: Reply) => unknown;

export interface Router {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  put(path: string, handler: Handler): unknown;
  delete(path: string, handler: Handler): unknown;
  /** runs before every route; a hook that sends a reply stops the request there */
  addHook(name: 'onRequest', hook: (req: Req, reply: Reply) => Promise<unknown>): unknown;
}
