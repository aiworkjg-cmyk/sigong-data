import fs from 'fs';
import path from 'path';
import { GraphClient } from './graph-client';
import { loadFolderRuleFromEnv, resolveFolder, sanitizeFileName } from './folder-rules';
import type { FolderRule } from './folder-rules';
import type {
  DriveItem,
  PendingUpload,
  SharePointCredentials,
  SiteSubmission,
  SyncResult,
  SyncedFileResult,
} from './types';

export interface SharePointServiceOptions {
  credentials: SharePointCredentials;
  rule?: FolderRule;
  /**
   * Local directory used as a stand-in library when credentials are absent, so
   * the app stays fully usable (and the folder rules stay verifiable) before
   * the Azure AD app registration is finished.
   */
  testModeRoot: string;
}

export interface ConfigStatus {
  isLiveConfigured: boolean;
  mode: 'LIVE' | 'TEST_MODE';
  tenantIdConfigured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  siteIdConfigured: boolean;
  driveIdConfigured: boolean;
  rootFolder: string;
  folderRule: FolderRule;
  /** Example path for the current rule, so admins can sanity-check it in the UI. */
  examplePath: string;
  message: string;
}

export class SharePointService {
  private readonly credentials: SharePointCredentials;
  private readonly testModeRoot: string;
  private client: GraphClient | null = null;
  public rule: FolderRule;

  constructor(options: SharePointServiceOptions) {
    this.credentials = options.credentials;
    this.testModeRoot = options.testModeRoot;
    this.rule = options.rule ?? loadFolderRuleFromEnv();

    if (this.isLiveConfigured()) {
      this.client = new GraphClient(this.credentials);
    }
  }

  isLiveConfigured(): boolean {
    const { tenantId, clientId, clientSecret, siteId, driveId } = this.credentials;
    return Boolean(tenantId && clientId && clientSecret && (siteId || driveId));
  }

  getConfigStatus(): ConfigStatus {
    const live = this.isLiveConfigured();
    const example = resolveFolder(
      {
        siteId: 'SITE-20260814-0001',
        constructionDate: '2026-08-14',
        address: '경기 광명시 하안로 60',
        managerName: '홍길동',
        submittedAt: new Date().toISOString(),
      },
      this.rule
    );

    return {
      isLiveConfigured: live,
      mode: live ? 'LIVE' : 'TEST_MODE',
      tenantIdConfigured: Boolean(this.credentials.tenantId),
      clientIdConfigured: Boolean(this.credentials.clientId),
      clientSecretConfigured: Boolean(this.credentials.clientSecret),
      siteIdConfigured: Boolean(this.credentials.siteId),
      driveIdConfigured: Boolean(this.credentials.driveId),
      rootFolder: this.rule.root,
      folderRule: this.rule,
      examplePath: example.attachmentsFolderPath,
      message: live
        ? 'Microsoft SharePoint 실제 연동 모드로 동작 중입니다.'
        : '테스트 저장 모드로 동작 중입니다. (SharePoint 연결 정보가 등록되면 자동 전환됩니다.)',
    };
  }

  /** Live connectivity check for the admin diagnostics panel. */
  async probe() {
    if (!this.client) {
      return { ok: false, error: 'SharePoint 연결 정보가 설정되지 않았습니다. (테스트 저장 모드)' };
    }
    return this.client.probe();
  }

  /** Resolves the destination paths for a submission under the active rule. */
  planFolders(submission: SiteSubmission) {
    return resolveFolder(
      {
        siteId: submission.id,
        constructionDate: submission.constructionDate,
        address: submission.address,
        managerName: submission.managerName,
        submittedAt: submission.createdAt,
      },
      this.rule
    );
  }

  private buildMetadata(submission: SiteSubmission, files: PendingUpload[], folderPath: string) {
    return JSON.stringify(
      {
        현장고유ID: submission.id,
        담당자: submission.managerName,
        주소: submission.address,
        시공일: submission.constructionDate,
        특이사항: submission.notes,
        제출일: submission.createdAt,
        첨부파일수: files.length,
        저장경로: folderPath,
        파일목록: files.map((f) => ({ 파일명: f.fileName, 파일크기: f.size, 유형: f.fileType })),
      },
      null,
      2
    );
  }

