import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import type { AdminSession } from '../src/types';

const COOKIE_NAME = 'sigong_admin';
const SCRYPT_KEYLEN = 64;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminSession;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

/** Produces the `scrypt$<salt>$<hash>` string stored in ADMIN_PASSWORD_HASH. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Constant-time password check. Returns false rather than throwing on a
 * malformed stored hash so a bad App Setting cannot crash the login route.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    if (expected.length !== SCRYPT_KEYLEN) return false;

    const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Signed session cookie                                               */
/* ------------------------------------------------------------------ */

interface SessionPayload {
  u: string;
  exp: number;
}

function sign(data: string): string {
  return crypto
    .createHmac('sha256', config.admin.sessionSecret)
    .update(data)
    .digest('base64url');
}

function createToken(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verifies signature and expiry; any tampering yields null. */
function readToken(token: string): SessionPayload | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  // Compare as fixed-length digests to keep the check constant time.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return null;
    if (payload.u !== config.admin.username) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      jar[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[key] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

export function issueSession(res: Response): AdminSession {
  const expiresAt = Date.now() + config.admin.sessionHours * 3600 * 1000;
  const token = createToken({ u: config.admin.username, exp: expiresAt });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.admin.secureCookie,
    maxAge: config.admin.sessionHours * 3600 * 1000,
    path: '/',
  });

  return {
    username: config.admin.username,
    displayName: config.admin.displayName,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.admin.secureCookie,
    path: '/',
  });
}

export function readSession(req: Request): AdminSession | null {
  if (!config.admin.sessionSecret) return null;

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;

  const payload = readToken(token);
  if (!payload) return null;

  return {
    username: payload.u,
    displayName: config.admin.displayName,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

/** Rejects unauthenticated requests to every /api/admin route. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ error: '인증 필요', message: '관리자 로그인이 필요합니다.' });
    return;
  }
  req.admin = session;
  next();
}

/* ------------------------------------------------------------------ */
/* Login throttling                                                    */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// In-process only. With a single App Service instance this is sufficient; if
// the plan is ever scaled out, move this to Table Storage or Redis.
const attempts = new Map<string, { count: number; firstAt: number }>();

export function isLockedOut(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;

  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.delete(key);
    return 0;
  }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((entry.firstAt + LOCKOUT_MS - Date.now()) / 1000);
}

export function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}

/** Verifies a login attempt against the single configured admin account. */
export function authenticate(username: string, password: string): boolean {
  if (!config.admin.passwordHash) return false;

  const userBuf = Buffer.from(username || '');
  const expectedBuf = Buffer.from(config.admin.username);
  const userMatches =
    userBuf.length === expectedBuf.length && crypto.timingSafeEqual(userBuf, expectedBuf);

  // Always run the password KDF so a wrong username is not distinguishable by
  // response time from a wrong password.
  const passwordMatches = verifyPassword(password || '', config.admin.passwordHash);
  return userMatches && passwordMatches;
}
