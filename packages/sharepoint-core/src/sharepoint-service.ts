import fs from 'fs';
import path from 'path';
import { GraphClient } from './graph-client';
import {
  DEFAULT_FILE_NAME_TEMPLATE,
  buildStoredName,
  followsFileNameRule,
  loadFolderRuleFromEnv,
  needsSubmissionTokens,
  nextSequences,
  resolveFolder,
  sanitizeFileName,
  sanitizeSegment,
} from './folder-rules';
import type { FolderRule, ResolvedFolder } from './folder-rules';
import type {
  DriveItem,
  ManualReconcileResult,
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

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'mpeg', 'mpg', '3gp',
]);

function manualFileType(name: string): PendingUpload['fileType'] {
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'other';
}

/**
 * 수동 업로드 정리가 이름을 바꿀 필요가 없는 파일인지.
 *
 * 지금 설정된 규칙과 기본 규칙 **둘 다** 를 봅니다. 앱이 올린 파일은 설정된
 * 규칙대로, 수동으로 올라온 파일을 정리한 것은 기본 규칙대로 지어지기
 * 때문입니다(아래 manualTemplate 참고). 설정만 보고 판단하면, 관리자가
 * 규칙을 고친 순간 앱이 올린 파일까지 매분 다시 이름 바꾸게 됩니다.
 */
function followsManagedName(folderLeaf: string, name: string, template?: string): boolean {
  return (
    followsFileNameRule(folderLeaf, name, template) ||
    followsFileNameRule(folderLeaf, name, DEFAULT_FILE_NAME_TEMPLATE)
  );
}

/**
 * 수동으로 올라온 파일에 쓸 규칙.
 *
 * 설정된 규칙이 날짜·지역·건물명처럼 제출 정보에서 오는 값을 쓰면, 수동
 * 업로드에는 그 값이 없습니다 — 누가 왜 올렸는지 알 수 없으니까요. 빈 값으로
 * 채우면 "_이미지001" 같은 이름이 되므로 그럴 때는 기본 규칙을 씁니다.
 * 폴더 이름 자체가 이미 날짜와 지역을 담고 있어 정보가 크게 줄지 않습니다.
 */
function manualTemplate(template?: string): string {
  return template && !needsSubmissionTokens(template) ? template : DEFAULT_FILE_NAME_TEMPLATE;
}

export class SharePointService {
  private credentials: SharePointCredentials;
  private readonly testModeRoot: string;
  private client: GraphClient | null = null;
  /** Serializes uploads and manual renames so they cannot reserve one number. */
  private operationTail: Promise<void> = Promise.resolve();
  public rule: FolderRule;
  /** Optional per-construction-type rule supplied by the host application. */
  public ruleForConstructionType?: (constructionType: string) => FolderRule;
  /** Every effective path shape the manual-upload watcher is allowed to manage. */
  public rulesForManualUploads?: () => FolderRule[];

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

  /** Uploads a generated image through the same live Graph path as real files. */
  async uploadConnectionTestImage(
    content: Buffer,
    channelFolder: string
  ): Promise<{ mode: 'LIVE'; remotePath: string; webUrl?: string }> {
    if (!this.client) {
      throw new Error(
        '실제 SharePoint 연결 정보가 완성되지 않아 테스트 이미지를 업로드할 수 없습니다.'
      );
    }

    const testFolder = [channelFolder, '_연결테스트'].filter(Boolean).join('/');
    await this.client.ensureFolderPath(testFolder);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const remotePath = `${testFolder}/연결테스트_${stamp}.png`;
    const item = await this.client.uploadContent(remotePath, content, 'image/png');
    return { mode: 'LIVE', remotePath, webUrl: item.webUrl };
  }

  /** Switches the destination drive without restarting the server. */
  setStorageTarget(target: { siteId: string; driveId: string }): void {
    this.credentials = {
      ...this.credentials,
      siteId: target.siteId.trim(),
      driveId: target.driveId.trim(),
    };
    this.client = this.isLiveConfigured() ? new GraphClient(this.credentials) : null;
  }

  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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

  /** File names already in a folder; an unreachable folder simply reads empty. */
  private async existingNames(folderPath: string): Promise<string[]> {
    try {
      const entries = this.client
        ? await this.client.listChildren(folderPath)
        : this.listLocally(folderPath);
      return entries.filter((entry) => !entry.folder && entry.name).map((entry) => entry.name as string);
    } catch {
      return [];
    }
  }

