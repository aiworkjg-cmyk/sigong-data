import type {
  AdminSession,
  AdminUser,
  AssignableRole,
  FolderEntry,
  Issue,
  IssuePriority,
  IssueStatus,
  Paged,
  PublicConfig,
  SharePointConfigStatus,
  SiteRecord,
  SubmissionStatus,
  Technician,
  UploadLog,
  ViewScope,
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

export const publicApi = {
  /** Selectable 시공종류 and upload limits, used to render the form. */
  config: () => request<PublicConfig>('/api/config'),

  /**
   * Filing happens after the response, so the confirmation screen polls this
   * to tell the submitter whether their files actually landed.
   */
  submissionStatus: (siteId: string) =>
    request<SubmissionStatus>(`/api/sites/${encodeURIComponent(siteId)}/status`),
};

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export interface Diagnostics {
  sharePoint: SharePointConfigStatus;
  connectivity: { ok: boolean; driveName?: string; webUrl?: string; error?: string } | null;
  recordBackend: 'AZURE_TABLES' | 'LOCAL_JSON';
  constructionTypes: string[];
  mail: { configured: boolean; sender: string; recipients: string[] };
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

  /* 시공현황 리스트 — every signed-in role; the server narrows the result. */

  history: (
    options: {
      constructionType?: string;
      technicianId?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) =>
    request<Paged<SiteRecord> & { scope: ViewScope; needsScope?: boolean }>(
      `/api/admin/history${query(options)}`
    ),

  historyFilters: () =>
    request<{ constructionTypes: string[]; technicians: Technician[]; scope: ViewScope }>(
      '/api/admin/history/filters'
    ),

  /* 시공기사 명부 */

  technicians: () =>
    request<{
      technicians: Technician[];
      /** 업체 this account may tag someone with — never wider than its own. */
      assignableTypes: string[];
      deleteRequestEmails: string[];
    }>('/api/admin/technicians'),

  addTechnician: (input: {
    name: string;
    title: string;
    constructionTypes?: string[];
    phone?: string;
    region?: string;
  }) =>
    request<{ technician: Technician; technicians: Technician[] }>('/api/admin/technicians', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateTechnician: (
    id: string,
    patch: {
      name?: string;
      title?: string;
      constructionTypes?: string[];
      phone?: string;
      region?: string;
    }
  ) =>
    request<{ technician: Technician; technicians: Technician[] }>(
      `/api/admin/technicians/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),

  /** Master only — others receive 403 and are shown the request-by-mail popup. */
  deleteTechnician: (id: string) =>
    request<{ technicians: Technician[] }>(`/api/admin/technicians/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /* 삭제 요청 수신 메일 — 여러 개 등록, 전원에게 발송 */

  deleteRequestEmails: () =>
    request<{ deleteRequestEmails: string[] }>('/api/admin/settings/delete-request-emails'),

  addDeleteRequestEmail: (email: string) =>
    request<{ deleteRequestEmails: string[] }>('/api/admin/settings/delete-request-emails', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  updateDeleteRequestEmail: (current: string, email: string) =>
    request<{ deleteRequestEmails: string[] }>(
      `/api/admin/settings/delete-request-emails/${encodeURIComponent(current)}`,
      { method: 'PATCH', body: JSON.stringify({ email }) }
    ),

  removeDeleteRequestEmail: (email: string) =>
    request<{ deleteRequestEmails: string[] }>(
      `/api/admin/settings/delete-request-emails/${encodeURIComponent(email)}`,
      { method: 'DELETE' }
    ),

  /* 폴더 생성 규칙 */

  folderRule: () =>
    request<{
      folderRule: { root: string; segments: string[] };
      example: string;
      availableTokens: { token: string; label: string; sample: string }[];
    }>('/api/admin/settings/folder-rule'),

  setFolderRule: (rule: { root: string; segments: string[] }) =>
    request<{ folderRule: { root: string; segments: string[] }; example: string }>(
      '/api/admin/settings/folder-rule',
      { method: 'PUT', body: JSON.stringify(rule) }
    ),

  /* Settings — readable by every admin, editable by 마스터. */

  constructionTypes: () =>
    request<{ constructionTypes: string[] }>('/api/admin/settings/construction-types'),

  addConstructionType: (name: string) =>
    request<{ constructionTypes: string[] }>('/api/admin/settings/construction-types', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  removeConstructionType: (name: string) =>
    request<{ constructionTypes: string[] }>(
      `/api/admin/settings/construction-types/${encodeURIComponent(name)}`,
      { method: 'DELETE' }
    ),

  /* Account management — master account only; others receive 403. */

  accounts: () => request<{ accounts: AdminUser[] }>('/api/admin/accounts'),

  createAccount: (input: {
    username: string;
    displayName: string;
    password: string;
    role: AssignableRole;
    constructionTypes?: string[];
    technicianId?: string;
  }) =>
    request<{ account: AdminUser; accounts: AdminUser[] }>('/api/admin/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateAccount: (
    username: string,
    patch: {
      disabled?: boolean;
      password?: string;
      role?: AssignableRole;
      constructionTypes?: string[];
      technicianId?: string;
    }
  ) =>
    request<{ accounts: AdminUser[] }>(`/api/admin/accounts/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteAccount: (username: string) =>
    request<{ accounts: AdminUser[] }>(`/api/admin/accounts/${encodeURIComponent(username)}`, {
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
