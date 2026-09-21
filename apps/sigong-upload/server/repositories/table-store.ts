import { TableClient, TableServiceClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from '../config';
import { encodeSettingsValue, decodeSettingsValue } from './settings-value';
import { matchesSiteFilter } from './json-store';
import { TERMINAL_STATUSES } from '../../src/types';
import type { Issue, Paged, SiteRecord, UploadLog, WorkOrder } from '../../src/types';
import {
  descendingKey,
  compareWorkOrders,
  matchesWorkOrderFilter,
  normalizeStoredAdmin,
  type AdminUserRepository,
  type StoredAdminUser,
  type IssueFilter,
  type IssueRepository,
  type ListOptions,
  type Repositories,
  type SettingsRepository,
  type SiteFilter,
  type SiteRepository,
  type UploadLogFilter,
  type UploadLogRepository,
  type UploadLogSummary,
  type WorkOrderFilter,
  type WorkOrderRepository,
} from './types';

const SITES_PARTITION = 'SITE';
const LOGS_PARTITION = 'LOG';
const ISSUES_PARTITION = 'ISSUE';
const ADMINS_PARTITION = 'ADMIN';
const SETTINGS_PARTITION = 'SETTING';
const ORDERS_PARTITION = 'ORDER';
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
    siteType: site.siteType || '',
    customerName: site.customerName || '',
    customFieldsJson: JSON.stringify(site.customFields || []),
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
    // Table Storage has no nested types; lists ride along as JSON.
    filesJson: JSON.stringify(site.files || []),
    techniciansJson: JSON.stringify(site.technicians || []),
  };
}

/** OData string literals escape a single quote by doubling it. */
function escapeOdata(value: string): string {
  return value.replace(/'/g, "''");
}

function entityToSite(entity: any): SiteRecord {
  return {
    id: entity.siteId,
    constructionType: entity.constructionType || '',
    siteType: entity.siteType || undefined,
    customerName: entity.customerName || undefined,
    customFields: entity.customFieldsJson ? JSON.parse(entity.customFieldsJson) : [],
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
    technicians: entity.techniciansJson ? JSON.parse(entity.techniciansJson) : [],
  };
}

class TableSiteRepository implements SiteRepository {
  /** Caches siteId -> rowKey so updates are point operations, not scans. */
  private rowKeys = new Map<string, string>();

  constructor(private readonly client: TableClient) {}

  async list(options: SiteFilter = {}): Promise<Paged<SiteRecord>> {
    const clauses = [`PartitionKey eq '${SITES_PARTITION}'`];

    // 시공종류 and the date range are real columns, so push them down to the
    // service. The technician list lives inside a JSON column and cannot be
    // queried there, so it is applied to each page after it comes back — that
    // can yield a short page, but the cursor still advances correctly.
    if (options.constructionTypes?.length) {
      const types = options.constructionTypes
        .map((type) => `constructionType eq '${escapeOdata(type)}'`)
        .join(' or ');
      clauses.push(`(${types})`);
    }
    if (options.from) clauses.push(`constructionDate ge '${escapeOdata(options.from)}'`);
    if (options.to) clauses.push(`constructionDate le '${escapeOdata(options.to)}'`);

    const page = await readPage(
      this.client,
      clauses.join(' and '),
      options.limit ?? DEFAULT_LIMIT,
      options.cursor,
      (entity) => {
        this.rowKeys.set(entity.siteId, entity.rowKey);
        return entityToSite(entity);
      }
    );

    return {
      ...page,
      items: page.items.filter((site) => matchesSiteFilter(site, options)),
    };
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
        role: user.role,
        // Table Storage has no list type; the scope rides along as JSON.
        constructionTypesJson: JSON.stringify(user.constructionTypes || []),
        technicianId: user.technicianId || '',
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
  let constructionTypes: string[] = [];
  try {
    const parsed = JSON.parse(entity.constructionTypesJson || '[]');
    if (Array.isArray(parsed)) constructionTypes = parsed;
  } catch {
    // A malformed scope must not break the login path; an empty scope shows
    // nothing, which the master can then correct in 계정 관리.
    constructionTypes = [];
  }

  return normalizeStoredAdmin({
    username: entity.rowKey,
    displayName: entity.displayName,
    role: entity.role,
    constructionTypes,
    technicianId: entity.technicianId,
    passwordHash: entity.passwordHash,
    createdAt: entity.createdAt,
    createdBy: entity.createdBy,
    disabled: entity.disabled,
    lastLoginAt: entity.lastLoginAt,
  });
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

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class TableSettingsRepository implements SettingsRepository {
  constructor(private readonly client: TableClient) {}

  async get(key: string): Promise<string | null> {
    try {
      const entity: any = await this.client.getEntity(SETTINGS_PARTITION, key);
      return decodeSettingsValue(entity);
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.upsertEntity(
      {
        partitionKey: SETTINGS_PARTITION,
        rowKey: key,
        ...encodeSettingsValue(value),
        updatedAt: new Date().toISOString(),
      },
      'Replace'
    );
  }
}

/**
 * 주문 목록.
 *
 * The row key is the 시공예정일 followed by the id, so Table Storage's own
 * ascending key order is already the order the technician's list wants — no
 * client-side sort, and a date-range read is a key range rather than a scan.
 */
class TableWorkOrderRepository implements WorkOrderRepository {
  constructor(private readonly client: TableClient) {}

  private rowKey(order: WorkOrder): string {
    return `${order.scheduledDate || '0000-00-00'}-${order.id}`;
  }

  async list(filter: WorkOrderFilter = {}): Promise<Paged<WorkOrder>> {
    const clauses = [`PartitionKey eq '${ORDERS_PARTITION}'`];
    if (filter.constructionTypes?.length) {
      clauses.push(
        `(${filter.constructionTypes
          .map((type) => `constructionType eq '${escapeOdata(type)}'`)
          .join(' or ')})`
      );
    }
    if (filter.status) clauses.push(`status eq '${escapeOdata(filter.status)}'`);
    if (filter.from) clauses.push(`scheduledDate ge '${escapeOdata(filter.from)}'`);
    if (filter.to) clauses.push(`scheduledDate le '${escapeOdata(filter.to)}'`);

    const page = await readPage(
      this.client,
      clauses.join(' and '),
      filter.limit ?? DEFAULT_LIMIT,
      filter.cursor,
      entityToOrder
    );
    // Free-text search spans a JSON column, so it cannot be pushed down; it is
    // applied per page, which can yield a short page but never a wrong cursor.
    return {
      ...page,
      items: page.items
        .filter((order) => matchesWorkOrderFilter(order, filter))
        .sort(compareWorkOrders(filter.sort)),
    };
  }

  private async findEntity(id: string): Promise<any | null> {
    const iterator = this.client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${ORDERS_PARTITION} and id eq ${id}` },
    });
    for await (const entity of iterator) return entity;
    return null;
  }

  async get(id: string): Promise<WorkOrder | null> {
    const entity = await this.findEntity(id);
    return entity ? entityToOrder(entity) : null;
  }

  async findBySourceKey(sourceKey: string): Promise<WorkOrder | null> {
    const iterator = this.client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${ORDERS_PARTITION} and sourceKey eq ${sourceKey}` },
    });
    for await (const entity of iterator) return entityToOrder(entity);
    return null;
  }

  async save(order: WorkOrder): Promise<void> {
    // The scheduled date is part of the row key, so a rescheduled order has to
    // move rather than be updated in place — otherwise two rows would answer
    // for one id.
    const existing = await this.findEntity(order.id);
    const nextKey = this.rowKey(order);
    if (existing && existing.rowKey !== nextKey) {
      await this.client.deleteEntity(ORDERS_PARTITION, existing.rowKey as string);
    }

    await this.client.upsertEntity(
      {
        partitionKey: ORDERS_PARTITION,
        rowKey: nextKey,
        id: order.id,
        constructionType: order.constructionType,
        status: order.status,
        scheduledDate: order.scheduledDate,
        region: order.region,
        sourceKey: order.sourceKey,
        payload: JSON.stringify(order),
      },
      'Replace'
    );
  }

  async remove(id: string): Promise<void> {
    const entity = await this.findEntity(id);
    if (entity) await this.client.deleteEntity(ORDERS_PARTITION, entity.rowKey as string);
  }

  /** 테이블 저장소에는 한 번에 지우는 이점이 없습니다 — 한 건씩 지웁니다. */
  async removeMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.remove(id);
  }
}

