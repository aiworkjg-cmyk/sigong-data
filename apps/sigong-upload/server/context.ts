import { SharePointService, loadFolderRuleFromEnv } from '@jg/sharepoint-core';
import { AdminDirectory } from './admin-directory';
import { config, ensureDataDirs, validateConfig } from './config';
import { mailer } from './mailer';
import { createRepositories, type Repositories } from './repositories';
import { SettingsService } from './settings';
import { SiteIdFactory } from './site-id';
import { SubmissionIntake } from './submission';
import { SubmissionWorker } from './worker';
import { ManualUploadReconciler } from './manual-upload-reconciler';
import { MicrosoftAccountService } from './microsoft-account';
import { WorkOrderService } from './work-orders';
import { GoogleSheetService } from './google-sheet';
import { GoogleAccountService } from './google-account';

export interface AppContext {
  repos: Repositories;
  sharePoint: SharePointService;
  intake: SubmissionIntake;
  worker: SubmissionWorker;
  manualUploads: ManualUploadReconciler;
  directory: AdminDirectory;
  /** Admin-editable settings (시공종류 목록, 기사 명부). */
  settings: SettingsService;
  /** The remembered Microsoft work account used for Teams/SharePoint lookups. */
  microsoft: MicrosoftAccountService;
  /** 주문서에서 만들어진 시공 예정 현장 목록. */
  workOrders: WorkOrderService;
  /** 구글시트 실시간 연동. */
  sheets: GoogleSheetService;
  /** 연결된 구글 계정 — 비공개 시트를 읽을 때 씁니다. */
  google: GoogleAccountService;
  /** Hands out the sequential 현장 ID. */
  siteIds: SiteIdFactory;
  /** Non-fatal configuration problems, shown in the admin diagnostics panel. */
  warnings: string[];
}

/** Builds every long-lived service once, at boot. */
export async function createContext(): Promise<AppContext> {
  ensureDataDirs();

  const { errors, warnings } = validateConfig();
  if (errors.length) {
    throw new Error(`설정 오류로 서버를 시작할 수 없습니다:\n - ${errors.join('\n - ')}`);
  }

  const sharePoint = new SharePointService({
    credentials: config.sharePoint,
    rule: loadFolderRuleFromEnv(),
    testModeRoot: config.paths.testLibrary,
  });

  const repos = await createRepositories();

  // Loaded before the server accepts traffic: the submission endpoint checks
  // every upload against this list, and the worker reads the notification
  // address from it, so it has to exist before either is built.
  const settings = new SettingsService(repos.settings);
  await settings.load();

  const microsoft = new MicrosoftAccountService(repos.settings);
  await microsoft.load();

  const workOrders = new WorkOrderService(repos);
  const google = new GoogleAccountService(repos.settings);
  await google.load();
  const sheets = new GoogleSheetService(
    repos.settings,
    workOrders,
    () => settings.constructionTypes(),
    (constructionType, names) => settings.ensureSiteTypeOptions(constructionType, names),
    () => google.accessToken().catch(() => '')
  );
  await sheets.load();

  const storageTarget = settings.storageTarget();
  sharePoint.setStorageTarget({ siteId: storageTarget.siteId, driveId: storageTarget.driveId });
  sharePoint.ruleForConstructionType = (constructionType) =>
    settings.effectiveFolderRule(constructionType);
  sharePoint.rulesForManualUploads = () =>
    settings.constructionTypes().map((constructionType) =>
      settings.effectiveFolderRule(constructionType)
    );

  const worker = new SubmissionWorker(repos, sharePoint, settings);
  const manualUploads = new ManualUploadReconciler(sharePoint, repos.settings, () =>
    settings.constructionTypes().map((constructionType) =>
      settings.effectiveFolderRule(constructionType).root
    )
  );

  const siteIds = new SiteIdFactory(repos.settings);
  await siteIds.load();

  // A rule edited on screen outlives the environment it was first read from.
  sharePoint.rule = settings.folderRule();
  if (settings.constructionTypes().length === 0) {
    warnings.push('시공종류가 하나도 없습니다. 관리자 화면 > 설정에서 추가해야 자료 제출이 가능합니다.');
  }

  if (!mailer.isConfigured()) {
    warnings.push(
      '실패 알림 메일이 비활성 상태입니다. (MAIL_SENDER / ADMIN_ALERT_EMAIL / SHAREPOINT_* 설정 필요)'
    );
  }
  warnings.forEach((warning) => console.warn(`[config] ${warning}`));

  // Anything a restart interrupted resumes here rather than being lost.
  const recovered = await worker.recoverPending();
  if (recovered > 0) {
    console.log(`[worker] 미완료 제출 ${recovered}건을 이어서 처리합니다.`);
  }
  await manualUploads.start();
  // Polling starts only after the rest of the app is up, so a slow sheet cannot
  // hold the server off the port.
  sheets.start();

  return {
    repos,
    sharePoint,
    intake: new SubmissionIntake(repos, sharePoint),
    worker,
    manualUploads,
    directory: new AdminDirectory(repos.admins),
    settings,
    microsoft,
    workOrders,
    sheets,
    google,
    siteIds,
    warnings,
  };
}
