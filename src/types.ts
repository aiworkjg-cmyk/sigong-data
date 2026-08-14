export interface SiteFile {
  id: string;
  originalName: string;
  fileType: 'image' | 'video' | 'other';
  mimeType: string;
  size: number;
  sizeFormatted: string;
  storagePath: string; // URL for download or preview
  thumbnailUrl?: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  errorMessage?: string;
  sharePointFilePath?: string;
}

export interface SiteRecord {
  id: string;
  managerName: string;
  address: string;
  constructionDate: string; // YYYY-MM-DD
  notes: string;
  createdAt: string; // ISO string
  status: 'COMPLETED' | 'UPLOADING' | 'FAILED' | 'PENDING';
  sharePointFolderPath: string;
  sharePointStatus: 'SYNCED' | 'TEST_MODE' | 'FAILED' | 'PENDING';
  sharePointDetails?: {
    siteId?: string;
    webUrl?: string;
    driveId?: string;
    message?: string;
    syncedAt?: string;
  };
  files: SiteFile[];
}

export interface UploadProgressItem {
  fileId: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  error?: string;
}

export interface SharePointConfigStatus {
  isLiveConfigured: boolean;
  tenantIdConfigured: boolean;
  clientIdConfigured: boolean;
  siteIdConfigured: boolean;
  driveIdConfigured: boolean;
  mode: 'LIVE' | 'TEST_MODE';
  rootFolder: string;
  message: string;
}
