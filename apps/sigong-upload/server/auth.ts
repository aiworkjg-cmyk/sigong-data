import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from './config';
import { canManageTechnicians } from '../src/types';
import type { AdminRole, AdminSession } from '../src/types';

const COOKIE_NAME = 'sigong_admin';
const SCRYPT_KEYLEN = 64;
const ROLES: AdminRole[] = ['MASTER', 'COMPANY', 'TECH'];

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

/** Produces the `scrypt$<salt>$<hash>` string stored for an account. */
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
  r: AdminRole;
  exp: number;
}

function sign(data: string): string {
  return crypto.createHmac('sha256', config.admin.sessionSecret).update(data).digest('base64url');
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
    if (!payload.u || !ROLES.includes(payload.r)) return null;
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

/**
 * Note the cookie carries only the username, role and expiry — never the
 * account's scope. The scope is re-read from the store on every request, so
 * revoking a company's access takes effect at once instead of when the cookie
 * happens to expire.
 */
export function issueSession(
  res: Response,
  admin: {
    username: string;
    displayName: string;
    role: AdminRole;
    constructionTypes: string[];
    technicianId?: string;
  }
): AdminSession {
  const expiresAt = Date.now() + config.admin.sessionHours * 3600 * 1000;
  const body = Buffer.from(
    JSON.stringify({ u: admin.username, r: admin.role, exp: expiresAt })
  ).toString('base64url');

  res.cookie(COOKIE_NAME, `${body}.${sign(body)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.admin.secureCookie,
    maxAge: config.admin.sessionHours * 3600 * 1000,
    path: '/',
  });

  return {
    username: admin.username,
    displayName: admin.displayName,
    role: admin.role,
    constructionTypes: admin.constructionTypes,
    technicianId: admin.technicianId,
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

/** Reads the cookie only — does not confirm the account still exists. */
export function readSessionToken(
  req: Request
): { username: string; role: AdminRole; expiresAt: string } | null {
  if (!config.admin.sessionSecret) return null;

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;

  const payload = readToken(token);
  if (!payload) return null;

  return {
    username: payload.u,
    role: payload.r,
    expiresAt: new Date(payload.exp).toISOString(),
  };
}

/** Directory lookup used to confirm a session's account is still active. */
export interface SessionResolver {
  resolveActive(username: string): Promise<{
    username: string;
    displayName: string;
    role: AdminRole;
    constructionTypes: string[];
    technicianId?: string;
  } | null>;
}

/**
 * Resolves the session and confirms the account is still enabled, so disabling
 * or deleting an admin takes effect without waiting for the cookie to expire.
 */
export async function resolveSession(
  req: Request,
  directory: SessionResolver
): Promise<AdminSession | null> {
  const token = readSessionToken(req);
  if (!token) return null;

  const active = await directory.resolveActive(token.username);
  if (!active) return null;

  return {
    username: active.username,
    displayName: active.displayName,
    role: active.role,
    constructionTypes: active.constructionTypes,
    technicianId: active.technicianId,
    expiresAt: token.expiresAt,
  };
}

/** Rejects unauthenticated requests to every /api/admin route. */
export function requireAdmin(directory: SessionResolver): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    resolveSession(req, directory)
      .then((session) => {
        if (!session) {
          res.status(401).json({ error: '인증 필요', message: '관리자 로그인이 필요합니다.' });
          return;
        }
        req.admin = session;
        next();
      })
      .catch(next);
  };
}

/** Restricts account-management routes to the master account. */
export function requireMaster(req: Request, res: Response, next: NextFunction): void {
  if (req.admin?.role !== 'MASTER') {
    res.status(403).json({
      error: '권한 없음',
      message: '계정 관리는 마스터 관리자만 사용할 수 있습니다.',
    });
    return;
  }
  next();
}

/**
 * Allows 마스터 and 업체 관리자 through — the two roles that maintain the
 * technician roster and issue 시공기사 logins. The UI hides these controls from
 * a 시공기사, and this is the check that actually enforces it.
 */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (!canManageTechnicians(req.admin?.role)) {
    res.status(403).json({
      error: '권한 없음',
      message: '시공기사 계정은 조회만 가능합니다. 관리자에게 문의해 주세요.',
    });
    return;
  }
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
