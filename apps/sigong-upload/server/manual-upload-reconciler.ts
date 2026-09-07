import { GraphApiError, type SharePointService } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import { appendManualAudit, isManagedPath, toLibraryPath } from './manual-audit';

const CURSOR_KEY = 'manualUploadDeltaCursor';
const ENABLED_AT_KEY = 'manualUploadRenameEnabledAt';

/**
 * Watches SharePoint for files uploaded outside this app and brings their names
 * under the same rule as normal submissions.
 *
 * The persisted Graph delta cursor is important: a restart resumes from its
 * last completed scan, while the first deployment starts at "now" and never
 * rewrites historical files unexpectedly.
 */
export class ManualUploadReconciler {
  private cursor = '';
  private enabledAt = new Date(0);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    private readonly sharePoint: SharePointService,
    private readonly settings: SettingsRepository,
    /**
     * 이 앱이 관리하는 최상위 폴더. 그 아래의 변경만 기록합니다.
     *
     * Graph 변경 추적은 드라이브 전체를 알려 주는데, 이 앱이 책임지는 것은
     * 폴더 규칙이 만드는 경로뿐입니다. 나머지까지 기록하면 남의 업무 기록을
     * 그대로 옮겨 적는 셈이고, 추적에도 도움이 되지 않습니다.
     */
    private readonly rootFolders: () => string[] = () => []
  ) {}

  async start(): Promise<void> {
    if (!config.manualRename.enabled) {
      console.log('[manual-rename] 자동 이름 정리가 비활성화되어 있습니다.');
      return;
    }
    if (!this.sharePoint.getConfigStatus().isLiveConfigured) {
      console.log('[manual-rename] SharePoint 테스트 모드에서는 자동 이름 정리를 실행하지 않습니다.');
      return;
    }

    this.cursor = (await this.settings.get(CURSOR_KEY)) || '';
    const storedEnabledAt = await this.settings.get(ENABLED_AT_KEY);
    const parsedEnabledAt = Date.parse(storedEnabledAt || '');
    this.enabledAt = Number.isFinite(parsedEnabledAt) ? new Date(parsedEnabledAt) : new Date();
    if (!Number.isFinite(parsedEnabledAt)) {
      await this.settings.set(ENABLED_AT_KEY, this.enabledAt.toISOString());
    }

    if (!this.cursor) {
      this.cursor = await this.sharePoint.initializeManualReconcileCursor(this.enabledAt);
      await this.settings.set(CURSOR_KEY, this.cursor);
      console.log('[manual-rename] 현재 파일을 기준선으로 등록했습니다. 이후 수동 업로드부터 정리합니다.');
    }

    // Catch work that arrived after the timestamp baseline or between the last
    // completed scan and a restart.
    void this.runOnce();

    this.timer = setInterval(() => void this.runOnce(), config.manualRename.intervalMs);
    this.timer.unref();
    console.log(
      `[manual-rename] ${Math.round(config.manualRename.intervalMs / 1000)}초 주기로 변경 파일을 확인합니다.`
    );
  }

  /**
   * 앱을 거치지 않은 변경을 감사 파일에 남깁니다.
   *
   * 업로드 로그가 아니라 별도 파일입니다 — 업로드 로그는 "이 사이트를 통해
   * 누가 무엇을 올렸는가" 를 답하는 업무 기록이고, 거기에 사람이 SharePoint 를
   * 직접 만진 사건이 섞이면 두 질문 모두 답하기 어려워집니다.
   */
  private async audit(
    action: 'ADDED' | 'DELETED' | 'RENAMED',
    items: Array<{ id: string; name: string; path: string; by: string }>,
    note: string
  ): Promise<void> {
    const roots = this.rootFolders();
    const at = new Date().toISOString();

    for (const item of items) {
      // 앱이 만든 폴더 밖의 변경은 우리 일이 아닙니다.
      if (!roots.some((root) => isManagedPath(item.path, root))) continue;
      await appendManualAudit({
        at,
        action,
        path: toLibraryPath(item.path),
        name: item.name,
        by: item.by,
        itemId: item.id,
        note,
      });
    }
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopping || !this.cursor) return;
    this.running = true;

    try {
      const result = await this.sharePoint.reconcileManualUploads(this.cursor, this.enabledAt);
      if (result.failed.length > 0) {
        console.error(
          `[manual-rename] ${result.failed.length}개 파일 이름 변경 실패 — 다음 주기에 다시 시도합니다.`,
          result.failed.slice(0, 10)
        );
        return;
      }

      // Advance only after every rename has succeeded. If the process stops
      // before this write, the same delta is safe to replay: completed names
      // match the managed pattern and are skipped.
      await this.settings.set(CURSOR_KEY, result.nextCursor);
      this.cursor = result.nextCursor;

      if (result.renamed > 0) {
        console.log(
          `[manual-rename] 수동 업로드 ${result.renamed}개 이름 정리 완료 ` +
            `(확인 ${result.examined}개, 기존 규칙 ${result.skipped}개)`
        );
        await this.audit(
          'RENAMED',
          result.renamedItems ?? [],
          '앱 밖에서 올라온 파일의 이름을 현재 규칙으로 정리했습니다.'
        );
      }

      // 삭제는 되돌릴 수 없는 변경이라 건수와 상관없이 남깁니다.
      if (result.deleted.length > 0) {
        console.warn(`[manual-rename] SharePoint 에서 파일 ${result.deleted.length}개가 삭제되었습니다.`);
        await this.audit('DELETED', result.deleted, 'SharePoint 에서 직접 삭제되었습니다.');
      }
    } catch (err) {
      // Delta cursors can expire after a long outage. Rebuild from the feature
      // activation timestamp rather than jumping to "now", so no manual
      // upload is silently lost. Replaying is safe because managed names are
      // skipped and successful renames are idempotent at the rule level.
      if (err instanceof GraphApiError && err.status === 410) {
        try {
          const recoveredCursor = await this.sharePoint.initializeManualReconcileCursor(
            this.enabledAt
          );
          await this.settings.set(CURSOR_KEY, recoveredCursor);
          this.cursor = recoveredCursor;
          console.warn(
            '[manual-rename] 만료된 변경 추적 토큰을 자동 복구했습니다. 다음 주기에 다시 확인합니다.'
          );
        } catch (recoveryError) {
          console.error('[manual-rename] 변경 추적 토큰 복구에 실패했습니다.', recoveryError);
        }
        return;
      }

      // Keep the cursor unchanged. A transient Graph or storage error is then
      // retried without losing the change window.
      console.error('[manual-rename] 변경 파일 확인 실패 — 다음 주기에 다시 시도합니다.', err);
    } finally {
      this.running = false;
    }
  }

  /** Starts a fresh delta baseline after the admin switches Teams/SharePoint target. */
  async resetForTarget(): Promise<void> {
    if (!config.manualRename.enabled || !this.sharePoint.getConfigStatus().isLiveConfigured) {
      this.cursor = '';
      await this.settings.set(CURSOR_KEY, '');
      return;
    }
    this.enabledAt = new Date();
    this.cursor = await this.sharePoint.initializeManualReconcileCursor(this.enabledAt);
    await this.settings.set(ENABLED_AT_KEY, this.enabledAt.toISOString());
    await this.settings.set(CURSOR_KEY, this.cursor);
    if (!this.timer) {
      this.timer = setInterval(() => void this.runOnce(), config.manualRename.intervalMs);
      this.timer.unref();
    }
  }

  shutdown(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
