import type {
  AssignableRole, Issue, Paged, SiteRecord, UploadLog, WorkOrder, WorkOrderSort, WorkOrderStatus,
} from '../../src/types';

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Narrows a site listing. Every field is an AND; an omitted field is "any".
 *
 * `constructionTypes` and `technicianId` are the permission boundary — the
 * route fills them from the signed-in account's scope, never from the query
 * string — while the date range and search are the user's own filters.
 */
export interface SiteFilter extends ListOptions {
  constructionTypes?: string[];
  technicianId?: string;
  /** Inclusive 시공일 range, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

export interface SiteRepository {
  list(options?: SiteFilter): Promise<Paged<SiteRecord>>;
  get(id: string): Promise<SiteRecord | null>;
  save(record: SiteRecord): Promise<void>;
  /**
   * Submissions that were accepted but never reached a terminal state — used on
   * boot to re-queue work that a restart interrupted mid-upload.
   */
  listUnfinished(limit?: number): Promise<SiteRecord[]>;
}

export interface UploadLogFilter extends ListOptions {
  /** Restrict to one outcome; omit for every attempt. */
  result?: UploadLog['result'];
  siteId?: string;
}

export interface UploadLogRepository {
  list(filter?: UploadLogFilter): Promise<Paged<UploadLog>>;
  append(log: UploadLog): Promise<void>;
  /** Aggregate counters for the admin dashboard. */
  summary(days: number): Promise<UploadLogSummary>;
}

export interface UploadLogSummary {
  days: number;
  total: number;
  success: number;
  partial: number;
  failed: number;
  totalBytes: number;
  fileCount: number;
}

export interface IssueFilter extends ListOptions {
  status?: Issue['status'];
  siteId?: string;
}

