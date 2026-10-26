import fastifyStatic from '@fastify/static';
import type { Db } from '@tula/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { scryptSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { errorReply, INTERNAL_ERROR, registerApi } from './api';
import { useScrypt, type SessionUser } from './auth';
import { localDeviceId } from './context';
import type { Router } from './http';
import { registerOps } from './ops';
import { registerSync } from './sync';

useScrypt((pin, salt, dkLen) => scryptSync(pin, salt, dkLen));

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

/** The shop computer's server: the shared API (api.ts) on Fastify, plus the Node-only parts. */
export async function buildApp(db: Db, opts: { webDist?: string; logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const deviceId = await localDeviceId(db);

  app.setErrorHandler((err, _req, reply) => {
    const r = errorReply(err);
    if (r) return reply.status(r.status).send(r.body);
    app.log.error(err);
    return reply.status(500).send(INTERNAL_ERROR);
  });

  // Fastify provides everything the Router contract (http.ts) declares.
  registerApi(app as unknown as Router, db, deviceId);
  registerOps(app, db, deviceId);
  registerSync(app, db, deviceId);

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'NOT_FOUND' }) : reply.sendFile('index.html')));
  }
  return app;
}
