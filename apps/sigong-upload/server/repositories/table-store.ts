import { TableClient, TableServiceClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from '../config';
import { TERMINAL_STATUSES } from '../../src/types';
import type { Issue, Paged, SiteRecord, UploadLog } from '../../src/types';
import {
  descendingKey,
  type AdminUserRepository,
  type StoredAdminUser,
  type IssueFilter,
  type IssueRepository,
  type ListOptions,
  type Repositories,
  type SiteRepository,
  type UploadLogFilter,
  type UploadLogRepository,
  type UploadLogSummary,
} from './types';

const SITES_PARTITION = 'SITE';
const LOGS_PARTITION = 'LOG';
const ISSUES_PARTITION = 'ISSUE';
const ADMINS_PARTITION = 'ADMIN';
const DEFAULT_LIMIT = 50;

function tableName(suffix: string): string {
  // Table names must be alphanumeric and start with a letter.
  return `${config.tables.prefix}${suffix}`.replace(/[^A-Za-z0-9]/g, '');
}

function createClient(name: string): TableClient {
  if (config.tables.connectionString) {
    return TableClient.fromConnectionString(config.tables.connectionString, name, {
      allowInsecureConnection: config.tables.connectionString.includes('UseDevelopmentStorage'),
    });
  }
  // Managed identity — the preferred production path, no secret to rotate.
  return new TableClient(
    `https://${config.tables.accountName}.table.core.windows.net`,
    name,
    new DefaultAzureCredential()
  );
}

/** Creates the tables on first boot; an existing table is not an error. */
async function ensureTables(names: string[]): Promise<void> {
  const service = config.tables.connectionString
    ? TableServiceClient.fromConnectionString(config.tables.connectionString)
    : new TableServiceClient(
        `https://${config.tables.accountName}.table.core.windows.net`,
        new DefaultAzureCredential()
      );

  for (const name of names) {
    try {
      await service.createTable(name);
    } catch (err: any) {
      if (err?.statusCode !== 409) throw err;
    }
  }
}

/**
 * Reads one page. Table Storage caps a page at 1000 entities and returns a
 * continuation token, which is passed back to the client as an opaque cursor.
 */
async function readPage<T>(
  client: TableClient,
  filter: string,
  limit: number,
  cursor: string | undefined,
  map: (entity: any) => T
): Promise<Paged<T>> {
  const iterator = client
    .listEntities({ queryOptions: { filter } })
    .byPage({ maxPageSize: Math.min(limit, 1000), continuationToken: cursor });

  const page = await iterator.next();
  if (page.done || !page.value) return { items: [] };

  return {
    items: (page.value as any[]).map(map),
    nextCursor: (page.value as any).continuationToken || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

function siteToEntity(site: SiteRecord) {
  return {
    partitionKey: SITES_PARTITION,
    // Descending key keeps listings newest-first without a client-side sort.
    rowKey: descendingKey(site.createdAt),
    siteId: site.id,
    constructionType: site.constructionType,
    managerName: site.managerName,
    address: site.address,
    constructionDate: site.constructionDate,
    notes: site.notes,
    createdAt: site.createdAt,
    status: site.status,
    storageMode: site.storageMode,
    folderPath: site.folderPath,
    attachmentsFolderPath: site.attachmentsFolderPath,
    webUrl: site.webUrl || '',
    syncMessage: site.syncMessage || '',
    syncedAt: site.syncedAt || '',
    retryAvailable: Boolean(site.retryAvailable),
    attempts: site.attempts ?? 0,
    // Table Storage has no nested types; the file list rides along as JSON.
    filesJson: JSON.stringify(site.files || []),
  };
}

function entityToSite(entity: any): SiteRecord {
  return {
    id: entity.siteId,
    constructionType: entity.constructionType || '',
    managerName: entity.managerName || '',
    address: entity.address || '',
    constructionDate: entity.constructionDate || '',
    notes: entity.notes || '',
    createdAt: entity.createdAt,
    status: entity.status,
    storageMode: entity.storageMode,
    folderPath: entity.folderPath || '',
    attachmentsFolderPath: entity.attachmentsFolderPath || '',
    webUrl: entity.webUrl || undefined,
    syncMessage: entity.syncMessage || undefined,
    syncedAt: entity.syncedAt || undefined,
    retryAvailable: Boolean(entity.retryAvailable),
    attempts: Number(entity.attempts) || 0,
    files: entity.filesJson ? JSON.parse(entity.filesJson) : [],
  };
}

class TableSiteRepository implements SiteRepository {
  /** Caches siteId -> rowKey so updates are point operations, not scans. */
  private rowKeys = new Map<string, string>();

  constructor(private readonly client: TableClient) {}

  async list(options: ListOptions = {}): Promise<Paged<SiteRecord>> {
    const page = await readPage(
      this.client,
      odata`PartitionKey eq ${SITES_PARTITION}`,
      options.limit ?? DEFAULT_LIMIT,
      options.cursor,
      (entity) => {
        this.rowKeys.set(entity.siteId, entity.rowKey);
        return entityToSite(entity);
      }
    );
    return page;
  }

  private async findEntity(id: string): Promise<any | null> {
    const cachedRowKey = this.rowKeys.get(id);
    if (cachedRowKey) {
      try {
        return await this.client.getEntity(SITES_PARTITION, cachedRowKey);
      } catch (err: any) {
        if (err?.statusCode !== 404) throw err;
        this.rowKeys.delete(id);
      }
    }

    // The row key encodes creation time, not the id, so fall back to a filtered
    // read. Volume here is low enough that this stays inexpensive.
    const iterator = this.client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${SITES_PARTITION} and siteId eq ${id}` },
    });

    for await (const entity of iterator) {
      this.rowKeys.set(id, entity.rowKey as string);
      return entity;
    }
    return null;
  }

  async get(id: string): Promise<SiteRecord | null> {
    const entity = await this.findEntity(id);
    return entity ? entityToSite(entity) : null;
  }

  async save(record: SiteRecord): Promise<void> {
    const existing = await this.findEntity(record.id);
    const entity = siteToEntity(record);

    if (existing) {
      // Preserve the original row key so the record keeps its position.
      entity.rowKey = existing.rowKey;
    }
    this.rowKeys.set(record.id, entity.rowKey);
    await this.client.upsertEntity(entity, 'Replace');
  }

  async listUnfinished(limit = 200): Promise<SiteRecord[]> {
    // Small set by design — anything lingering here is work still owed.
    const terminal = TERMINAL_STATUSES.map((status) => `status ne '${status}'`).join(' and ');
    const iterator = this.client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${SITES_PARTITION}' and ${terminal}` },
    });

    const pending: SiteRecord[] = [];
    for await (const entity of iterator) {
      this.rowKeys.set(entity.siteId as string, entity.rowKey as string);
      pending.push(entityToSite(entity));
      if (pending.length >= limit) break;
    }
    // Oldest first so a backlog drains in submission order.
    return pending.reverse();
  }
}

