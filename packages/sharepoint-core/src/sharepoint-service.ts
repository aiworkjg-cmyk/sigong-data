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

/**
 * How long to wait before reading the destination back.
 *
 * Rules that rename on upload fire moments after the item is created, so a
 * check that runs immediately would see the original name and pass — the exact
 * failure this verification exists to catch.
 */
const VERIFY_SETTLE_MS = 2500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
        constructionType: '백조',
        constructionDate: '2026-08-11',
        address: '경기 광명시 하안로 60 광명SK테크노파크',
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

  /**
   * Reads the destination back and reports which uploads cannot be found.
   *
   * Matching is by name and size. Size matters because a name can be reused:
   * if two uploads collapse onto one name, the survivor still matches by name
   * while the other file is gone, and only the byte count reveals it.
   *
   * A verification that cannot run at all (the listing itself fails) is not
   * treated as file loss — that would turn a transient network error into a
   * false alarm on data that is most likely fine.
   */
  private async verifyStored(
    folderPath: string,
    synced: SyncedFileResult[],
    files: PendingUpload[]
  ): Promise<{ missing: SyncResult['failedFiles']; checked: boolean }> {
    if (synced.length === 0) return { missing: [], checked: true };

    // A rule that renames on upload runs just after the item is created, so a
    // brief settle gives it time to act before the folder is read back. Test
    // mode waits too — the point of test mode is to behave like the real thing,
    // and a check that only runs late in production is a check nobody tested.
    await delay(VERIFY_SETTLE_MS);

    let present: Map<string, number>;
    try {
      const entries = this.client
        ? await this.client.listChildren(folderPath)
        : this.listLocally(folderPath);

      present = new Map(
        entries
          .filter((entry) => !entry.folder && entry.name)
          .map((entry) => [entry.name as string, Number(entry.size) || 0])
      );
    } catch (err) {
      console.error('[sharepoint] 저장 확인 실패 — 확인을 건너뜁니다.', err);
      return { missing: [], checked: false };
    }

    const sizeOf = new Map(files.map((file) => [file.id, file.size]));
    const missing: SyncResult['failedFiles'] = [];

    for (const entry of synced) {
      const name = entry.remotePath.slice(entry.remotePath.lastIndexOf('/') + 1);
      const actual = present.get(name);

      if (actual === undefined) {
        missing.push({
          id: entry.id,
          fileName: entry.fileName,
          error:
            '업로드 후 저장소에서 파일을 찾지 못했습니다. ' +
            '저장소에 파일 이름을 바꾸는 규칙(흐름)이 있는지 확인해 주세요.',
        });
        continue;
      }

      const expected = sizeOf.get(entry.id);
      if (expected !== undefined && actual > 0 && actual !== expected) {
        missing.push({
          id: entry.id,
          fileName: entry.fileName,
          error: `저장된 파일 크기가 다릅니다. (보낸 크기 ${expected} / 저장된 크기 ${actual})`,
        });
      }
    }

    return { missing, checked: true };
  }

  /** Test-mode counterpart of listChildren, so verification works there too. */
  private listLocally(folderPath: string): DriveItem[] {
    const dir = path.join(this.testModeRoot, folderPath);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const stat = entry.isFile() ? fs.statSync(path.join(dir, entry.name)) : null;
      return {
        name: entry.name,
        size: stat?.size ?? 0,
        folder: entry.isDirectory() ? {} : undefined,
      } as DriveItem;
    });
  }

  /** Resolves the destination paths for a submission under the active rule. */
  planFolders(submission: SiteSubmission) {
    return resolveFolder(
      {
        siteId: submission.id,
        constructionType: submission.constructionType,
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
        시공종류: submission.constructionType,
        시공기사: submission.managerName,
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

      // A successful upload call is not proof the file is still there. A
      // library rule or a Power Automate flow can rename or move an item right
      // after it lands — and when several files end up with the same name, each
      // one silently replaces the last. Reading the folder back is the only way
      // to know what actually survived, so nothing is reported as stored until
      // it has been seen in the destination.
      const verification = await this.verifyStored(
        folders.attachmentsFolderPath,
        synced,
        files
      );
      for (const problem of verification.missing) {
        const index = synced.findIndex((entry) => entry.id === problem.id);
        if (index >= 0) synced.splice(index, 1);
        failed.push(problem);
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
          ? `${mode === 'LIVE' ? 'SharePoint' : '테스트 저장소'} [${folders.fullFolderPath}] 에 ${synced.length}개 파일 저장을 확인했습니다.`
          : `저장 확인에 실패한 파일이 있습니다. (확인 ${synced.length}개 / 실패 ${failed.length}개)`,
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
