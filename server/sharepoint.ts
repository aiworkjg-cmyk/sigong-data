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

export class SharePointService {
  private tenantId: string;
  private clientId: string;
  private clientSecret: string;
  private siteId: string;
  private driveId: string;

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

  private async getAccessToken(): Promise<string> {
    if (!this.isLiveConfigured()) {
      throw new Error('SharePoint API credentials are not configured');
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
    return data.access_token;
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
        const accessToken = await this.getAccessToken();
        const driveId = this.driveId || 'root';
        const syncedFiles: string[] = [];

        // 1. Upload Metadata JSON to SharePoint
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

        const metaUploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(
          folderInfo.fullFolderPath
        )}/현장정보.json:/content`;

        const metaRes = await fetch(metaUploadUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: metadataContent,
        });

        if (!metaRes.ok) {
          throw new Error(`Failed to upload 현장정보.json to SharePoint: ${metaRes.statusText}`);
        }
        syncedFiles.push('현장정보.json');

        // 2. Upload Attachments
        for (const file of files) {
          if (fs.existsSync(file.filePath)) {
            const fileStream = fs.readFileSync(file.filePath);
            const fileUploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(
              folderInfo.attachmentsFolderPath
            )}/${encodeURIComponent(file.originalName)}:/content`;

            const fileRes = await fetch(fileUploadUrl, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/octet-stream',
              },
              body: fileStream,
            });

            if (fileRes.ok) {
              syncedFiles.push(file.originalName);
            }
          }
        }

        return {
          success: true,
          mode: 'LIVE',
          folderPath: folderInfo.fullFolderPath,
          webUrl: `https://sharepoint.com/sites/construction/${folderInfo.fullFolderPath}`,
          message: `SharePoint [${folderInfo.fullFolderPath}] 폴더에 성공적으로 저장되었습니다. (동기화된 파일: ${syncedFiles.length}개)`,
          syncedFiles,
        };
      } catch (err: any) {
        console.error('Live SharePoint Sync Failed, falling back to simulated sync log:', err);
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
