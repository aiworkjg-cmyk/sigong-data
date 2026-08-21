import type { AssignableRole, Issue, Paged, SiteRecord, UploadLog } from '../../src/types';

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface SiteRepository {
  list(options?: ListOptions): Promise<Paged<SiteRecord>>;
  get(id: string): Promise<SiteRecord | null>;
  save(record: SiteRecord): Promise<void>;
  /**
   * Submissions that were accepted but never reached a terminal state — used on
   * boot to re-queue work that a restart interrupted mid-upload.
   */
  listUnfinished(limit?: number): Promise<SiteRecord[]>;
}

export interface UploadLogFilter extends ListOptions {
  /** Restrict to one outcome; omit for every attempt. */
  result?: UploadLog['result'];
  siteId?: string;
}

export interface UploadLogRepository {
  list(filter?: UploadLogFilter): Promise<Paged<UploadLog>>;
  append(log: UploadLog): Promise<void>;
  /** Aggregate counters for the admin dashboard. */
  summary(days: number): Promise<UploadLogSummary>;
}

export interface UploadLogSummary {
  days: number;
  total: number;
  success: number;
  partial: number;
  failed: number;
  totalBytes: number;
  fileCount: number;
}

export interface IssueFilter extends ListOptions {
  status?: Issue['status'];
  siteId?: string;
}

export interface IssueRepository {
  list(filter?: IssueFilter): Promise<Paged<Issue>>;
  get(id: string): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * An admin account held in the record backend. The master account is not stored
 * here — it comes from environment configuration and always exists, so losing
 * the table can never lock everyone out. passwordHash stays server-side.
 */
export interface StoredAdminUser {
  username: string;
  displayName: string;
  /** 관리자(ADMIN) or 일반(STAFF). Rows written before roles existed read as ADMIN. */
  role: AssignableRole;
  passwordHash: string;
  createdAt: string;
  createdBy: string;
  disabled: boolean;
  lastLoginAt?: string;
}

export interface AdminUserRepository {
  list(): Promise<StoredAdminUser[]>;
  get(username: string): Promise<StoredAdminUser | null>;
  save(user: StoredAdminUser): Promise<void>;
  remove(username: string): Promise<void>;
}

/**
 * Small key/value store for settings an admin can change at runtime, such as
 * the 시공종류 list. Values are opaque strings; the caller decides the encoding
 * (the 시공종류 list is stored as a JSON array).
 */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Submissions still awaiting (or retrying) their upload to the library. */
export interface PendingSubmission {
  siteId: string;
  attempts: number;
  nextAttemptAt: string;
}

export interface Repositories {
  sites: SiteRepository;
  logs: UploadLogRepository;
  issues: IssueRepository;
  admins: AdminUserRepository;
  settings: SettingsRepository;
  /** Which backend is actually in use, surfaced in the admin diagnostics. */
  backend: 'AZURE_TABLES' | 'LOCAL_JSON';
}

/**
 * Table Storage sorts rows by RowKey ascending. Prefixing keys with a
 * descending counter makes "newest first" the natural read order, so listing
 * recent activity never needs a full scan and sort.
 */
export function descendingKey(at: string | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  const safe = Number.isFinite(ms) ? ms : Date.now();
  const inverted = 9_999_999_999_999 - safe;
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${String(inverted).padStart(13, '0')}-${suffix}`;
}