class TableAdminUserRepository implements AdminUserRepository {
  constructor(private readonly client: TableClient) {}

  async list(): Promise<StoredAdminUser[]> {
    const iterator = this.client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${ADMINS_PARTITION}` },
    });

    const users: StoredAdminUser[] = [];
    for await (const entity of iterator) {
      users.push(entityToAdminUser(entity));
    }
    return users.sort((a, b) => a.username.localeCompare(b.username));
  }

  async get(username: string): Promise<StoredAdminUser | null> {
    try {
      return entityToAdminUser(await this.client.getEntity(ADMINS_PARTITION, username));
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async save(user: StoredAdminUser): Promise<void> {
    await this.client.upsertEntity(
      {
        partitionKey: ADMINS_PARTITION,
        rowKey: user.username,
        displayName: user.displayName,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
        createdBy: user.createdBy,
        disabled: user.disabled,
        lastLoginAt: user.lastLoginAt || '',
      },
      'Replace'
    );
  }

  async remove(username: string): Promise<void> {
    try {
      await this.client.deleteEntity(ADMINS_PARTITION, username);
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
  }
}

function entityToAdminUser(entity: any): StoredAdminUser {
  return {
    username: entity.rowKey,
    displayName: entity.displayName || entity.rowKey,
    passwordHash: entity.passwordHash || '',
    createdAt: entity.createdAt,
    createdBy: entity.createdBy || '',
    disabled: Boolean(entity.disabled),
    lastLoginAt: entity.lastLoginAt || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Upload logs                                                         */
/* ------------------------------------------------------------------ */

class TableUploadLogRepository implements UploadLogRepository {
  constructor(private readonly client: TableClient) {}

  async append(log: UploadLog): Promise<void> {
    await this.client.createEntity({
      partitionKey: LOGS_PARTITION,
      rowKey: descendingKey(log.at),
      logId: log.id,
      at: log.at,
      siteId: log.siteId,
      constructionType: log.constructionType,
      managerName: log.managerName,
      address: log.address,
      fileCount: log.fileCount,
      totalBytes: log.totalBytes,
      durationMs: log.durationMs,
      result: log.result,
      mode: log.mode,
      folderPath: log.folderPath,
      message: log.message,
      clientIp: log.clientIp,
      userAgent: (log.userAgent || '').slice(0, 512),
      errorsJson: JSON.stringify(log.errors || []),
    });
  }

  async list(filter: UploadLogFilter = {}): Promise<Paged<UploadLog>> {
    const clauses = [odata`PartitionKey eq ${LOGS_PARTITION}`];
    if (filter.result) clauses.push(odata`result eq ${filter.result}`);
    if (filter.siteId) clauses.push(odata`siteId eq ${filter.siteId}`);

    return readPage(
      this.client,
      clauses.join(' and '),
      filter.limit ?? DEFAULT_LIMIT,
      filter.cursor,
      (entity) => ({
        id: entity.logId,
        at: entity.at,
        siteId: entity.siteId || '',
        constructionType: entity.constructionType || '',
        managerName: entity.managerName || '',
        address: entity.address || '',
        fileCount: Number(entity.fileCount) || 0,
        totalBytes: Number(entity.totalBytes) || 0,
        durationMs: Number(entity.durationMs) || 0,
        result: entity.result,
        mode: entity.mode,
        folderPath: entity.folderPath || '',
        message: entity.message || '',
        clientIp: entity.clientIp || '',
        userAgent: entity.userAgent || '',
        errors: entity.errorsJson ? JSON.parse(entity.errorsJson) : [],
      })
    );
  }

  async summary(days: number): Promise<UploadLogSummary> {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const iterator = this.client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${LOGS_PARTITION} and at ge ${since}` },
    });

    const totals: UploadLogSummary = {
      days,
      total: 0,
      success: 0,
      partial: 0,
      failed: 0,
      totalBytes: 0,
      fileCount: 0,
    };

    for await (const entity of iterator) {
      totals.total += 1;
      totals.totalBytes += Number(entity.totalBytes) || 0;
      totals.fileCount += Number(entity.fileCount) || 0;
      if (entity.result === 'SUCCESS') totals.success += 1;
      else if (entity.result === 'PARTIAL') totals.partial += 1;
      else totals.failed += 1;
    }

    return totals;
  }
}

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

