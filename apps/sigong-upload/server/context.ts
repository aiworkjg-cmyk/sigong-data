import { SharePointService, loadFolderRuleFromEnv } from '@jg/sharepoint-core';
import { AdminDirectory } from './admin-directory';
import { config, ensureDataDirs, validateConfig } from './config';
import { mailer } from './mailer';
import { createRepositories, type Repositories } from './repositories';
import { SubmissionIntake } from './submission';
import { SubmissionWorker } from './worker';

export interface AppContext {
  repos: Repositories;
  sharePoint: SharePointService;
  intake: SubmissionIntake;
  worker: SubmissionWorker;
  directory: AdminDirectory;
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
  const worker = new SubmissionWorker(repos, sharePoint);

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

  return {
    repos,
    sharePoint,
    intake: new SubmissionIntake(repos, sharePoint),
    worker,
    directory: new AdminDirectory(repos.admins),
    warnings,
  };
}