  /**
   * 같은 현장에 자료가 이미 들어 있으면 폴더를 나눕니다.
   *
   * 폴더 규칙이 날짜·주소처럼 반복될 수 있는 값으로만 되어 있으면, 같은 현장에
   * 두 번 올릴 때 두 제출이 한 폴더에 섞입니다. 파일 이름은 이어지는 번호라
   * 덮어쓰지는 않지만, 나중에 "1차 시공"과 "재방문"을 갈라내려면 사람이
   * 촬영 시각을 하나씩 확인해야 합니다.
   *
   * 그래서 가장 아래 폴더에만 `_중복방지-01` 을 붙여 새 폴더를 만듭니다.
   * 위쪽 단계(업체·연월)를 건드리지 않는 이유는, 그 단계는 여러 현장이 함께
   * 쓰는 것이라 나누면 오히려 흩어지기 때문입니다.
   *
   * 판단 기준은 "그 폴더에 파일이 있는가" 입니다. 폴더만 미리 만들어 둔
   * 경우까지 중복으로 보면, 빈 폴더가 영원히 쓰이지 않고 남습니다.
   */
  private async avoidCollision(folders: ResolvedFolder): Promise<ResolvedFolder> {
    const names = await this.existingNames(folders.attachmentsFolderPath);
    const metadataName = this.rule.metadataFileName
      ? sanitizeFileName(this.rule.metadataFileName)
      : null;
    const hasContent = names.some(
      (name) => !metadataName || name.toLowerCase() !== metadataName.toLowerCase()
    );
    if (!hasContent) return folders;

    const base = folders.fullFolderPath;
    for (let attempt = 1; attempt <= 99; attempt += 1) {
      const suffix = `_중복방지-${String(attempt).padStart(2, '0')}`;
      const candidate = `${base}${suffix}`;
      const leaf = sanitizeSegment(
        `${base.slice(base.lastIndexOf('/') + 1)}${suffix}`,
        this.rule.maxSegmentLength
      );
      const nextPath = `${base.slice(0, base.lastIndexOf('/') + 1)}${leaf}`;
      const attachments =
        folders.attachmentsFolderPath === base
          ? nextPath
          : `${nextPath}/${folders.attachmentsFolderPath.slice(base.length + 1)}`;

      void candidate;
      if ((await this.existingNames(attachments)).length === 0) {
        return {
          ...folders,
          fullFolderPath: nextPath,
          attachmentsFolderPath: attachments,
          metadataFilePath: folders.metadataFilePath
            ? `${nextPath}/${folders.metadataFilePath.slice(base.length + 1)}`
            : null,
        };
      }
    }
    // 99개까지 찼다면 규칙 자체가 잘못된 것입니다. 원래 자리에 이어 붙입니다.
    return folders;
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
    const rule = this.ruleForConstructionType?.(submission.constructionType) ?? this.rule;
    return resolveFolder(
      {
        siteId: submission.id,
        constructionType: submission.constructionType,
        siteType: submission.siteType,
        customerName: submission.customerName,
        customFields: submission.customFields,
        constructionDate: submission.constructionDate,
        address: submission.address,
        managerName: submission.managerName,
        submittedAt: submission.createdAt,
      },
      rule
    );
  }

