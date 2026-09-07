import fs from 'fs';
import path from 'path';
import type { PendingUpload, SharePointService, SyncResult } from '@jg/sharepoint-core';
import { config } from './config';
import { mailer } from './mailer';
import { teams } from './teams';
import type { SettingsService } from './settings';
import type { Repositories } from './repositories';
import { stagingDirFor } from './submission';
import type { SiteRecord, UploadLog, UploadResult } from '../src/types';
import { generateId, removeQuietly } from './util';

interface Job {
  siteId: string;
  /** Actor recorded on the audit log entry this run produces. */
  clientIp: string;
  userAgent: string;
}

/**
 * Files accepted submissions into the document library, one at a time, after
 * the submitter has already been told their upload succeeded.
 *
 * The queue is in-process. That is the right size for a single App Service
 * instance, and the store is the real source of truth: anything left in a
 * non-terminal state is re-queued on boot, so a restart mid-upload resumes
 * rather than losing the work.
 */
export class SubmissionWorker {
  private queue: Job[] = [];
  private active = 0;
  private timers = new Set<NodeJS.Timeout>();
  private stopping = false;

  constructor(
    private readonly repos: Repositories,
    private readonly sharePoint: SharePointService,
    /** Read at send time so a webhook change takes effect without a restart. */
    private readonly settings: SettingsService
  ) {}

  enqueue(job: Job): void {
    if (this.stopping) return;
    if (this.queue.some((queued) => queued.siteId === job.siteId)) return;

    this.queue.push(job);
    this.pump();
  }

  /** Re-queues work that was interrupted by a restart. */
  async recoverPending(): Promise<number> {
    try {
      const unfinished = await this.repos.sites.listUnfinished();
      unfinished.forEach((record) =>
        this.enqueue({ siteId: record.id, clientIp: 'system', userAgent: 'worker-recovery' })
      );
      return unfinished.length;
    } catch (err) {
      console.error('[worker] 미완료 제출 복구 실패', err);
      return 0;
    }
  }

