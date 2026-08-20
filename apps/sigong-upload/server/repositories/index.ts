import { config } from '../config';
import { createJsonRepositories } from './json-store';
import type { Repositories } from './types';

export * from './types';

/**
 * Picks the record backend. Azure Table Storage is used whenever it is
 * configured; otherwise the app falls back to the local JSON store so
 * development and first-run evaluation need no cloud resources.
 *
 * The Azure module is imported lazily so the @azure/* packages are only
 * resolved when they are actually needed.
 */
export async function createRepositories(): Promise<Repositories> {
  const { connectionString, accountName } = config.tables;

  if (!connectionString && !accountName) {
    return createJsonRepositories();
  }

  try {
    const { createTableRepositories } = await import('./table-store');
    return await createTableRepositories();
  } catch (err) {
    // A misconfigured storage account must not take the upload form offline;
    // fall back to local JSON and surface the reason in the admin diagnostics.
    console.error('[store] Azure Table Storage 연결에 실패해 로컬 JSON 저장소로 대체합니다.', err);
    return createJsonRepositories();
  }
}
