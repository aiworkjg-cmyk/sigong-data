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
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

export type SyncMode = 'LIVE' | 'TEST_MODE';

/** One attachment queued for upload. Content is read from disk, not buffered. */
export interface PendingUpload {
  id: string;
  /** Name to use inside SharePoint (already sanitized by the caller). */
  fileName: string;
  /** Absolute path to the staged temp file. */
  filePath: string;
  fileType: string;
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
  managerName: string;
  address: string;
  constructionDate: string;
  notes: string;
  createdAt: string;
}