function entityToIssue(entity: any): Issue {
  return {
    id: entity.rowKey,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    siteId: entity.siteId || undefined,
    title: entity.title || '',
    body: entity.body || '',
    status: entity.status,
    priority: entity.priority,
    author: entity.author || '',
    comments: entity.commentsJson ? JSON.parse(entity.commentsJson) : [],
  };
}

class TableIssueRepository implements IssueRepository {
  constructor(private readonly client: TableClient) {}

  async list(filter: IssueFilter = {}): Promise<Paged<Issue>> {
    const clauses = [odata`PartitionKey eq ${ISSUES_PARTITION}`];
    if (filter.status) clauses.push(odata`status eq ${filter.status}`);
    if (filter.siteId) clauses.push(odata`siteId eq ${filter.siteId}`);

    return readPage(
      this.client,
      clauses.join(' and '),
      filter.limit ?? DEFAULT_LIMIT,
      filter.cursor,
      entityToIssue
    );
  }

  async get(id: string): Promise<Issue | null> {
    try {
      const entity = await this.client.getEntity(ISSUES_PARTITION, id);
      return entityToIssue(entity);
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async save(issue: Issue): Promise<void> {
    await this.client.upsertEntity(
      {
        partitionKey: ISSUES_PARTITION,
        rowKey: issue.id,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        siteId: issue.siteId || '',
        title: issue.title,
        body: issue.body,
        status: issue.status,
        priority: issue.priority,
        author: issue.author,
        commentsJson: JSON.stringify(issue.comments || []),
      },
      'Replace'
    );
  }

  async remove(id: string): Promise<void> {
    try {
      await this.client.deleteEntity(ISSUES_PARTITION, id);
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
  }
}

export async function createTableRepositories(): Promise<Repositories> {
  const names = {
    sites: tableName('Sites'),
    logs: tableName('UploadLogs'),
    issues: tableName('Issues'),
    admins: tableName('Admins'),
  };

  await ensureTables(Object.values(names));

  return {
    sites: new TableSiteRepository(createClient(names.sites)),
    logs: new TableUploadLogRepository(createClient(names.logs)),
    issues: new TableIssueRepository(createClient(names.issues)),
    admins: new TableAdminUserRepository(createClient(names.admins)),
    backend: 'AZURE_TABLES',
  };
}
