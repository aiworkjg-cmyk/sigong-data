import type {
  AdminSession,
  FolderEntry,
  Issue,
  IssuePriority,
  IssueStatus,
  Paged,
  SharePointConfigStatus,
  SiteRecord,
  UploadLog,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    // Session cookie must ride along on every admin call.
    credentials: 'same-origin',
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new ApiError(detail?.message || detail?.error || `요청 실패 (${res.status})`, res.status);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

export interface PublicStatus {
  mode: 'LIVE' | 'TEST_MODE';
  rootFolder: string;
  message: string;
  maxFiles: number;
  maxFileSizeMb: number;
}

export const publicApi = {
  status: () => request<PublicStatus>('/api/status'),
};

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export interface Diagnostics {
  sharePoint: SharePointConfigStatus;
  connectivity: { ok: boolean; driveName?: string; webUrl?: string; error?: string } | null;
  recordBackend: 'AZURE_TABLES' | 'LOCAL_JSON';
  warnings: string[];
}

export const adminApi = {
  /** Resolves to null when nobody is logged in (not an error). */
  session: () => request<{ session: AdminSession | null }>('/api/admin/session'),

  login: (username: string, password: string) =>
    request<{ session: AdminSession }>('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ success: boolean }>('/api/admin/logout', { method: 'POST' }),

  diagnostics: () => request<Diagnostics>('/api/admin/diagnostics'),

  folders: (path: string) =>
    request<{ path: string; entries: FolderEntry[] }>(`/api/admin/folders${query({ path })}`),

  sites: (options: { limit?: number; cursor?: string } = {}) =>
    request<Paged<SiteRecord>>(`/api/admin/sites${query(options)}`),

  site: (id: string) => request<{ site: SiteRecord }>(`/api/admin/sites/${encodeURIComponent(id)}`),

  retrySite: (id: string) =>
    request<{ site: SiteRecord }>(`/api/admin/sites/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }),

  logs: (options: { result?: string; siteId?: string; limit?: number; cursor?: string } = {}) =>
    request<Paged<UploadLog>>(`/api/admin/logs${query(options)}`),

  logSummary: (days = 30) =>
    request<{
      days: number;
      total: number;
      success: number;
      partial: number;
      failed: number;
      totalBytes: number;
      fileCount: number;
    }>(`/api/admin/logs/summary${query({ days })}`),

  issues: (options: { status?: IssueStatus; siteId?: string; limit?: number; cursor?: string } = {}) =>
    request<Paged<Issue>>(`/api/admin/issues${query(options)}`),

  createIssue: (input: { title: string; body: string; siteId?: string; priority: IssuePriority }) =>
    request<{ issue: Issue }>('/api/admin/issues', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateIssue: (id: string, patch: Partial<Pick<Issue, 'status' | 'priority' | 'title' | 'body'>>) =>
    request<{ issue: Issue }>(`/api/admin/issues/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  commentOnIssue: (id: string, body: string) =>
    request<{ issue: Issue }>(`/api/admin/issues/${encodeURIComponent(id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),

  deleteIssue: (id: string) =>
    request<{ success: boolean }>(`/api/admin/issues/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

/**
 * Admin-only streaming URL for one attachment. The server proxies it out of
 * SharePoint, so files are never exposed to unauthenticated visitors.
 */
export function fileContentUrl(siteId: string, fileId: string): string {
  return `/api/admin/sites/${encodeURIComponent(siteId)}/files/${encodeURIComponent(fileId)}/content`;
}
