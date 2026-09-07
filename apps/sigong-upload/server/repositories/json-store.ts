import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TERMINAL_STATUSES } from '../../src/types';
import type { Issue, Paged, SiteRecord, UploadLog, WorkOrder } from '../../src/types';
import { compareWorkOrders, matchesWorkOrderFilter, normalizeStoredAdmin } from './types';
import type {
  AdminUserRepository,
  IssueFilter,
  IssueRepository,
  ListOptions,
  Repositories,
  SettingsRepository,
  SiteFilter,
  SiteRepository,
  StoredAdminUser,
  UploadLogFilter,
  UploadLogRepository,
  UploadLogSummary,
  WorkOrderFilter,
  WorkOrderRepository,
} from './types';

const DEFAULT_LIMIT = 50;

/**
 * File-backed store used when Azure Table Storage is not configured, so the app
 * runs locally with no cloud dependency. Records are held in memory and flushed
 * on every mutation; writes go through a temp file and rename so a crash
 * mid-write cannot leave a truncated JSON file behind.
 */
class JsonCollection<T> {
  private items: T[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        this.items = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.error(`[store] ${path.basename(this.file)} 을 읽지 못해 빈 목록으로 시작합니다.`, err);
      this.items = [];
    }
  }

  /** Serializes flushes so concurrent mutations cannot interleave writes. */
  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.items, null, 2);
    this.writing = this.writing.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(temp, snapshot, 'utf-8');

      /*
       * Windows 에서는 rename 이 EPERM 으로 실패할 때가 있습니다.
       *
       * 파일이 손상됐거나 권한이 없어서가 아니라, 그 순간 다른 무언가가 —
       * 백신 검사, 검색 인덱서, 편집기, 또 다른 개발 서버 — 대상 파일을 잠시
       * 쥐고 있어서입니다. 곧 풀리는 잠금이므로 몇 번 다시 시도하면 성공합니다.
       * 여기서 포기하면 동기화 한 회차가 통째로 실패로 기록되는데, 원인은
       * 데이터와 아무 상관이 없어서 사람이 볼 때 가장 헷갈리는 오류가 됩니다.
       */
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fs.promises.rename(temp, this.file);
          return;
        } catch (err: any) {
          if (err?.code !== 'EPERM' && err?.code !== 'EBUSY' && err?.code !== 'EACCES') throw err;
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
      // 마지막 수단: 덮어쓰기. 원자적이지는 않지만, 이 시점에는 쓰지 못하는
      // 것보다 낫습니다 — 잠금이 계속 풀리지 않는 환경이라는 뜻입니다.
      try {
        await fs.promises.writeFile(this.file, snapshot, 'utf-8');
        await fs.promises.unlink(temp).catch(() => {});
      } catch {
        throw lastError;
      }
    });
    return this.writing;
  }

  all(): T[] {
    return this.items;
  }

  async prepend(item: T): Promise<void> {
    this.items.unshift(item);
    await this.flush();
  }

  async upsert(item: T, matches: (candidate: T) => boolean): Promise<void> {
    const index = this.items.findIndex(matches);
    if (index >= 0) this.items[index] = item;
    else this.items.unshift(item);
    await this.flush();
  }

  async remove(matches: (candidate: T) => boolean): Promise<void> {
    this.items = this.items.filter((item) => !matches(item));
    await this.flush();
  }
}

/** Shared by the JSON store and by the Table store's in-memory second pass. */
export function matchesSiteFilter(site: SiteRecord, filter: SiteFilter): boolean {
  if (filter.constructionTypes && !filter.constructionTypes.includes(site.constructionType)) {
    return false;
  }
  if (filter.technicianId && !(site.technicians || []).some((t) => t.id === filter.technicianId)) {
    return false;
  }
  if (filter.from && site.constructionDate < filter.from) return false;
  if (filter.to && site.constructionDate > filter.to) return false;
  return true;
}

/** Offset-based paging; the cursor is just the next index as a string. */
function paginate<T>(items: T[], options: ListOptions = {}): Paged<T> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const start = Number(options.cursor) || 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : undefined };
}

class JsonSiteRepository implements SiteRepository {
  constructor(private readonly collection: JsonCollection<SiteRecord>) {}

  async list(options: SiteFilter = {}): Promise<Paged<SiteRecord>> {
    const sorted = this.collection
      .all()
      .filter((site) => matchesSiteFilter(site, options))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return paginate(sorted, options);
  }

  async get(id: string): Promise<SiteRecord | null> {
    return this.collection.all().find((site) => site.id === id) ?? null;
  }

  async save(record: SiteRecord): Promise<void> {
    await this.collection.upsert(record, (site) => site.id === record.id);
  }

  async listUnfinished(limit = 200): Promise<SiteRecord[]> {
    return this.collection
      .all()
      .filter((site) => !TERMINAL_STATUSES.includes(site.status))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, limit);
  }
}

class JsonAdminUserRepository implements AdminUserRepository {
  constructor(private readonly collection: JsonCollection<StoredAdminUser>) {}

