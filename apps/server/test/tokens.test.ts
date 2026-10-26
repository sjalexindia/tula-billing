import { describe, expect, it } from 'vitest';
import { tokenExpiry } from '../src/sync/hub';

/* Reading when a Turso access token runs out (its exp claim), for the Devices screen. */

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: object) => `${b64url({ alg: 'EdDSA', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJl`;

describe('token expiry', () => {
  it('reads the exp claim of a token made with --expiration', () => {
    expect(tokenExpiry(jwt({ a: 'rw', exp: 1798761600, id: 'x' }))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is null for a token that never expires, no token, or something unreadable', () => {
    expect(tokenExpiry(jwt({ a: 'rw', id: 'x' }))).toBeNull();
    expect(tokenExpiry(undefined)).toBeNull();
    expect(tokenExpiry('not-a-jwt')).toBeNull();
    expect(tokenExpiry('a.!!!.c')).toBeNull();
  });
});
