/**
 * Domain types shared by the Express server and the React frontend.
 * The server imports these directly; keep them free of runtime dependencies.
 */

export type FileKind = 'image' | 'video' | 'other';
export type StorageMode = 'LIVE' | 'TEST_MODE';

/* ------------------------------------------------------------------ */
/* 시공기사 명부                                                        */
/* ------------------------------------------------------------------ */

export const TECHNICIAN_TITLES = ['팀장', '사수', '부사수'] as const;
export type TechnicianTitle = (typeof TECHNICIAN_TITLES)[number];

/** One person on the roster. Selected on the submission form, never typed. */
export interface Technician {
  id: string;
  name: string;
  title: TechnicianTitle;
  /**
   * 소속 업체 (시공종류). Optional and repeatable: a 업체 관계자 who also does
   * installs is tagged with their own 업체, while a freelancer shared across
   * brands can be left untagged.
   *
   * This is also the visibility boundary — a 업체 관리자 only ever sees the
   * roster entries carrying their own 업체.
   */
  constructionTypes: string[];
  /** 연락처 — optional. */
  phone?: string;
  /** 담당지역 — optional. */
  region?: string;
  createdAt: string;
  createdBy: string;
}

/**
 * The roster entries attached to a submission, copied at submission time.
 *
 * Held as a snapshot rather than a reference so renaming or promoting someone
 * later does not silently rewrite what past records say. The id is kept so a
 * 시공기사 account can still find its own history after a rename.
 */
export interface SiteTechnician {
  id: string;
  name: string;
  title: TechnicianTitle;
}

/** "홍길동(팀장), 김철수(사수)" — display and folder-name form. */
export function formatTechnicians(technicians: SiteTechnician[]): string {
  return technicians.map((tech) => `${tech.name}(${tech.title})`).join(', ');
}

export interface SiteFile {
  id: string;
  /** Name as the submitter had it on their device. */
  originalName: string;
  /** Sanitized, index-prefixed name actually written to SharePoint. */
  storedName: string;
  /**
   * The name multer actually gave the staged copy on disk.
   *
   * This is not always equal to storedName. Multer names each part as it
   * finishes, so with several files in flight the numbering it hands out can
   * differ from the order req.files ends up in — and the worker, which looked
   * for storedName on disk, silently dropped every file whose two names had
   * drifted apart. Recording the real name removes the guess.
   *
   * Optional because records written before this existed carry only storedName.
   */
  stagedName?: string;
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
  /** Roster entries chosen on the form. May hold several people. */
  technicians: SiteTechnician[];
  /** technicians rendered as one string — display, search, and folder token. */
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
 * Account roles.
 *
 *   MASTER   마스터관리자 — the single env-configured account. Sees every
 *                           company's data and holds every setting.
 *   COMPANY  관리자       — 업체 관계자 (백조 / 한샘 ...). Sees submissions for
 *                           the 시공종류 assigned to the account, and nothing else.
 *   TECH     시공기사     — linked to a roster entry; sees only the submissions
 *                           they were listed on.
 *
 * MASTER lives in environment configuration rather than the record store, so a
 * lost or corrupted table can never lock everyone out.
 */
export type AdminRole = 'MASTER' | 'COMPANY' | 'TECH';

/** Roles that can be handed out when creating an account. */
export const ASSIGNABLE_ROLES = ['COMPANY', 'TECH'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
  MASTER: '마스터관리자',
  COMPANY: '관리자',
  TECH: '시공기사',
};

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  MASTER: '모든 업체의 자료와 전체 설정',
  COMPANY: '담당 시공종류의 시공현황 전체 조회 · 기사 명부 관리',
  TECH: '본인이 참여한 시공 자료만 조회',
};

/** Only the master reaches the full admin console (로그·이슈·설정·계정). */
export function isMaster(role: AdminRole | undefined): boolean {
  return role === 'MASTER';
}

/** 마스터와 업체 관리자 — the two roles that manage the technician roster. */
export function canManageTechnicians(role: AdminRole | undefined): boolean {
  return role === 'MASTER' || role === 'COMPANY';
}

/** Only the master may delete roster entries; others must request by mail. */
export function canDeleteTechnicians(role: AdminRole | undefined): boolean {
  return role === 'MASTER';
}

export interface AdminSession {
  username: string;
  displayName: string;
  role: AdminRole;
  /** COMPANY: the 시공종류 this account may read. Empty for other roles. */
  constructionTypes: string[];
  /** TECH: the roster entry this account is. */
  technicianId?: string;
  /** ISO expiry of the signed session cookie. */
  expiresAt: string;
}

/** A stored account. The password hash never leaves the server. */
export interface AdminUser {
  username: string;
  displayName: string;
  role: AdminRole;
  /** COMPANY only — which 시공종류 the account may read. */
  constructionTypes: string[];
  /** TECH only — the roster entry this account is linked to. */
  technicianId?: string;
  createdAt: string;
  createdBy: string;
  disabled: boolean;
  lastLoginAt?: string;
}

/**
 * What a signed-in account is allowed to see in 시공현황 리스트.
 * Resolved on the server; the client never decides its own scope.
 */
export interface ViewScope {
  /** true for MASTER — no filtering at all. */
  all: boolean;
  constructionTypes: string[];
  technicianId?: string;
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
  /** Selectable roster for the submission form. */
  technicians: Technician[];
  maxFiles: number;
  maxFileSizeMb: number;
}

export interface Paged<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when the list is exhausted. */
  nextCursor?: string;
}