  async list(): Promise<StoredAdminUser[]> {
    return [...this.collection.all()]
      .map(normalizeStoredAdmin)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async get(username: string): Promise<StoredAdminUser | null> {
    const user = this.collection.all().find((candidate) => candidate.username === username);
    return user ? normalizeStoredAdmin(user) : null;
  }

  async save(user: StoredAdminUser): Promise<void> {
    await this.collection.upsert(user, (candidate) => candidate.username === user.username);
  }

  async remove(username: string): Promise<void> {
    await this.collection.remove((user) => user.username === username);
  }
}

class JsonUploadLogRepository implements UploadLogRepository {
  constructor(private readonly collection: JsonCollection<UploadLog>) {}

  async append(log: UploadLog): Promise<void> {
    await this.collection.prepend(log);
  }

  async list(filter: UploadLogFilter = {}): Promise<Paged<UploadLog>> {
    const matching = this.collection
      .all()
      .filter((log) => (filter.result ? log.result === filter.result : true))
      .filter((log) => (filter.siteId ? log.siteId === filter.siteId : true))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return paginate(matching, filter);
  }

  async summary(days: number): Promise<UploadLogSummary> {
    const since = Date.now() - days * 86400_000;
    const recent = this.collection.all().filter((log) => new Date(log.at).getTime() >= since);

    return recent.reduce<UploadLogSummary>(
      (totals, log) => ({
        ...totals,
        total: totals.total + 1,
        success: totals.success + (log.result === 'SUCCESS' ? 1 : 0),
        partial: totals.partial + (log.result === 'PARTIAL' ? 1 : 0),
        failed: totals.failed + (log.result === 'FAILED' ? 1 : 0),
        totalBytes: totals.totalBytes + (log.totalBytes || 0),
        fileCount: totals.fileCount + (log.fileCount || 0),
      }),
      { days, total: 0, success: 0, partial: 0, failed: 0, totalBytes: 0, fileCount: 0 }
    );
  }
}

class JsonIssueRepository implements IssueRepository {
  constructor(private readonly collection: JsonCollection<Issue>) {}

  async list(filter: IssueFilter = {}): Promise<Paged<Issue>> {
    const matching = this.collection
      .all()
      .filter((issue) => (filter.status ? issue.status === filter.status : true))
      .filter((issue) => (filter.siteId ? issue.siteId === filter.siteId : true))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return paginate(matching, filter);
  }

  async get(id: string): Promise<Issue | null> {
    return this.collection.all().find((issue) => issue.id === id) ?? null;
  }

  async save(issue: Issue): Promise<void> {
    await this.collection.upsert(issue, (candidate) => candidate.id === issue.id);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove((issue) => issue.id === id);
  }
}

/**
 * Settings live in their own tiny JSON file so a bad write can never take the
 * record store down with it.
 */
class JsonSettingsRepository implements SettingsRepository {
  constructor(private readonly collection: JsonCollection<{ key: string; value: string }>) {}

  async get(key: string): Promise<string | null> {
    return this.collection.all().find((entry) => entry.key === key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.collection.upsert({ key, value }, (entry) => entry.key === key);
  }
}

/**
 * 주문 목록. Sorted by 시공예정일 ascending — the technician's list is "what is
 * coming up", so the nearest date belongs at the top, which is the opposite of
 * every other collection here.
 */
class JsonWorkOrderRepository implements WorkOrderRepository {
  constructor(private readonly collection: JsonCollection<WorkOrder>) {}

  async list(filter: WorkOrderFilter = {}): Promise<Paged<WorkOrder>> {
    const matching = this.collection
      .all()
      .filter((order) => matchesWorkOrderFilter(order, filter))
      .sort(compareWorkOrders(filter.sort));
    return paginate(matching, filter);
  }

  async get(id: string): Promise<WorkOrder | null> {
    return this.collection.all().find((order) => order.id === id) ?? null;
  }

  async findBySourceKey(sourceKey: string): Promise<WorkOrder | null> {
    return this.collection.all().find((order) => order.sourceKey === sourceKey) ?? null;
  }

  async save(order: WorkOrder): Promise<void> {
    await this.collection.upsert(order, (candidate) => candidate.id === order.id);
  }

  async remove(id: string): Promise<void> {
    await this.collection.remove((order) => order.id === id);
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const doomed = new Set(ids);
    await this.collection.remove((order) => doomed.has(order.id));
  }
}

export function createJsonRepositories(): Repositories {
  const dir = config.paths.jsonStore;
  fs.mkdirSync(dir, { recursive: true });

  return {
    sites: new JsonSiteRepository(new JsonCollection(path.join(dir, 'sites.json'))),
    workOrders: new JsonWorkOrderRepository(new JsonCollection(path.join(dir, 'work-orders.json'))),
    logs: new JsonUploadLogRepository(new JsonCollection(path.join(dir, 'upload-logs.json'))),
    issues: new JsonIssueRepository(new JsonCollection(path.join(dir, 'issues.json'))),
    admins: new JsonAdminUserRepository(new JsonCollection(path.join(dir, 'admin-users.json'))),
    settings: new JsonSettingsRepository(new JsonCollection(path.join(dir, 'settings.json'))),
    backend: 'LOCAL_JSON',
  };
}
