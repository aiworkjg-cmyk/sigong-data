import crypto from 'crypto';
import fs from 'fs';
import type { Request } from 'express';
import type { FileKind } from '../src/types';

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${Number(value.toFixed(index === 0 ? 0 : decimals))} ${units[index]}`;
}

/** Short, unguessable, and readable enough to quote over the phone. */
export function generateSiteId(at: Date = new Date()): string {
  const date = at.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SITE-${date}-${suffix}`;
}

export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

export function classifyFile(mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'other';
}

/**
 * Best-effort client IP. App Service terminates TLS at the front end, so the
 * original address arrives in X-Forwarded-For rather than on the socket.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return (first || req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

/** Removes a staging directory without letting cleanup failures surface. */
export async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (err) {
    console.error(`[cleanup] ${target} 삭제 실패`, err);
  }
}

/**
 * Repairs a multipart filename.
 *
 * Busboy decodes the plain `filename="..."` parameter as latin1, so a UTF-8
 * name — which is what phones send for Korean photo names — arrives as
 * mojibake ("바닥.png" as "ë°ë¥.png"). Form *fields* are unaffected;
 * only filenames need this.
 *
 * The round trip is applied only when the latin1 bytes are in fact valid
 * UTF-8, so ASCII names and names the client sent in the RFC 5987 extended
 * form (which busboy already decodes correctly) are left untouched.
 */
export function decodeMultipartFilename(name: string): string {
  if (!name) return name;

  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  // A lossy decode inserts U+FFFD, meaning the bytes were not UTF-8 after all.
  return decoded.includes('�') ? name : decoded;
}

/** Trims and collapses whitespace; returns '' for null-ish input. */
export function cleanText(value: unknown, maxLength = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
