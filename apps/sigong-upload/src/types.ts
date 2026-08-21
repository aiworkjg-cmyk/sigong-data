/**
 * Domain types shared by the Express server and the React frontend.
 * The server imports these directly; keep them free of runtime dependencies.
 */

export type FileKind = 'image' | 'video' | 'other';
export type StorageMode = 'LIVE' | 'TEST_MODE';

export interface SiteFile {
  id: string;
  /** Name as the submitter had it on their device. */
  originalName: string;
  /** Sanitized, index-prefixed name actually written to SharePoint. */
  storedName: string;
  fileType: FileKind;
  mimeType: string;
  size: number;
  sizeFormatted: string;
  /** pending = staged on the server, not yet written to the library. */
  status: 'pending' | 'completed' | 'failed';
  /** Path inside the document library, e.g. "시공현장자료/2026-08/.../첨부파일/01_a.jpg". */
  remotePath?: string;
  /** SharePoint web URL, when the live sync returned one. */
  webUrl?: string;
  errorMessage?: string;
}

/**
 * Submissions are accepted before they are filed, so the record moves through
 * QUEUED -> PROCESSING -> a terminal state while the submitter is already gone.
 */
export type SiteStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

/** A terminal state means the background worker is finished with the record. */
export const TERMINAL_STATUSES: SiteStatus[] = ['COMPLETED', 'PARTIAL', 'FAILED'];

export interface SiteRecord {
  id: string;
  /** Product line, chosen from the configured list (백조 / 인덕션 / ...). */
  constructionType: string;
  managerName: string;
  address: string;
  constructionDate: string; // YYYY-MM-DD
  notes: string;
  createdAt: string; // ISO
  status: SiteStatus;
  storageMode: StorageMode;
  /** Classification folder the submission was filed under. */
  folderPath: string;
  attachmentsFolderPath: string;
  webUrl?: string;
  syncMessage?: string;
  syncedAt?: string;
  /** Set while attachments remain staged on disk awaiting a retry. */
  retryAvailable?: boolean;
  /** How many times the background worker has attempted this submission. */
  attempts?: number;
  files: SiteFile[];
}

export type UploadResult = 'SUCCESS' | 'PARTIAL' | 'FAILED';

/** One row per submission attempt — the admin audit trail. */
export interface UploadLog {
  id: string;
  at: string; // ISO
  siteId: string;
  constructionType: string;
  managerName: string;
  address: string;
  fileCount: number;
  totalBytes: number;
  durationMs: number;
  result: UploadResult;
  mode: StorageMode;
  folderPath: string;
  message: string;
  clientIp: string;
  userAgent: string;
  errors: string[];
}

export type IssueStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
export type IssuePriority = 'LOW' | 'NORMAL' | 'HIGH';

export interface IssueComment {
  id: string;
  at: string;
  author: string;
  body: string;
}

export interface Issue {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Optional link to the submission the issue is about. */
  siteId?: string;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  author: string;
  comments: IssueComment[];
}

export interface FolderRuleView {
  root: string;
  segments: string[];
  attachmentsFolder: string | null;
  metadataFileName: string | null;
  maxSegmentLength: number;
}

export interface SharePointConfigStatus {
  isLiveConfigured: boolean;
  mode: StorageMode;
  tenantIdConfigured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  siteIdConfigured: boolean;
  driveIdConfigured: boolean;
  rootFolder: string;
  folderRule: FolderRuleView;
  examplePath: string;
  message: string;
}

export interface FolderEntry {
  name: string;
  type: 'folder' | 'file';
  size?: number;
  webUrl?: string;
}

/** Client-side per-file progress for the upload modal. */
export interface UploadProgressItem {
  fileId: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  error?: string;
}

/**
 * MASTER is the single env-configured account: it can manage other admins and
 * cannot be deleted. ADMIN and STAFF accounts are stored in the record backend.
 *
 *   MASTER  마스터 — everything, including account management
 *   ADMIN   관리자 — everything except account management
 *   STAFF   일반   — read-only: can look, cannot change anything
 */
export type AdminRole = 'MASTER' | 'ADMIN' | 'STAFF';

/** Roles the master can hand out when creating an account. */
export const ASSIGNABLE_ROLES = ['ADMIN', 'STAFF'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
  MASTER: '마스터',
  ADMIN: '관리자',
  STAFF: '일반',
};

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  MASTER: '모든 기능 + 계정 관리',
  ADMIN: '자료·이슈·설정 변경 가능 (계정 관리 불가)',
  STAFF: '조회만 가능 (변경 불가)',
};

/** Roles allowed to change data: retry uploads, edit issues, edit settings. */
export function canEdit(role: AdminRole | undefined): boolean {
  return role === 'MASTER' || role === 'ADMIN';
}

export interface AdminSession {
  username: string;
  displayName: string;
  role: AdminRole;
  /** ISO expiry of the signed session cookie. */
  expiresAt: string;
}

/** An additional admin account. The password hash never leaves the server. */
export interface AdminUser {
  username: string;
  displayName: string;
  role: AdminRole;
  createdAt: string;
  createdBy: string;
  disabled: boolean;
  lastLoginAt?: string;
}

/** Public-facing progress for the submitter's confirmation screen. */
export interface SubmissionStatus {
  id: string;
  status: SiteStatus;
  totalFiles: number;
  storedFiles: number;
  message: string;
}

export interface PublicConfig {
  mode: StorageMode;
  constructionTypes: string[];
  maxFiles: number;
  maxFileSizeMb: number;
}

export interface Paged<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when the list is exhausted. */
  nextCursor?: string;
}
