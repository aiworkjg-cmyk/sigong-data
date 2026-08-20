import type { Issue, Paged, SiteRecord, UploadLog } from '../../src/types';

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface SiteRepository {
  list(options?: ListOptions): Promise<Paged<SiteRecord>>;
  get(id: string): Promise<SiteRecord | null>;
  save(record: SiteRecord): Promise<void>;
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

export interface Repositories {
  sites: SiteRepository;
  logs: UploadLogRepository;
  issues: IssueRepository;
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
