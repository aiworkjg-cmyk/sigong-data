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
  status: 'completed' | 'failed';
  /** Path inside the document library, e.g. "시공현장자료/2026-08/.../첨부파일/01_a.jpg". */
  remotePath?: string;
  /** SharePoint web URL, when the live sync returned one. */
  webUrl?: string;
  errorMessage?: string;
}

export type SiteStatus = 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'PENDING';

export interface SiteRecord {
  id: string;
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
  files: SiteFile[];
}

export type UploadResult = 'SUCCESS' | 'PARTIAL' | 'FAILED';

/** One row per submission attempt — the admin audit trail. */
export interface UploadLog {
  id: string;
  at: string; // ISO
  siteId: string;
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

export interface AdminSession {
  username: string;
  displayName: string;
  /** ISO expiry of the signed session cookie. */
  expiresAt: string;
}

export interface Paged<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when the list is exhausted. */
  nextCursor?: string;
}
