import fs from 'fs';
import path from 'path';
import { sanitizeFileName } from '@jg/sharepoint-core';
import type { PendingUpload, SharePointService, SyncResult } from '@jg/sharepoint-core';
import { config } from './config';
import type { Repositories } from './repositories';
import type { SiteFile, SiteRecord, UploadLog, UploadResult } from '../src/types';
import { classifyFile, formatBytes, generateId, removeQuietly } from './util';

export interface SubmissionInput {
  siteId: string;
  managerName: string;
  address: string;
  constructionDate: string;
  notes: string;
  clientIp: string;
  userAgent: string;
}

/** Directory holding one submission's attachments while they await upload. */
export function stagingDirFor(siteId: string): string {
  return path.join(config.paths.staging, siteId);
}

/**
 * Numbered, sanitized name written to SharePoint. The index prefix keeps the
 * submitter's ordering visible in a folder listing and prevents two identically
 * named photos from overwriting each other.
 *
 * Multer stages each file under this exact name too, so a retry can locate the
 * staged file from the stored record alone. Both paths must call this helper.
 */
export function storedNameFor(index: number, originalName: string): string {
  return `${String(index + 1).padStart(2, '0')}_${sanitizeFileName(originalName)}`;
}

function resultFor(sync: SyncResult, fileCount: number): { site: SiteRecord['status']; log: UploadResult } {
  if (sync.success) return { site: 'COMPLETED', log: 'SUCCESS' };
  if (sync.syncedFiles.length > 0 || fileCount === 0) return { site: 'PARTIAL', log: 'PARTIAL' };
  return { site: 'FAILED', log: 'FAILED' };
}

/**
 * Turns staged multer files into the upload queue. Names are assigned here so
 * the record, the retry path, and SharePoint all agree on the stored name.
 */
function toPendingUploads(files: Express.Multer.File[]): PendingUpload[] {
  return files.map((file, index) => ({
    id: generateId('file'),
    fileName: storedNameFor(index, file.originalname),
    filePath: file.path,
    fileType: classifyFile(file.mimetype),
    size: file.size,
  }));
}

function buildSiteFiles(
  files: Express.Multer.File[],
  pending: PendingUpload[],
  sync: SyncResult
): SiteFile[] {
  const synced = new Map(sync.syncedFiles.map((f) => [f.id, f]));
  const failed = new Map(sync.failedFiles.map((f) => [f.id, f]));

  return pending.map((item, index) => {
    const source = files[index];
    const ok = synced.get(item.id);

    return {
      id: item.id,
      originalName: source.originalname,
      storedName: item.fileName,
      fileType: item.fileType as SiteFile['fileType'],
      mimeType: source.mimetype,
      size: item.size,
      sizeFormatted: formatBytes(item.size),
      status: ok ? 'completed' : 'failed',
      remotePath: ok?.remotePath,
      webUrl: ok?.webUrl,
      errorMessage: failed.get(item.id)?.error,
    };
  });
}

export class SubmissionService {
  constructor(
    private readonly repos: Repositories,
    private readonly sharePoint: SharePointService
  ) {}

  /**
   * Files a submission: uploads the staged attachments, records the site, and
   * appends the audit log. Staged files are deleted only once every attachment
   * is confirmed stored, so a partial failure stays retryable.
   */
  async submit(input: SubmissionInput, files: Express.Multer.File[]): Promise<SiteRecord> {
    const createdAt = new Date().toISOString();
    const pending = toPendingUploads(files);

    const submission = {
      id: input.siteId,
      managerName: input.managerName,
      address: input.address,
      constructionDate: input.constructionDate,
      notes: input.notes,
      createdAt,
    };

    const sync = await this.sharePoint.syncSubmission(submission, pending);
    const outcome = resultFor(sync, files.length);

    const record: SiteRecord = {
      ...submission,
      status: outcome.site,
      storageMode: sync.mode,
      folderPath: sync.folderPath,
      attachmentsFolderPath: sync.attachmentsFolderPath,
      webUrl: sync.webUrl,
      syncMessage: sync.message,
      syncedAt: new Date().toISOString(),
      retryAvailable: !sync.success,
      files: buildSiteFiles(files, pending, sync),
    };

    await this.repos.sites.save(record);
    await this.appendLog(record, sync, input);

    if (sync.success) {
      await removeQuietly(stagingDirFor(input.siteId));
    }

    return record;
  }