/**
 * The whole order is kept as one JSON column.
 *
 * Only the fields the service actually filters on are promoted to real columns.
 * An order sheet grows new columns constantly, and a schema that had to be
 * migrated every time one appeared would be a liability, not a safeguard.
 */
function entityToOrder(entity: any): WorkOrder {
  const parsed = entity.payload ? JSON.parse(entity.payload) : {};
  return {
    ...parsed,
    id: entity.id ?? parsed.id,
    constructionType: entity.constructionType ?? parsed.constructionType,
    status: entity.status ?? parsed.status,
    scheduledDate: entity.scheduledDate ?? parsed.scheduledDate,
    extras: Array.isArray(parsed.extras) ? parsed.extras : [],
    editedFields: Array.isArray(parsed.editedFields) ? parsed.editedFields : [],
  };
}

export async function createTableRepositories(): Promise<Repositories> {
  const names = {
    sites: tableName('Sites'),
    workOrders: tableName('WorkOrders'),
    logs: tableName('UploadLogs'),
    issues: tableName('Issues'),
    admins: tableName('Admins'),
    settings: tableName('Settings'),
  };

  await ensureTables(Object.values(names));

  return {
    sites: new TableSiteRepository(createClient(names.sites)),
    workOrders: new TableWorkOrderRepository(createClient(names.workOrders)),
    logs: new TableUploadLogRepository(createClient(names.logs)),
    issues: new TableIssueRepository(createClient(names.issues)),
    admins: new TableAdminUserRepository(createClient(names.admins)),
    settings: new TableSettingsRepository(createClient(names.settings)),
    backend: 'AZURE_TABLES',
  };
}
