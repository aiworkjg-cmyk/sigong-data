import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export interface SharePointFolderInfo {
  rootFolder: string;
  monthFolder: string;
  siteFolder: string;
  fullFolderPath: string;
  metadataFilePath: string;
  attachmentsFolderPath: string;
}

export function sanitizeFolderName(name: string): string {
  if (!name) return '미지정';
  // Remove special characters forbidden in Windows / SharePoint folders: \ / : * ? " < > |
  return name
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50); // limit reasonable length for folder name
}

export function generateSharePointFolderPath(
  constructionDate: string,
  address: string,
  managerName: string
): SharePointFolderInfo {
  const rootFolder = '시공현장자료';

  // Format month YYYY-MM
  let monthFolder = '2026-08';
  if (constructionDate && /^\d{4}-\d{2}/.test(constructionDate)) {
    monthFolder = constructionDate.substring(0, 7);
  } else {
    const now = new Date();
    monthFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Sanitize address short identifier (take first part or meaningful address)
  const cleanAddr = sanitizeFolderName(address || '현장주소');
  const cleanManager = sanitizeFolderName(managerName || '담당자');
  const cleanDate = constructionDate || '날짜미지정';

  const siteFolder = `${cleanDate}_${cleanAddr}_${cleanManager}`;
  const fullFolderPath = `${rootFolder}/${monthFolder}/${siteFolder}`;

  return {
    rootFolder,
    monthFolder,
    siteFolder,
    fullFolderPath,
    metadataFilePath: `${fullFolderPath}/현장정보.json`,
    attachmentsFolderPath: `${fullFolderPath}/첨부파일`,
  };
}

export interface SharePointSyncResult {
  success: boolean;
  mode: 'LIVE' | 'TEST_MODE';
  folderPath: string;
  webUrl?: string;
  message: string;
  syncedFiles: string[];
  errors?: string[];
}

// Graph API path-segment safe encoding: encodeURIComponent() alone would also
// escape '/', which breaks colon-style path addressing (root:/A/B/C:/content).
// Each segment must be encoded individually and rejoined with literal slashes.
function encodeGraphPath(itemPath: string): string {
  return itemPath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

// Simple PUT upload only supports files up to 4MB; anything larger must use
// a resumable upload session in byte-range chunks.
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
// Must be a multiple of 320 KiB (327,680 bytes) per Graph API requirements.
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

export class SharePointService {
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private siteId: string;
  private driveId: string;

  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.tenantId = process.env.SHAREPOINT_TENANT_ID || '';
    this.clientId = process.env.SHAREPOINT_CLIENT_ID || '';
    this.clientSecret = process.env.SHAREPOINT_CLIENT_SECRET || '';
    this.siteId = process.env.SHAREPOINT_SITE_ID || '';
    this.driveId = process.env.SHAREPOINT_DRIVE_ID || '';
  }

  public isLiveConfigured(): boolean {
    return Boolean(
      this.tenantId &&
      this.clientId &&
      this.clientSecret &&
      (this.siteId || this.driveId)
    );
  }

  public getConfigStatus() {
    return {
      isLiveConfigured: this.isLiveConfigured(),
      tenantIdConfigured: Boolean(this.tenantId),
      clientIdConfigured: Boolean(this.clientId),
      siteIdConfigured: Boolean(this.siteId),
      driveIdConfigured: Boolean(this.driveId),
      mode: this.isLiveConfigured() ? 'LIVE' : 'TEST_MODE',
      rootFolder: '시공현장자료',
      message: this.isLiveConfigured()
        ? 'Microsoft SharePoint 실제 연동 모드로 동작 중입니다.'
        : '테스트용 저장 모드로 동작 중입니다. (SharePoint 연결 정보가 등록되면 자동 전환됩니다.)'
    };
  }

  // Resolves the Graph API drive base URL. Prefers an explicit Drive ID; if
  // only a Site ID is configured (the common case for a Teams channel's
  // SharePoint site), addresses the site's default document library drive
  // directly instead of guessing a drive ID.
  private getDriveBase(): string {
    if (this.driveId) {
      return `https://graph.microsoft.com/v1.0/drives/${this.driveId}`;
    }
    return `https://graph.microsoft.com/v1.0/sites/${this.siteId}/drive`;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.isLiveConfigured()) {
      throw new Error('SharePoint API credentials are not configured');
    }

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('grant_type', 'client_credentials');

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to acquire Microsoft Graph token: ${res.status} ${errText}`);
    }

    const data = await res.json();
    this.cachedToken = data.access_token;
    // Refresh a minute early to avoid using a token that expires mid-request.
    this.tokenExpiresAt = Date.now() + (Math.max(data.expires_in - 60, 60)) * 1000;
    return this.cachedToken as string;
  }

  // Creates every missing folder segment along folderPath (idempotent: an
  // already-existing folder is treated as success, not an error). Returns
  // the driveItem for the final (deepest) segment so callers can surface its
  // webUrl.
  private async ensureFolderPath(base: string, accessToken: string, folderPath: string): Promise<any> {
    const segments = folderPath.split('/').filter(Boolean);
    let currentPath = '';
    let lastItem: any = null;

    for (const segment of segments) {
      const childrenUrl = currentPath
        ? `${base}/root:/${encodeGraphPath(currentPath)}:/children`
        : `${base}/root/children`;

      const res = await fetch(childrenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: segment,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }),
      });

      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (res.ok) {
        lastItem = await res.json();
      } else if (res.status === 409) {
        // Folder already exists — fetch it so we still have its webUrl.
        const existingRes = await fetch(`${base}/root:/${encodeGraphPath(currentPath)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        lastItem = existingRes.ok ? await existingRes.json() : null;
      } else {
        const errText = await res.text();
        throw new Error(`SharePoint 폴더 생성 실패 (${segment}): ${res.status} ${errText}`);
      }
    }

    return lastItem;
  }

  private async uploadSmallFile(
    base: string,
    accessToken: string,
    remotePath: string,
    content: Buffer | string,
    contentType: string
  ): Promise<any> {
    const url = `${base}/root:/${encodeGraphPath(remotePath)}:/content`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType,
      },
      body: content as any,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`파일 업로드 실패 (${remotePath}): ${res.status} ${errText}`);
    }

    return res.json();
  }

  // Uploads files larger than SIMPLE_UPLOAD_MAX_BYTES using a resumable
  // upload session in Graph-required byte-range chunks.
  private async uploadLargeFile(
    base: string,
    accessToken: string,
    remotePath: string,
    buffer: Buffer
  ): Promise<any> {
    const sessionUrl = `${base}/root:/${encodeGraphPath(remotePath)}:/createUploadSession`;
    const sessionRes = await fetch(sessionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item: { '@microsoft.graph.conflictBehavior': 'replace' },
      }),
    });

    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      throw new Error(`업로드 세션 생성 실패 (${remotePath}): ${sessionRes.status} ${errText}`);
    }

    const session = await sessionRes.json();
    const uploadUrl = session.uploadUrl as string;
    const total = buffer.length;
    let lastResponseBody: any = null;

    for (let start = 0; start < total; start += UPLOAD_CHUNK_SIZE) {
      const end = Math.min(start + UPLOAD_CHUNK_SIZE, total) - 1;
      const chunk = buffer.subarray(start, end + 1);

      // NOTE: the upload session URL is pre-authenticated; do not send an
      // Authorization header on chunk requests (Graph API requirement).
      const chunkRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: chunk,
      });

      if (!chunkRes.ok) {
        const errText = await chunkRes.text();
        throw new Error(`대용량 파일 업로드 실패 (${remotePath}, byte ${start}): ${chunkRes.status} ${errText}`);
      }

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        lastResponseBody = await chunkRes.json();
      }
    }

    return lastResponseBody;
  }

  private async uploadFile(
    base: string,
    accessToken: string,
    remotePath: string,
    filePath: string
  ): Promise<any> {
    const stat = fs.statSync(filePath);
    if (stat.size >= SIMPLE_UPLOAD_MAX_BYTES) {
      const buffer = fs.readFileSync(filePath);
      return this.uploadLargeFile(base, accessToken, remotePath, buffer);
    }
    const buffer = fs.readFileSync(filePath);
    return this.uploadSmallFile(base, accessToken, remotePath, buffer, 'application/octet-stream');
  }

  public async syncSiteToSharePoint(
    siteRecord: {
      id: string;
      managerName: string;
      address: string;
      constructionDate: string;
      notes: string;
      createdAt: string;
      sharePointFolderPath: string;
    },
    files: Array<{
      id: string;
      originalName: string;
      filePath: string;
      fileType: string;
      size: number;
    }>
  ): Promise<SharePointSyncResult> {
    const folderInfo = generateSharePointFolderPath(
      siteRecord.constructionDate,
      siteRecord.address,
      siteRecord.managerName
    );

    // If LIVE mode
    if (this.isLiveConfigured()) {
      try {
        const base = this.getDriveBase();
        const accessToken = await this.getAccessToken();
        const syncedFiles: string[] = [];

        // 1. Create the classification folder hierarchy: 시공현장자료 / YYYY-MM / 현장폴더 / 첨부파일
        const siteFolderItem = await this.ensureFolderPath(base, accessToken, folderInfo.fullFolderPath);
        await this.ensureFolderPath(base, accessToken, folderInfo.attachmentsFolderPath);

        // 2. Upload Metadata JSON to SharePoint
        const metadataContent = JSON.stringify(
          {
            현장고유ID: siteRecord.id,
            담당자: siteRecord.managerName,
            주소: siteRecord.address,
            시공일: siteRecord.constructionDate,
            특이사항: siteRecord.notes,
            제출일: siteRecord.createdAt,
            첨부파일수: files.length,
            SharePoint저장경로: folderInfo.fullFolderPath,
            파일목록: files.map((f) => ({
              파일명: f.originalName,
              파일크기: f.size,
              유형: f.fileType,
            })),
          },
          null,
          2
        );

        await this.uploadSmallFile(
          base,
          accessToken,
          `${folderInfo.fullFolderPath}/현장정보.json`,
          metadataContent,
          'application/json'
        );
        syncedFiles.push('현장정보.json');

        // 3. Upload Attachments (auto-routed to chunked upload when >4MB)
        const errors: string[] = [];
        for (const file of files) {
          if (!fs.existsSync(file.filePath)) continue;
          try {
            await this.uploadFile(
              base,
              accessToken,
              `${folderInfo.attachmentsFolderPath}/${file.originalName}`,
              file.filePath
            );
            syncedFiles.push(file.originalName);
          } catch (fileErr: any) {
            errors.push(`${file.originalName}: ${fileErr.message || String(fileErr)}`);
          }
        }

        const allFilesSynced = errors.length === 0;

        return {
          success: allFilesSynced,
          mode: 'LIVE',
          folderPath: folderInfo.fullFolderPath,
          webUrl: siteFolderItem?.webUrl,
          message: allFilesSynced
            ? `SharePoint [${folderInfo.fullFolderPath}] 폴더에 성공적으로 저장되었습니다. (동기화된 파일: ${syncedFiles.length}개)`
            : `SharePoint에 일부 파일 동기화가 실패했습니다. (성공: ${syncedFiles.length}개, 실패: ${errors.length}개)`,
          syncedFiles,
          errors: errors.length ? errors : undefined,
        };
      } catch (err: any) {
        console.error('Live SharePoint Sync Failed:', err);
        return {
          success: false,
          mode: 'LIVE',
          folderPath: folderInfo.fullFolderPath,
          message: `SharePoint 동기화 중 오류가 발생했습니다: ${err.message || String(err)}`,
          syncedFiles: [],
          errors: [err.message || String(err)],
        };
      }
    }

    // TEST MODE (Development / Verification mode)
    // Create local folder mirror simulating SharePoint structure
    try {
      const mockSharePointDir = path.join(
        process.cwd(),
        'data',
        'sharepoint_storage',
        folderInfo.rootFolder,
        folderInfo.monthFolder,
        folderInfo.siteFolder
      );
      const mockAttachmentsDir = path.join(mockSharePointDir, '첨부파일');

      fs.mkdirSync(mockAttachmentsDir, { recursive: true });

      // Save 현장정보.json
      const siteMeta = {
        현장고유ID: siteRecord.id,
        담당자: siteRecord.managerName,
        주소: siteRecord.address,
        시공일: siteRecord.constructionDate,
        특이사항: siteRecord.notes,
        제출일: siteRecord.createdAt,
        첨부파일수: files.length,
        SharePoint저장경로: folderInfo.fullFolderPath,
        저장상태: '테스트용 저장 완료 (SharePoint 구조 연동 검증됨)',
        파일목록: files.map((f) => ({
          파일명: f.originalName,
          파일크기: f.size,
          유형: f.fileType,
        })),
      };

      fs.writeFileSync(
        path.join(mockSharePointDir, '현장정보.json'),
        JSON.stringify(siteMeta, null, 2),
        'utf-8'
      );

      const syncedFiles = ['현장정보.json'];

      // Copy files to simulated folder
      for (const file of files) {
        if (fs.existsSync(file.filePath)) {
          const destFile = path.join(mockAttachmentsDir, file.originalName);
          fs.copyFileSync(file.filePath, destFile);
          syncedFiles.push(file.originalName);
        }
      }

      return {
        success: true,
        mode: 'TEST_MODE',
        folderPath: folderInfo.fullFolderPath,
        webUrl: `/api/sharepoint/preview-folder?path=${encodeURIComponent(folderInfo.fullFolderPath)}`,
        message: `테스트 저장 모드: SharePoint 규격 폴더 [${folderInfo.fullFolderPath}] 및 ${files.length}개 파일이 정상 동기화되었습니다.`,
        syncedFiles,
      };
    } catch (err: any) {
      return {
        success: false,
        mode: 'TEST_MODE',
        folderPath: folderInfo.fullFolderPath,
        message: `테스트 폴더 생성 실패: ${err.message || String(err)}`,
        syncedFiles: [],
        errors: [err.message || String(err)],
      };
    }
  }
}

export const sharePointService = new SharePointService();