  /**
   * Creates the classification folders and uploads every attachment.
   * A per-file failure is recorded and the remaining files still upload, so one
   * bad video never discards an entire submission.
   */
  async syncSubmission(submission: SiteSubmission, files: PendingUpload[]): Promise<SyncResult> {
    const startedAt = Date.now();
    const folders = this.planFolders(submission);

    const base = {
      folderPath: folders.fullFolderPath,
      attachmentsFolderPath: folders.attachmentsFolderPath,
    };

    try {
      const synced: SyncedFileResult[] = [];
      const failed: SyncResult['failedFiles'] = [];

      const uploadOne = this.client
        ? (remotePath: string, filePath: string) => this.client!.uploadFile(remotePath, filePath)
        : (remotePath: string, filePath: string) => this.copyLocally(remotePath, filePath);

      let folderItem: DriveItem | null = null;

      if (this.client) {
        folderItem = await this.client.ensureFolderPath(folders.fullFolderPath);
        if (folders.attachmentsFolderPath !== folders.fullFolderPath) {
          await this.client.ensureFolderPath(folders.attachmentsFolderPath);
        }
      } else {
        fs.mkdirSync(path.join(this.testModeRoot, folders.attachmentsFolderPath), {
          recursive: true,
        });
      }

      if (folders.metadataFilePath) {
        const metadata = this.buildMetadata(submission, files, folders.fullFolderPath);
        if (this.client) {
          await this.client.uploadContent(folders.metadataFilePath, metadata, 'application/json');
        } else {
          fs.writeFileSync(path.join(this.testModeRoot, folders.metadataFilePath), metadata, 'utf-8');
        }
      }

      for (const file of files) {
        if (!fs.existsSync(file.filePath)) {
          failed.push({ id: file.id, fileName: file.fileName, error: '임시 파일을 찾을 수 없습니다.' });
          continue;
        }

        const remotePath = `${folders.attachmentsFolderPath}/${sanitizeFileName(file.fileName)}`;
        try {
          const item = await uploadOne(remotePath, file.filePath);
          synced.push({
            id: file.id,
            fileName: file.fileName,
            remotePath,
            webUrl: item?.webUrl,
          });
        } catch (err: any) {
          failed.push({ id: file.id, fileName: file.fileName, error: err?.message || String(err) });
        }
      }

      const mode = this.client ? 'LIVE' : 'TEST_MODE';
      const success = failed.length === 0;

      return {
        ...base,
        success,
        mode,
        webUrl: folderItem?.webUrl,
        durationMs: Date.now() - startedAt,
        syncedFiles: synced,
        failedFiles: failed,
        message: success
          ? `${mode === 'LIVE' ? 'SharePoint' : '테스트 저장소'} [${folders.fullFolderPath}] 에 ${synced.length}개 파일을 저장했습니다.`
          : `일부 파일 저장에 실패했습니다. (성공 ${synced.length}개 / 실패 ${failed.length}개)`,
      };
    } catch (err: any) {
      return {
        ...base,
        success: false,
        mode: this.client ? 'LIVE' : 'TEST_MODE',
        durationMs: Date.now() - startedAt,
        syncedFiles: [],
        failedFiles: files.map((f) => ({
          id: f.id,
          fileName: f.fileName,
          error: err?.message || String(err),
        })),
        message: `저장 중 오류가 발생했습니다: ${err?.message || String(err)}`,
      };
    }
  }

  /**
   * Opens a stored attachment for streaming back to an authenticated admin.
   * Returns null when the file is not present in the active backend.
   */
  async openFile(remotePath: string): Promise<{
    stream: NodeJS.ReadableStream;
    size?: number;
    contentType?: string;
  } | null> {
    if (this.client) {
      const res = await this.client.downloadFile(remotePath);
      if (!res.body) return null;

      const { Readable } = await import('stream');
      const length = Number(res.headers.get('content-length'));
      return {
        stream: Readable.fromWeb(res.body as any),
        size: Number.isFinite(length) && length > 0 ? length : undefined,
        contentType: res.headers.get('content-type') || undefined,
      };
    }

    const local = path.join(this.testModeRoot, remotePath);
    if (!fs.existsSync(local)) return null;

    return { stream: fs.createReadStream(local), size: fs.statSync(local).size };
  }

  /** Test-mode stand-in for GraphClient.uploadFile. */
  private async copyLocally(remotePath: string, filePath: string): Promise<DriveItem> {
    const destination = path.join(this.testModeRoot, remotePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(filePath, destination);
    return { name: path.basename(destination), webUrl: undefined };
  }

  /** Folder listing for the admin inspector, in either mode. */
  async listFolder(folderPath: string): Promise<Array<{ name: string; type: 'folder' | 'file'; size?: number; webUrl?: string }>> {
    if (this.client) {
      const items = await this.client.listChildren(folderPath);
      return items.map((item) => ({
        name: item.name || '',
        type: item.folder ? 'folder' : 'file',
        size: item.size,
        webUrl: item.webUrl,
      }));
    }

    const dir = path.join(this.testModeRoot, folderPath);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const full = path.join(dir, entry.name);
      return {
        name: entry.name,
        type: entry.isDirectory() ? ('folder' as const) : ('file' as const),
        size: entry.isDirectory() ? undefined : fs.statSync(full).size,
      };
    });
  }
}