  private pump(): void {
    while (this.active < config.worker.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;

      void this.run(job)
        .catch((err) => console.error(`[worker] ${job.siteId} 처리 중 예외`, err))
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private scheduleRetry(job: Job, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.enqueue(job);
    }, delayMs);

    // Do not hold the event loop open for a pending retry during shutdown.
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * Builds the upload list from files still staged on disk. Files already in
   * the library are skipped, so a retry never duplicates them.
   */
  private pendingUploads(record: SiteRecord): PendingUpload[] {
    const stagingDir = stagingDirFor(record.id);

    return record.files
      .filter((file) => file.status !== 'completed')
      .map((file) => ({
        id: file.id,
        fileName: file.storedName,
        // Read by the name multer gave the staged copy; write under the ordered
        // name. Records from before stagedName existed fall back to the old
        // assumption, which is the best that can be done for them.
        filePath: path.join(stagingDir, file.stagedName || file.storedName),
        fileType: file.fileType,
        size: file.size,
      }))
      .filter((item) => fs.existsSync(item.filePath));
  }

  private async run(job: Job): Promise<void> {
    const record = await this.repos.sites.get(job.siteId);
    if (!record) return;
    if (record.status === 'COMPLETED') return;

    const attempt = (record.attempts ?? 0) + 1;
    record.attempts = attempt;
    record.status = 'PROCESSING';
    record.syncMessage = `저장소에 반영 중입니다. (${attempt}번째 시도)`;
    await this.repos.sites.save(record);

    const pending = this.pendingUploads(record);
    const missing = record.files.filter((file) => file.status !== 'completed').length - pending.length;

    if (pending.length === 0 && missing > 0) {
      // Staged files are gone — only a fresh submission can recover this.
      record.status = record.files.some((file) => file.status === 'completed')
        ? 'PARTIAL'
        : 'FAILED';
      record.retryAvailable = false;
      record.syncMessage =
        '임시 저장 파일이 남아 있지 않아 재시도할 수 없습니다. 담당자에게 재제출을 요청해 주세요.';
      record.syncedAt = new Date().toISOString();
      await this.repos.sites.save(record);
      await mailer.notifyQuietly(record, [record.syncMessage]);
      // This path never reaches the sync step, so without its own call the
      // channel would hear nothing at all about a submission that failed
      // outright — the case most worth hearing about.
      void Promise.all(this.settings.teamsWebhookUrls().map((url) => teams.notifyQuietly(url, record)));
      return;
    }

    const sync = await this.sharePoint.syncSubmission(
      {
        id: record.id,
        constructionType: record.constructionType,
        siteType: record.siteType,
        customerName: record.customerName,
        customFields: record.customFields,
        managerName: record.managerName,
        address: record.address,
        constructionDate: record.constructionDate,
        notes: record.notes,
        createdAt: record.createdAt,
      },
      pending
    );

    this.applySyncResult(record, sync);

    const allStored = record.files.every((file) => file.status === 'completed');
    const anyStored = record.files.some((file) => file.status === 'completed');
    const exhausted = attempt >= config.worker.maxAttempts;

    if (allStored) {
      record.status = 'COMPLETED';
      record.retryAvailable = false;
    } else if (exhausted) {
      record.status = anyStored ? 'PARTIAL' : 'FAILED';
      record.retryAvailable = true;
    } else {
      // Another attempt is coming; keep it visibly in flight.
      record.status = 'PROCESSING';
      record.retryAvailable = true;
      record.syncMessage = `${sync.message} 잠시 후 자동으로 다시 시도합니다. (${attempt}/${config.worker.maxAttempts})`;
    }

    record.syncedAt = new Date().toISOString();
    await this.repos.sites.save(record);
    await this.appendLog(record, sync, job);

    // Announce only once the outcome is settled. A card sent while retries are
    // still pending would report a shortfall that fixes itself a minute later.
    if (allStored || exhausted) {
      void Promise.all(this.settings.teamsWebhookUrls().map((url) => teams.notifyQuietly(url, record)));
    }

    if (allStored) {
      await removeQuietly(stagingDirFor(record.id));
      return;
    }

    if (!exhausted) {
      this.scheduleRetry(job, config.worker.retryDelayMs);
      return;
    }

    // Out of automatic attempts — hand it to a human.
    await mailer.notifyQuietly(
      record,
      sync.failedFiles.map((file) => `${file.fileName}: ${file.error}`)
    );
  }

  /** Folds one sync result back into the record's file list. */
  private applySyncResult(record: SiteRecord, sync: SyncResult): void {
    const synced = new Map(sync.syncedFiles.map((file) => [file.id, file]));
    const failed = new Map(sync.failedFiles.map((file) => [file.id, file]));

    record.files = record.files.map((file) => {
      const ok = synced.get(file.id);
      if (ok) {
        return {
          ...file,
          status: 'completed' as const,
          // The final name is decided at upload time (numbering continues from
          // the folder), so the record takes it back from the sync result.
          storedName: ok.fileName || file.storedName,
          remotePath: ok.remotePath,
          webUrl: ok.webUrl,
          errorMessage: undefined,
        };
      }

      const failure = failed.get(file.id);
      return failure ? { ...file, status: 'failed' as const, errorMessage: failure.error } : file;
    });

    record.storageMode = sync.mode;
    record.folderPath = sync.folderPath;
    record.attachmentsFolderPath = sync.attachmentsFolderPath;
    record.webUrl = sync.webUrl || record.webUrl;
    record.syncMessage = sync.message;
  }

  private async appendLog(record: SiteRecord, sync: SyncResult, job: Job): Promise<void> {
    const storedCount = record.files.filter((file) => file.status === 'completed').length;
    const result: UploadResult =
      storedCount === record.files.length ? 'SUCCESS' : storedCount > 0 ? 'PARTIAL' : 'FAILED';

    const log: UploadLog = {
      id: generateId('log'),
      at: new Date().toISOString(),
      siteId: record.id,
      constructionType: record.constructionType,
      managerName: record.managerName,
      address: record.address,
      fileCount: record.files.length,
      totalBytes: record.files.reduce((sum, file) => sum + file.size, 0),
      durationMs: sync.durationMs,
      result,
      mode: sync.mode,
      folderPath: sync.folderPath,
      message: sync.message,
      clientIp: job.clientIp,
      userAgent: job.userAgent,
      errors: sync.failedFiles.map((file) => `${file.fileName}: ${file.error}`),
    };

    try {
      await this.repos.logs.append(log);
    } catch (err) {
      // A failed audit write must not fail the submission it describes.
      console.error('[worker] 업로드 로그 기록 실패', err);
    }
  }

  /** Stops accepting work; in-flight jobs are allowed to finish. */
  shutdown(): void {
    this.stopping = true;
    this.queue = [];
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }
}