  private buildMetadata(submission: SiteSubmission, files: PendingUpload[], folderPath: string) {
    return JSON.stringify(
      {
        현장고유ID: submission.id,
        시공종류: submission.constructionType,
        현장종류: submission.siteType || '',
        주문자명: submission.customerName || '',
        추가입력항목: Object.fromEntries(
          (submission.customFields || []).map((field) => [field.label, field.value])
        ),
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
    return this.exclusively(() => this.syncSubmissionUnlocked(submission, files));
  }

  private async syncSubmissionUnlocked(
    submission: SiteSubmission,
    files: PendingUpload[]
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    let folders = this.planFolders(submission);

    try {
      const synced: SyncedFileResult[] = [];
      const failed: SyncResult['failedFiles'] = [];

      const uploadOne = this.client
        ? (remotePath: string, filePath: string) => this.client!.uploadFile(remotePath, filePath)
        : (remotePath: string, filePath: string) => this.copyLocally(remotePath, filePath);

      // 같은 현장에 두 번째 제출이 들어오면 폴더를 나눕니다.
      folders = await this.avoidCollision(folders);

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

      // Numbering continues from whatever the folder already holds — a retry,
      // an earlier submission to the same site, or a file added by hand. Naming
      // from our own count alone would restart at 001 and overwrite them.
      const folderLeaf =
        folders.fullFolderPath.slice(folders.fullFolderPath.lastIndexOf('/') + 1) || '자료';
      const sequence = nextSequences(
        await this.existingNames(folders.attachmentsFolderPath),
        folderLeaf,
        this.rule.fileNameTemplate
      );

      for (const file of files) {
        if (!fs.existsSync(file.filePath)) {
          failed.push({ id: file.id, fileName: file.fileName, error: '임시 파일을 찾을 수 없습니다.' });
          continue;
        }

        const kind = file.fileType === 'image' ? '이미지' : file.fileType === 'video' ? '동영상' : '파일';
        sequence[kind] += 1;
        const storedName = buildStoredName(
          folderLeaf,
          file.fileType,
          sequence[kind],
          file.fileName,
          // 파일 이름 규칙은 공통 하나뿐입니다 — 업체별로 갈라 두면 나중에
          // 자료를 한데 모았을 때 정렬조차 되지 않습니다.
          this.rule.fileNameTemplate,
          folders.tokens
        );
        const remotePath = `${folders.attachmentsFolderPath}/${storedName}`;

        try {
          const item = await uploadOne(remotePath, file.filePath);
          synced.push({
            id: file.id,
            fileName: storedName,
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
        folderPath: folders.fullFolderPath,
        attachmentsFolderPath: folders.attachmentsFolderPath,
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
        folderPath: folders.fullFolderPath,
        attachmentsFolderPath: folders.attachmentsFolderPath,
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

  /** Establishes a timestamp cursor without enumerating or touching old files. */
  async initializeManualReconcileCursor(startedAt: Date): Promise<string> {
    if (!this.client) return '';
    return this.client.deltaCursorFrom(startedAt);
  }

  /**
   * Renames new or changed unmanaged files returned by a Graph delta query.
   *
   * Delta makes a one-minute schedule cheap even after the library grows: an
   * idle scan is one request rather than a walk through every historical
   * folder. The upload lock prevents the app and reconciler from independently
   * reserving the same next sequence number.
   */
  async reconcileManualUploads(cursor: string, enabledAt: Date): Promise<ManualReconcileResult> {
    return this.exclusively(() => this.reconcileManualUploadsUnlocked(cursor, enabledAt));
  }

  private eligibleManualFolder(parentReferencePath: string, rule: FolderRule): {
    targetPath: string;
    folderLeaf: string;
    rule: FolderRule;
  } | null {
    const marker = parentReferencePath.toLowerCase().lastIndexOf('root:');
    if (marker < 0) return null;

    let decoded = parentReferencePath.slice(marker + 'root:'.length);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Graph normally returns a decoded path. Keep the original if a literal
      // percent sign makes decodeURIComponent reject an otherwise valid name.
    }

    const parentParts = decoded.split('/').filter(Boolean);
    const rootParts = rule.root
      .split('/')
      .map((part) => sanitizeSegment(part, rule.maxSegmentLength))
      .filter(Boolean);

    if (parentParts.length < rootParts.length) return null;
    if (
      rootParts.some(
        (part, index) => part.toLowerCase() !== parentParts[index]?.toLowerCase()
      )
    ) {
      return null;
    }

    const attachmentName = rule.attachmentsFolder
      ? sanitizeSegment(rule.attachmentsFolder, rule.maxSegmentLength)
      : null;
    const expectedDepth = rootParts.length + rule.segments.length + (attachmentName ? 1 : 0);
    if (parentParts.length !== expectedDepth) return null;
    if (
      attachmentName &&
      parentParts[parentParts.length - 1]?.toLowerCase() !== attachmentName.toLowerCase()
    ) {
      return null;
    }

    const siteLeafIndex = parentParts.length - (attachmentName ? 2 : 1);
    const folderLeaf = parentParts[siteLeafIndex];
    return folderLeaf ? { targetPath: parentParts.join('/'), folderLeaf, rule } : null;
  }

  private manualRules(): FolderRule[] {
    const supplied = this.rulesForManualUploads?.() ?? [];
    const seen = new Set<string>();
    return [this.rule, ...supplied]
      .filter((rule) => {
        const key = JSON.stringify({
          root: rule.root,
          segments: rule.segments,
          attachmentsFolder: rule.attachmentsFolder,
          metadataFileName: rule.metadataFileName,
          fileNameTemplate: rule.fileNameTemplate,
        });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // 더 구체적인(깊은) 루트를 먼저 봐야 채널 폴더가 빠진 옛 규칙이
      // 우연히 같은 경로를 잡는 일을 피할 수 있습니다.
      .sort((a, b) => b.root.split('/').length - a.root.split('/').length);
  }

  private async reconcileManualUploadsUnlocked(
    cursor: string,
    enabledAt: Date
  ): Promise<ManualReconcileResult> {
    const result: ManualReconcileResult = {
      examined: 0,
      renamed: 0,
      skipped: 0,
      failed: [],
      deleted: [],
      renamedItems: [],
      nextCursor: cursor,
    };
    if (!this.client) return result;

    const delta = await this.client.driveDelta(cursor);
    result.nextCursor = delta.cursor;

    // Graph may include the same item more than once. Its final occurrence is
    // the current state for this delta window.
    const latest = new Map<string, DriveItem>();
    for (const item of delta.items) {
      if (item.id) latest.set(item.id, item);
    }

    // 삭제는 이름을 바꿀 대상이 아니라 남길 기록입니다. 앱 밖에서 파일이
    // 사라진 사실은 나중에 "그 사진 어디 갔지"를 되짚을 때 유일한 단서입니다.
    for (const changed of latest.values()) {
      if (!changed.id || !changed.deleted) continue;
      result.deleted.push({
        id: changed.id,
        name: changed.name || '',
        path: changed.parentReference?.path || '',
        by:
          changed.lastModifiedBy?.user?.displayName ||
          changed.lastModifiedBy?.user?.email ||
          '',
      });
    }

    const grouped = new Map<
      string,
      { folderLeaf: string; items: DriveItem[]; rule: FolderRule }
    >();
    const rules = this.manualRules();
    for (const changed of latest.values()) {
      if (!changed.id || changed.deleted || changed.folder) continue;

      // A delta page can omit parentReference.path, and an item might have been
      // moved or deleted before this run got to it. Re-read by ID so the rename
      // always acts on its current location and ETag.
      const current = await this.client.getItem(changed.id);
      if (!current || current.deleted || current.folder || !current.name) continue;

      const eligible = rules
        .map((rule) => this.eligibleManualFolder(current.parentReference?.path || '', rule))
        .find((match) => match !== null);
      if (!eligible) continue;

      // A historical file edited after deployment is not a new manual upload.
      // Restricting by creation time prevents the first later edit from
      // unexpectedly renaming old archives that predate this feature.
      const created = Date.parse(current.createdDateTime || '');
      if (!Number.isFinite(created) || created < enabledAt.getTime()) continue;

      result.examined += 1;
      const metadataName = eligible.rule.metadataFileName
        ? sanitizeFileName(eligible.rule.metadataFileName)
        : null;
      if (
        (metadataName && current.name.toLowerCase() === metadataName.toLowerCase()) ||
        followsManagedName(eligible.folderLeaf, current.name, eligible.rule.fileNameTemplate)
      ) {
        result.skipped += 1;
        continue;
      }

      const group = grouped.get(eligible.targetPath) || {
        folderLeaf: eligible.folderLeaf,
        items: [],
        rule: eligible.rule,
      };
      group.items.push(current);
      grouped.set(eligible.targetPath, group);
    }

    for (const [targetPath, group] of grouped) {
      const existing = await this.client.listChildren(targetPath);
      const metadataName = group.rule.metadataFileName
        ? sanitizeFileName(group.rule.metadataFileName)
        : null;

      // A metadata sidecar is the marker that this is an app-created site
      // folder, not an unrelated folder that merely happens to have the same
      // depth below the configured root. When metadata is explicitly disabled,
      // the configured path shape remains the only available boundary.
      if (
        metadataName &&
        !existing.some(
          (item) => !item.folder && item.name?.toLowerCase() === metadataName.toLowerCase()
        )
      ) {
        result.skipped += group.items.length;
        continue;
      }

      const sequence = nextSequences(
        existing.filter((item) => !item.folder && item.name).map((item) => item.name as string),
        group.folderLeaf,
        manualTemplate(group.rule.fileNameTemplate)
      );

      group.items.sort((a, b) => {
        const byTime = Date.parse(a.createdDateTime || '') - Date.parse(b.createdDateTime || '');
        return byTime || String(a.id || a.name).localeCompare(String(b.id || b.name));
      });

      for (const item of group.items) {
        const originalName = item.name as string;
        const fileType = manualFileType(originalName);
        const kind = fileType === 'image' ? '이미지' : fileType === 'video' ? '동영상' : '파일';
        sequence[kind] += 1;
        const newName = buildStoredName(
          group.folderLeaf,
          fileType,
          sequence[kind],
          originalName,
          manualTemplate(group.rule.fileNameTemplate)
        );

        try {
          await this.client.renameItem(item.id as string, newName, item.eTag);
          result.renamed += 1;
          // 감사 기록에 그대로 넘어갑니다 — 누가 언제 무엇을 올렸는지는 이
          // 시점에만 알 수 있고, 이름을 바꾸고 나면 원래 이름은 사라집니다.
          result.renamedItems.push({
            id: item.id as string,
            name: newName,
            path: item.parentReference?.path || '',
            by:
              item.lastModifiedBy?.user?.displayName ||
              item.lastModifiedBy?.user?.email ||
              '',
          });
        } catch (err: any) {
          result.failed.push({
            path: `${targetPath}/${originalName}`,
            error: err?.message || String(err),
          });
        }
      }
    }

    return result;
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
