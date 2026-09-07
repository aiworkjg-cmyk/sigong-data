export interface SharePointCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Graph site id. Used when driveId is absent to target the default library. */
  siteId: string;
  /** Explicit document-library drive id. Takes precedence over siteId. */
  driveId: string;
}

export interface DriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  parentReference?: { driveId?: string; id?: string; path?: string };
  root?: Record<string, never>;
  sharepointIds?: {
    siteId?: string;
    webId?: string;
    siteUrl?: string;
  };
  deleted?: { state?: string };
  /** 삭제 델타에 남아 있으면 누가 마지막으로 손댔는지 알 수 있습니다. */
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

/** Result of resolving human-readable Microsoft 365 names to Graph identifiers. */
export interface ResolvedTeamsStorageTarget {
  accountEmail: string;
  teamName: string;
  channelName: string;
  teamId: string;
  channelId: string;
  siteId: string;
  driveId: string;
  /** Empty when Graph reports that the channel stores files at the drive root. */
  channelFolder: string;
  webUrl?: string;
}

export interface ManualReconcileResult {
  /** Files created inside eligible site folders during this scan window. */
  examined: number;
  /** Previously unmanaged files renamed to the active naming rule. */
  renamed: number;
  /** Metadata and files that already followed the rule. */
  skipped: number;
  /** Rename attempts that failed. A failed scan must not advance its cursor. */
  failed: Array<{ path: string; error: string }>;
  /**
   * 이 창에서 사라진 파일.
   *
   * Graph 변경 추적은 삭제도 알려 줍니다. 다만 "누가" 지웠는지는 알려 주지
   * 않습니다 — 삭제된 항목에는 마지막 수정자가 남아 있을 때도, 없을 때도
   * 있습니다. 있는 만큼만 담고, 없으면 비워 둡니다.
   */
  deleted: Array<{ id: string; name: string; path: string; by: string }>;
  /** 이번에 이름을 바꾼 파일. 감사 기록에 그대로 남습니다. */
  renamedItems: Array<{ id: string; name: string; path: string; by: string }>;
  /** Persist only after every rename succeeds; it is the next delta checkpoint. */
  nextCursor: string;
}

export type SyncMode = 'LIVE' | 'TEST_MODE';

/** One attachment queued for upload. Content is read from disk, not buffered. */
export interface PendingUpload {
  id: string;
  /** Name to use inside SharePoint (already sanitized by the caller). */
  fileName: string;
  /** Absolute path to the staged temp file. */
  filePath: string;
  /** 이미지·동영상 구분이 파일 이름의 접두사가 되므로 값이 정해져 있어야 합니다. */
  fileType: 'image' | 'video' | 'other';
  size: number;
}

export interface SyncedFileResult {
  id: string;
  fileName: string;
  remotePath: string;
  webUrl?: string;
}

export interface SyncResult {
  success: boolean;
  mode: SyncMode;
  folderPath: string;
  attachmentsFolderPath: string;
  webUrl?: string;
  message: string;
  syncedFiles: SyncedFileResult[];
  failedFiles: Array<{ id: string; fileName: string; error: string }>;
  durationMs: number;
}

export interface SiteSubmission {
  id: string;
  /** Product line the work belongs to, e.g. 백조 / 인덕션. */
  constructionType: string;
  siteType?: string;
  customerName?: string;
  customFields?: Array<{ id: string; label: string; token: string; value: string }>;
  managerName: string;
  address: string;
  constructionDate: string;
  notes: string;
  createdAt: string;
}
