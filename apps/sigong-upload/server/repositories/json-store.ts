import fs from 'fs';
import path from 'path';
import { config } from '../config';
import type { Issue, Paged, SiteRecord, UploadLog } from '../../src/types';
import type {
  IssueFilter,
  IssueRepository,
  ListOptions,
  Repositories,
  SiteRepository,
  UploadLogFilter,
  UploadLogRepository,
  UploadLogSummary,
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
      await fs.promises.rename(temp, this.file);
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

  async list(options?: ListOptions): Promise<Paged<SiteRecord>> {
    const sorted = [...this.collection.all()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return paginate(sorted, options);
  }

  async get(id: string): Promise<SiteRecord | null> {
    return this.collection.all().find((site) => site.id === id) ?? null;
  }

  async save(record: SiteRecord): Promise<void> {
    await this.collection.upsert(record, (site) => site.id === record.id);
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

export function createJsonRepositories(): Repositories {
  const dir = config.paths.jsonStore;
  fs.mkdirSync(dir, { recursive: true });

  return {
    sites: new JsonSiteRepository(new JsonCollection(path.join(dir, 'sites.json'))),
    logs: new JsonUploadLogRepository(new JsonCollection(path.join(dir, 'upload-logs.json'))),
    issues: new JsonIssueRepository(new JsonCollection(path.join(dir, 'issues.json'))),
    backend: 'LOCAL_JSON',
  };
}