  /**
   * Re-uploads the attachments still staged for a submission. Files already in
   * SharePoint are skipped so a retry never duplicates them.
   */
  async retry(siteId: string, actor: { clientIp: string; userAgent: string }): Promise<SiteRecord | null> {
    const record = await this.repos.sites.get(siteId);
    if (!record) return null;

    const stagingDir = stagingDirFor(siteId);
    const pending: PendingUpload[] = record.files
      .filter((file) => file.status !== 'completed')
      .map((file) => ({
        id: file.id,
        fileName: file.storedName,
        filePath: path.join(stagingDir, file.storedName),
        fileType: file.fileType,
        size: file.size,
      }))
      .filter((item) => fs.existsSync(item.filePath));

    if (pending.length === 0 && record.files.some((f) => f.status !== 'completed')) {
      record.retryAvailable = false;
      record.syncMessage =
        '재시도할 임시 파일이 남아 있지 않습니다. 담당자에게 재제출을 요청해 주세요.';
      await this.repos.sites.save(record);
      return record;
    }

    const sync = await this.sharePoint.syncSubmission(
      {
        id: record.id,
        managerName: record.managerName,
        address: record.address,
        constructionDate: record.constructionDate,
        notes: record.notes,
        createdAt: record.createdAt,
      },
      pending
    );

    const syncedById = new Map(sync.syncedFiles.map((f) => [f.id, f]));
    const failedById = new Map(sync.failedFiles.map((f) => [f.id, f]));

    record.files = record.files.map((file) => {
      const ok = syncedById.get(file.id);
      if (ok) {
        return {
          ...file,
          status: 'completed' as const,
          remotePath: ok.remotePath,
          webUrl: ok.webUrl,
          errorMessage: undefined,
        };
      }
      const failure = failedById.get(file.id);
      return failure ? { ...file, errorMessage: failure.error } : file;
    });

    const allStored = record.files.every((file) => file.status === 'completed');
    record.status = allStored ? 'COMPLETED' : record.files.some((f) => f.status === 'completed') ? 'PARTIAL' : 'FAILED';
    record.storageMode = sync.mode;
    record.folderPath = sync.folderPath;
    record.attachmentsFolderPath = sync.attachmentsFolderPath;
    record.webUrl = sync.webUrl || record.webUrl;
    record.syncMessage = sync.message;
    record.syncedAt = new Date().toISOString();
    record.retryAvailable = !allStored;

    await this.repos.sites.save(record);
    await this.appendLog(record, sync, {
      managerName: record.managerName,
      address: record.address,
      clientIp: actor.clientIp,
      userAgent: actor.userAgent,
    });

    if (allStored) {
      await removeQuietly(stagingDir);
    }

    return record;
  }

  private async appendLog(
    record: SiteRecord,
    sync: SyncResult,
    actor: { managerName: string; address: string; clientIp: string; userAgent: string }
  ): Promise<void> {
    const log: UploadLog = {
      id: generateId('log'),
      at: new Date().toISOString(),
      siteId: record.id,
      managerName: actor.managerName,
      address: actor.address,
      fileCount: record.files.length,
      totalBytes: record.files.reduce((sum, file) => sum + file.size, 0),
      durationMs: sync.durationMs,
      result: sync.success
        ? 'SUCCESS'
        : sync.syncedFiles.length > 0
          ? 'PARTIAL'
          : 'FAILED',
      mode: sync.mode,
      folderPath: sync.folderPath,
      message: sync.message,
      clientIp: actor.clientIp,
      userAgent: actor.userAgent,
      errors: sync.failedFiles.map((f) => `${f.fileName}: ${f.error}`),
    };

    try {
      await this.repos.logs.append(log);
    } catch (err) {
      // A failed audit write must not fail the submission the user already made.
      console.error('[log] 업로드 로그 기록 실패', err);
    }
  }
}
