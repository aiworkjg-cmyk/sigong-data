import { SharePointService, loadFolderRuleFromEnv } from '@jg/sharepoint-core';
import { config, ensureDataDirs, validateConfig } from './config';
import { createRepositories, type Repositories } from './repositories';
import { SubmissionService } from './submission';

export interface AppContext {
  repos: Repositories;
  sharePoint: SharePointService;
  submissions: SubmissionService;
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
  warnings.forEach((warning) => console.warn(`[config] ${warning}`));

  const sharePoint = new SharePointService({
    credentials: config.sharePoint,
    rule: loadFolderRuleFromEnv(),
    testModeRoot: config.paths.testLibrary,
  });

  const repos = await createRepositories();

  return {
    repos,
    sharePoint,
    submissions: new SubmissionService(repos, sharePoint),
    warnings,
  };
}