export interface IssueRepository {
  list(filter?: IssueFilter): Promise<Paged<Issue>>;
  get(id: string): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * An admin account held in the record backend. The master account is not stored
 * here — it comes from environment configuration and always exists, so losing
 * the table can never lock everyone out. passwordHash stays server-side.
 */
export interface StoredAdminUser {
  username: string;
  displayName: string;
  /** 관리자(COMPANY) or 시공기사(TECH). */
  role: AssignableRole;
  /** COMPANY only — the 시공종류 this account may read. */
  constructionTypes: string[];
  /** TECH only — the roster entry this account is linked to. */
  technicianId?: string;
  passwordHash: string;
  createdAt: string;
  createdBy: string;
  disabled: boolean;
  lastLoginAt?: string;
}

/**
 * Normalizes a stored row into the current shape.
 *
 * Accounts written under the previous two-role model carry ADMIN / STAFF and no
 * scope fields. ADMIN was "everything but accounts", which is closest to the new
 * 업체 관리자; STAFF was read-only, which is closest to 시공기사. Neither has a
 * scope yet, so both land with an empty one and the master assigns it — a
 * migrated account can therefore log in but sees nothing until that happens,
 * which is the safe direction to fail.
 */
import { normalizeRegionGroup } from '../../src/types';

export { compareWorkOrders } from '../../src/types';

export function normalizeStoredAdmin(raw: any): StoredAdminUser {
  const legacy = raw?.role === 'ADMIN' ? 'COMPANY' : raw?.role === 'STAFF' ? 'TECH' : null;
  const role: AssignableRole =
    raw?.role === 'COMPANY' || raw?.role === 'TECH' ? raw.role : (legacy ?? 'TECH');

  return {
    username: raw.username,
    displayName: raw.displayName || raw.username,
    role,
    constructionTypes: Array.isArray(raw.constructionTypes)
      ? raw.constructionTypes.filter((value: unknown) => typeof value === 'string')
      : [],
    technicianId: raw.technicianId || undefined,
    passwordHash: raw.passwordHash || '',
    createdAt: raw.createdAt || '',
    createdBy: raw.createdBy || '',
    disabled: Boolean(raw.disabled),
    lastLoginAt: raw.lastLoginAt || undefined,
  };
}

export interface AdminUserRepository {
  list(): Promise<StoredAdminUser[]>;
  get(username: string): Promise<StoredAdminUser | null>;
  save(user: StoredAdminUser): Promise<void>;
  remove(username: string): Promise<void>;
}

/**
 * Small key/value store for settings an admin can change at runtime, such as
 * the 시공종류 list. Values are opaque strings; the caller decides the encoding
 * (the 시공종류 list is stored as a JSON array).
 */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Submissions still awaiting (or retrying) their upload to the library. */
export interface PendingSubmission {
  siteId: string;
  attempts: number;
  nextAttemptAt: string;
}

/** Narrows the 주문 목록. Every field is an AND; an omitted field is "any". */
export interface WorkOrderFilter extends ListOptions {
  constructionTypes?: string[];
  status?: WorkOrderStatus;
  /** Inclusive 시공예정일 range, YYYY-MM-DD. */
  from?: string;
  to?: string;
  region?: string;
  /** 주문서 시트 이름에서 온 현장종류. 기사 화면에서 한 단계 좁힐 때 씁니다. */
  siteType?: string;
  /** 서울 / 수도권 / 충남 … */
  regionGroup?: string;
  /** true 면 값이 덜 채워진 건만. 시트에서 미완성으로 들어온 것을 찾을 때. */
  incompleteOnly?: boolean;
  /**
   * 주문서에 적힌 담당 기사. 이름만 비교합니다 — 주문서에는 "유동현 팀장" 처럼
   * 직함이 붙어 오고 명부에는 이름만 있어서, 정확히 같기를 기대할 수 없습니다.
   */
  technicianName?: string;
  /** Free text across 주소 / 주문자 / 주문번호. */
  search?: string;
  /** 정렬 기준. 비우면 원본 시트의 줄 순서입니다. */
  sort?: WorkOrderSort;
}


export interface WorkOrderRepository {
  list(filter?: WorkOrderFilter): Promise<Paged<WorkOrder>>;
  get(id: string): Promise<WorkOrder | null>;
  /** Looks an order up by its source identity, for re-import and sheet sync. */
  findBySourceKey(sourceKey: string): Promise<WorkOrder | null>;
  save(order: WorkOrder): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * 여러 건을 한 번에 지웁니다.
   *
   * 한 건씩 지우면 JSON 저장소가 그때마다 파일 전체를 다시 씁니다. 동기화
   * 한 번에 백 건이 사라지는 일이 정상적으로 일어나는데, 그러면 파일 쓰기가
   * 백 번 몰아쳐 Windows 에서 잠금 충돌(EPERM)이 납니다.
   */
  removeMany(ids: string[]): Promise<void>;
}

export interface Repositories {
  sites: SiteRepository;
  workOrders: WorkOrderRepository;
  logs: UploadLogRepository;
  issues: IssueRepository;
  admins: AdminUserRepository;
  settings: SettingsRepository;
  /** Which backend is actually in use, surfaced in the admin diagnostics. */
  backend: 'AZURE_TABLES' | 'LOCAL_JSON';
}

/**
 * Table Storage sorts rows by RowKey ascending. Prefixing keys with a
 * descending counter makes "newest first" the natural read order, so listing
 * recent activity never needs a full scan and sort.
 */
export function descendingKey(at: string | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  const safe = Number.isFinite(ms) ? ms : Date.now();
  const inverted = 9_999_999_999_999 - safe;
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${String(inverted).padStart(13, '0')}-${suffix}`;
}


/** Shared by the JSON store and the Table store's in-memory second pass. */
export function matchesWorkOrderFilter(order: WorkOrder, filter: WorkOrderFilter): boolean {
  if (filter.constructionTypes && !filter.constructionTypes.includes(order.constructionType)) return false;
  if (filter.status && order.status !== filter.status) return false;
  if (filter.from && order.scheduledDate < filter.from) return false;
  if (filter.to && order.scheduledDate > filter.to) return false;
  if (filter.region && order.region !== filter.region) return false;
  if (filter.regionGroup && normalizeRegionGroup(order.regionGroup) !== filter.regionGroup) {
    return false;
  }
  if (filter.incompleteOnly && !order.incomplete) return false;
  if (filter.siteType && (order.siteType || '') !== filter.siteType) return false;

  if (filter.technicianName) {
    // 양쪽 다 공백을 지우고 "포함" 으로 비교합니다. 주문서의 "유동현 팀장" 과
    // 명부의 "유동현" 이 같은 사람이라는 것을 알아보려면 이 방법뿐입니다.
    const squeeze = (value: string) => (value || '').replace(/\s+/g, '');
    const wanted = squeeze(filter.technicianName);
    const actual = squeeze(order.technicianName || '');
    if (!wanted || !actual.includes(wanted)) return false;
  }

  if (filter.search) {
    // Whitespace is ignored on both sides: an address is written with different
    // spacing by every person who types one, and "광명시 하안동" must find a row
    // stored as "광명시하안동".
    const squeeze = (value: string) => value.toLowerCase().replace(/\s+/g, '');
    const needle = squeeze(filter.search);
    const haystack = squeeze(
      [order.address, order.customerName, order.orderNumber, order.building, order.phone]
        .filter(Boolean)
        .join(' ')
    );
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
