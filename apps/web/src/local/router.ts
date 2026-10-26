import { errorReply, INTERNAL_ERROR } from '@tula/server/api';
import type { Handler, Reply, Req, Router } from '@tula/server/http';

/*
 * The phone app's stand-in for Fastify: the same routes (registerApi) answer requests made inside
 * the app, with no network. It implements only the Router contract in apps/server/src/http.ts:
 * ":param" path segments, an onRequest hook, status/header/send, JSON bodies, and the shared
 * error handling.
 */

export interface LocalRequest { method: string; url: string; headers?: Record<string, string>; body?: unknown }
export interface LocalResponse { status: number; headers: Record<string, string>; body: unknown }

interface Route { method: string; parts: string[]; handler: Handler }
type Hook = (req: Req, reply: Reply) => Promise<unknown>;

class LocalReply implements Reply {
  statusCode = 200;
  headers: Record<string, string> = {};
  sent = false;
  payload: unknown = undefined;
  status(code: number) { this.statusCode = code; return this; }
  header(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; }
  send(payload?: unknown) { this.payload = payload; this.sent = true; return this; }
}

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export class LocalRouter implements Router {
  private routes: Route[] = [];
  private hooks: Hook[] = [];

  private add(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  }
  get(path: string, handler: Handler) { this.add('GET', path, handler); }
  post(path: string, handler: Handler) { this.add('POST', path, handler); }
  put(path: string, handler: Handler) { this.add('PUT', path, handler); }
  delete(path: string, handler: Handler) { this.add('DELETE', path, handler); }
  addHook(_name: 'onRequest', hook: Hook) { this.hooks.push(hook); }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.parts.every((p, i) => {
        if (p.startsWith(':')) { params[p.slice(1)] = decodeURIComponent(parts[i]!); return true; }
        return p === parts[i];
      });
      if (ok) return { route, params };
    }
    return null;
  }

  async handle(r: LocalRequest): Promise<LocalResponse> {
    const method = r.method.toUpperCase();
    const [path = '', search = ''] = r.url.split('?');
    const reply = new LocalReply();
    const req: Req = {
      method,
      url: r.url,
      headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      params: {},
      query: parseQuery(search),
      body: r.body,
    };
    const done = (): LocalResponse => ({ status: reply.statusCode, headers: reply.headers, body: reply.payload });
    try {
      const found = this.match(method, path);
      for (const hook of this.hooks) {
        await hook(req, reply);
        if (reply.sent) return done();
      }
      if (!found) return { status: 404, headers: {}, body: { error: 'NOT_FOUND', message: `No route ${method} ${path}` } };
      req.params = found.params;
      const result = await found.route.handler(req, reply);
      if (!reply.sent) reply.send(result);
      return done();
    } catch (err) {
      const e = errorReply(err);
      if (e) return { status: e.status, headers: {}, body: e.body };
      console.error(err);
      return { status: 500, headers: {}, body: INTERNAL_ERROR };
    }
  }
}
