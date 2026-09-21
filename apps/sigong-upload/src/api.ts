import type { SubmissionFieldKey, SubmissionFieldMeta } from './submission-layout';
import type {
  AdminSession,
  AdminUser,
  AssignableRole,
  ConstructionTypeConfig,
  FolderEntry,
  Issue,
  IssuePriority,
  IssueStatus,
  GoogleAccountView,
  GoogleSheetLink,
  ManualAuditEntry,
  MicrosoftAccountView,
  SheetSyncReport,
  Paged,
  PublicConfig,
  SharePointConfigStatus,
  SharePointStorageTarget,
  SiteRecord,
  SubmissionStatus,
  Technician,
  TeamsWebhookProfile,
  UploadLog,
  ViewScope,
  WorkOrder,
  WorkOrderSort,
  WorkOrderColumnMap,
  WorkOrderDraft,
  WorkOrderGroup,
  WorkOrderImportPreview,
  WorkOrderImportResult,
  WorkOrderSheetPreview,
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
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
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

  /** 시공종류별 대기 중인 현장 수. 제출 화면의 첫 단계입니다. */
  workOrderSummary: () =>
    request<{ summary: Array<{ constructionType: string; open: number }> }>(
      '/api/work-orders/summary'
    ),

  /**
   * 한 시공종류의 대기 현장을 날짜 → 지역으로 묶어서 가져옵니다.
   * 시공종류는 필수입니다 — 서버가 전체 목록 조회를 거부합니다.
   */
  /** 이 시공종류에 등록된 현장종류(주문서 시트 이름) 목록. */
  siteTypes: (constructionType: string) =>
    request<{ siteTypes: string[] }>(
      `/api/work-orders/site-types?constructionType=${encodeURIComponent(constructionType)}`
    ),

  workOrders: (query: {
    constructionType: string;
    siteType?: string;
    /** 비우면 모든 날짜를 봅니다 — 기사가 날짜를 아직 안 골랐을 때. */
    date?: string;
    search?: string;
  }) => {
    const params = new URLSearchParams({ constructionType: query.constructionType });
    for (const key of ['siteType', 'date', 'search'] as const) {
      const value = (query[key] ?? '').trim();
      if (value) params.set(key, value);
    }
    return request<{ groups: WorkOrderGroup[] }>(`/api/work-orders?${params.toString()}`);
  },
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
  storageStatus: () => request<{ backend: string; account: string; mailConfigured: boolean; sender: string }>('/api/admin/settings/storage-status'),
  importTechnicians: (file: File, confirm = false) => {
    const body = new FormData();
    body.append('file', file);
    body.append('confirm', String(confirm));
    return request<{ count: number; errors?: string[]; rows?: Array<{ name: string; title: string; constructionTypes: string[]; phone: string; region: string }>; technicians?: Technician[] }>('/api/admin/technicians/import', { method: 'POST', body });
  },
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

  /* Teams 알림 */

  teamsWebhook: () =>
    request<{ webhooks: TeamsWebhookProfile[] }>('/api/admin/settings/teams-webhook'),

  saveTeamsWebhook: (profile: Partial<TeamsWebhookProfile>) =>
    request<{ webhook: TeamsWebhookProfile; webhooks: TeamsWebhookProfile[] }>(
      profile.id ? `/api/admin/settings/teams-webhook/${encodeURIComponent(profile.id)}` : '/api/admin/settings/teams-webhook',
      { method: profile.id ? 'PUT' : 'POST', body: JSON.stringify(profile) }
    ),

  removeTeamsWebhook: (id: string) =>
    request<{ webhooks: TeamsWebhookProfile[] }>(
      `/api/admin/settings/teams-webhook/${encodeURIComponent(id)}`, { method: 'DELETE' }
    ),

  testTeamsWebhook: (url: string) =>
    request<{ success: boolean }>('/api/admin/settings/teams-webhook/test', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  /* 폴더 생성 규칙 */

  folderRule: () =>
    request<{
      folderRule: { root: string; segments: string[]; fileNameTemplate?: string };
      example: string;
      availableTokens: { token: string; label: string; sample: string }[];
      fileNameTokens: { token: string; label: string; sample: string }[];
      savedDefault: { root: string; segments: string[]; fileNameTemplate?: string } | null;
    }>('/api/admin/settings/folder-rule'),

  saveFolderRuleAsDefault: () =>
    request<{ savedDefault: { root: string; segments: string[]; fileNameTemplate?: string } | null }>(
      '/api/admin/settings/folder-rule/default',
      { method: 'POST' }
    ),

  setFolderRule: (rule: { root: string; segments: string[]; fileNameTemplate?: string }) =>
    request<{
      folderRule: { root: string; segments: string[]; fileNameTemplate?: string };
      example: string;
    }>(
      '/api/admin/settings/folder-rule',
      { method: 'PUT', body: JSON.stringify(rule) }
    ),

  submissionOrders: () =>
    request<{ orders: Record<string, SubmissionFieldKey[]>; fields: SubmissionFieldMeta[] }>(
      '/api/admin/settings/submission-order'
    ),

  setSubmissionOrder: (constructionType: string, order: SubmissionFieldKey[]) =>
    request<{ order: SubmissionFieldKey[] }>('/api/admin/settings/submission-order', {
      method: 'PUT',
      body: JSON.stringify({ constructionType, order }),
    }),

  constructionTypeConfigs: () =>
    request<{
      configs: ConstructionTypeConfig[];
      availableTokens: { token: string; label: string; sample: string }[];
    }>('/api/admin/settings/construction-type-configs'),

  setConstructionTypeConfig: (name: string, config: ConstructionTypeConfig) =>
    request<{ config: ConstructionTypeConfig }>(
      `/api/admin/settings/construction-type-configs/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(config) }
    ),

  /* Microsoft 업무 계정 */

  microsoftAccount: () => request<MicrosoftAccountView>('/api/admin/settings/microsoft'),

  startMicrosoftSignIn: () =>
    request<{ url: string; redirectUri: string }>('/api/admin/settings/microsoft/signin', {
      method: 'POST',
    }),

  signOutMicrosoft: () =>
    request<MicrosoftAccountView>('/api/admin/settings/microsoft', { method: 'DELETE' }),

  microsoftTeams: () =>
    request<{ teams: { id: string; displayName: string }[] }>(
      '/api/admin/settings/microsoft/teams'
    ),

  microsoftChannels: (teamId: string) =>
    request<{ channels: { id: string; displayName: string; membershipType?: string }[] }>(
      `/api/admin/settings/microsoft/teams?teamId=${encodeURIComponent(teamId)}`
    ),

  storageTargets: () =>
    request<{ targets: SharePointStorageTarget[]; activeTargetId: string }>('/api/admin/settings/storage-target'),

  connectStorageTarget: (input: { accountEmail?: string; teamName: string; channelName: string }) =>
    request<{
      target: SharePointStorageTarget;
      targets: SharePointStorageTarget[];
      activeTargetId: string;
      status: SharePointConfigStatus;
      channelWebUrl?: string;
    }>('/api/admin/settings/storage-target/resolve', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  testStorageTargetUpload: () =>
    request<{
      mode: 'LIVE';
      remotePath: string;
      webUrl?: string;
      target: SharePointStorageTarget;
    }>('/api/admin/settings/storage-target/test-upload', { method: 'POST' }),

  saveStorageTarget: (target: Partial<SharePointStorageTarget>) =>
    request<{ target: SharePointStorageTarget; targets: SharePointStorageTarget[]; activeTargetId: string }>(
      target.id ? `/api/admin/settings/storage-target/${encodeURIComponent(target.id)}` : '/api/admin/settings/storage-target',
      { method: target.id ? 'PUT' : 'POST', body: JSON.stringify(target) }
    ),

  selectStorageTarget: (id: string) =>
    request<{ target: SharePointStorageTarget; targets: SharePointStorageTarget[]; activeTargetId: string; status: SharePointConfigStatus }>(
      `/api/admin/settings/storage-target/${encodeURIComponent(id)}/select`, { method: 'POST' }
    ),

  removeStorageTarget: (id: string) =>
    request<{ targets: SharePointStorageTarget[]; activeTargetId: string }>(
      `/api/admin/settings/storage-target/${encodeURIComponent(id)}`, { method: 'DELETE' }
    ),

  /* 엑셀 내보내기 */

  /**
   * 화면에 보이는 목록을 그대로 보내 xlsx 를 받아 저장합니다.
   *
   * 응답이 JSON 이 아니라 파일이라 공용 request() 를 쓰지 않습니다.
   */
  exportRows: async (
    kind: 'sites' | 'logs' | 'manual-audit',
    rows: unknown[],
    caption: string
  ) => {
    const res = await fetch(`/api/admin/export/${kind}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, caption }),
    });
    if (!res.ok) {
      throw new Error('엑셀 파일을 만들지 못했습니다.');
    }

    const disposition = res.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    const name = encoded ? decodeURIComponent(encoded) : 'export.xlsx';

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 즉시 해제하면 일부 브라우저에서 저장이 끊깁니다.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  /**
   * 수동 변경 기록 엑셀.
   *
   * 다른 내보내기와 달리 화면이 줄을 보내지 않습니다 — 이건 감사 기록이라
   * 브라우저가 걸러 놓은 것이 아니라 파일에 남은 그대로여야 합니다.
   */
  exportManualAudit: () => adminApi.exportRows('manual-audit', [], ''),

  /** 앱을 거치지 않은 SharePoint 변경 기록. 업로드 로그와 별개입니다. */
  manualAudit: (limit = 500) =>
    request<{ entries: ManualAuditEntry[] }>(`/api/admin/manual-audit?limit=${limit}`),

  /* 주문서 · 시공현장 목록 */

  workOrders: (query: {
    constructionType?: string; status?: string; from?: string; to?: string;
    region?: string; search?: string; limit?: number; sort?: WorkOrderSort;
  } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString();
    return request<Paged<WorkOrder>>(`/api/admin/work-orders${suffix ? `?${suffix}` : ''}`);
  },

  workOrderSummary: () =>
    request<{ summary: Array<{ constructionType: string; open: number }> }>(
      '/api/admin/work-orders/summary'
    ),

  /** 등록된 주문에서 뽑은 현장종류. 수동입력 선택지로 씁니다. */
  workOrderSiteTypes: (constructionType = '') =>
    request<{ siteTypes: string[] }>(
      `/api/admin/work-orders/site-types${constructionType ? `?constructionType=${encodeURIComponent(constructionType)}` : ''}`
    ),

  /** Reads a 주문서 file without storing anything — the review step. */
  previewWorkOrderFile: (file: File, constructionType: string) => {
    const body = new FormData();
    body.append('file', file);
    body.append('constructionType', constructionType);
    return request<WorkOrderImportPreview>('/api/admin/work-orders/preview', {
      method: 'POST',
      body,
    });
  },

  remapWorkOrders: (input: {
    headers: string[]; rows: string[][]; mapping: WorkOrderColumnMap;
    constructionType: string; siteType: string;
  }) =>
    request<{ rows: WorkOrderDraft[] }>('/api/admin/work-orders/remap', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  importWorkOrders: (rows: WorkOrderDraft[], source: string) =>
    request<WorkOrderImportResult>('/api/admin/work-orders/import', {
      method: 'POST',
      body: JSON.stringify({ rows, source }),
    }),

  updateWorkOrder: (id: string, patch: Partial<WorkOrder>) =>
    request<{ order: WorkOrder }>(`/api/admin/work-orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  setWorkOrderStatus: (id: string, status: WorkOrder['status']) =>
    request<{ order: WorkOrder }>(`/api/admin/work-orders/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  removeWorkOrder: (id: string) =>
    request<{ success: boolean }>(`/api/admin/work-orders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  /* 구글 계정 · 시트 연동 */

  googleAccount: () => request<GoogleAccountView>('/api/admin/work-orders/google'),

  startGoogleSignIn: () =>
    request<{ url: string; redirectUri: string }>('/api/admin/work-orders/google/signin', {
      method: 'POST',
    }),

  signOutGoogle: () =>
    request<GoogleAccountView>('/api/admin/work-orders/google', { method: 'DELETE' }),

  saveGoogleServiceAccount: (key: string) =>
    request<GoogleAccountView>('/api/admin/work-orders/google/service-account', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  clearGoogleServiceAccount: () =>
    request<GoogleAccountView>('/api/admin/work-orders/google/service-account', {
      method: 'DELETE',
    }),


  sheetLinks: () =>
    request<{ links: GoogleSheetLink[]; ocrConfigured: boolean }>(
      '/api/admin/work-orders/sheets/links'
    ),

  previewSheet: (url: string, constructionType: string) =>
    request<{ sheets: WorkOrderSheetPreview[] }>('/api/admin/work-orders/sheets/preview', {
      method: 'POST',
      body: JSON.stringify({ url, constructionType }),
    }),

  saveSheetLink: (link: Partial<GoogleSheetLink>) =>
    request<{ link: GoogleSheetLink; links: GoogleSheetLink[] }>(
      '/api/admin/work-orders/sheets/links',
      { method: 'POST', body: JSON.stringify(link) }
    ),

  sheetReports: () =>
    request<{ reports: SheetSyncReport[] }>('/api/admin/work-orders/sheets/reports'),

  syncSheetLink: (id: string) =>
    request<{
      summary: string;
      report: SheetSyncReport;
      links: GoogleSheetLink[];
      reports: SheetSyncReport[];
    }>(
      `/api/admin/work-orders/sheets/links/${encodeURIComponent(id)}/sync`,
      { method: 'POST' }
    ),

  setSheetLinkEnabled: (id: string, enabled: boolean) =>
    request<{ link: GoogleSheetLink; links: GoogleSheetLink[] }>(
      `/api/admin/work-orders/sheets/links/${encodeURIComponent(id)}/enabled`,
      { method: 'POST', body: JSON.stringify({ enabled }) }
    ),

  removeSheetLink: (id: string) =>
    request<{ links: GoogleSheetLink[] }>(
      `/api/admin/work-orders/sheets/links/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
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
