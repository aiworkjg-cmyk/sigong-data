import type { SubmissionFieldKey } from './submission-layout';
import { normalizeRegionGroup } from './region';
export type { SubmissionFieldKey };

/**
 * Domain types shared by the Express server and the React frontend.
 * The server imports these directly; keep them free of runtime dependencies.
 */

export type FileKind = 'image' | 'video' | 'other';
export type StorageMode = 'LIVE' | 'TEST_MODE';

/* ------------------------------------------------------------------ */
/* 시공기사 명부                                                        */
/* ------------------------------------------------------------------ */

export const TECHNICIAN_TITLES = ['팀장', '사수', '부사수'] as const;
export type TechnicianTitle = (typeof TECHNICIAN_TITLES)[number];

/** One person on the roster. Selected on the submission form, never typed. */
export interface Technician {
  id: string;
  name: string;
  title: TechnicianTitle;
  /**
   * 소속 업체 (시공종류). Optional and repeatable: a 업체 관계자 who also does
   * installs is tagged with their own 업체, while a freelancer shared across
   * brands can be left untagged.
   *
   * This is also the visibility boundary — a 업체 관리자 only ever sees the
   * roster entries carrying their own 업체.
   */
  constructionTypes: string[];
  /** 연락처 — optional. */
  phone?: string;
  /** 담당지역 — optional. */
  region?: string;
  createdAt: string;
  createdBy: string;
}

/**
 * The roster entries attached to a submission, copied at submission time.
 *
 * Held as a snapshot rather than a reference so renaming or promoting someone
 * later does not silently rewrite what past records say. The id is kept so a
 * 시공기사 account can still find its own history after a rename.
 */
export interface SiteTechnician {
  id: string;
  name: string;
  title: TechnicianTitle;
}

/** "홍길동(팀장), 김철수(사수)" — display and folder-name form. */
export function formatTechnicians(technicians: SiteTechnician[]): string {
  return technicians.map((tech) => `${tech.name}(${tech.title})`).join(', ');
}

export interface SiteFile {
  id: string;
  /** Name as the submitter had it on their device. */
  originalName: string;
  /** Sanitized, index-prefixed name actually written to SharePoint. */
  storedName: string;
  /**
   * The name multer actually gave the staged copy on disk.
   *
   * This is not always equal to storedName. Multer names each part as it
   * finishes, so with several files in flight the numbering it hands out can
   * differ from the order req.files ends up in — and the worker, which looked
   * for storedName on disk, silently dropped every file whose two names had
   * drifted apart. Recording the real name removes the guess.
   *
   * Optional because records written before this existed carry only storedName.
   */
  stagedName?: string;
  fileType: FileKind;
  mimeType: string;
  size: number;
  sizeFormatted: string;
  /** pending = staged on the server, not yet written to the library. */
  status: 'pending' | 'completed' | 'failed';
  /** Path inside the document library, e.g. "시공현장자료/2026-08/.../첨부파일/01_a.jpg". */
  remotePath?: string;
  /** SharePoint web URL, when the live sync returned one. */
  webUrl?: string;
  errorMessage?: string;
}

/**
 * Submissions are accepted before they are filed, so the record moves through
 * QUEUED -> PROCESSING -> a terminal state while the submitter is already gone.
 */
export type SiteStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

/** A terminal state means the background worker is finished with the record. */
export const TERMINAL_STATUSES: SiteStatus[] = ['COMPLETED', 'PARTIAL', 'FAILED'];

export interface SiteRecord {
  id: string;
  /** Product line, chosen from the configured list (백조 / 인덕션 / ...). */
  constructionType: string;
  /** Configured site category for this construction type (e.g. 롯데부산점). */
  siteType?: string;
  /** Free-text customer/orderer name captured at submission time. */
  customerName?: string;
  /** Snapshot of administrator-defined fields and their submitted values. */
  customFields?: SubmittedFieldValue[];
  /**
   * 목록에서 고른 시공건의 ID.
   *
   * 없으면 목록에 없던 현장을 직접 입력해 제출한 것입니다 — 관리자가 나중에
   * 주문서와 대조해야 하는 건이라는 뜻이므로, 빈 값 자체가 정보입니다.
   */
  workOrderId?: string;
  /** Roster entries chosen on the form. May hold several people. */
  technicians: SiteTechnician[];
  /** technicians rendered as one string — display, search, and folder token. */
  managerName: string;
  address: string;
  constructionDate: string; // YYYY-MM-DD
  notes: string;
  createdAt: string; // ISO
  status: SiteStatus;
  storageMode: StorageMode;
  /** Classification folder the submission was filed under. */
  folderPath: string;
  attachmentsFolderPath: string;
  webUrl?: string;
  syncMessage?: string;
  syncedAt?: string;
  /** Set while attachments remain staged on disk awaiting a retry. */
  retryAvailable?: boolean;
  /** How many times the background worker has attempted this submission. */
  attempts?: number;
  files: SiteFile[];
}

/**
 * 앱을 거치지 않은 SharePoint 변경 한 건.
 *
 * 업로드 로그와 별개 파일에 쌓입니다 — 업로드 로그는 이 사이트를 통한 실제
 * 업로드만 담아야 "누가 무엇을 올렸는가" 에 답할 수 있습니다.
 */
export interface ManualAuditEntry {
  at: string;
  action: 'ADDED' | 'DELETED' | 'RENAMED';
  path: string;
  name: string;
  /** Graph 가 알려 준 마지막 수정자. 모르면 빈 문자열입니다. */
  by: string;
  itemId: string;
  note: string;
}

export type UploadResult = 'SUCCESS' | 'PARTIAL' | 'FAILED';

/** One row per submission attempt — the admin audit trail. */
export interface UploadLog {
  id: string;
  at: string; // ISO
  siteId: string;
  constructionType: string;
  managerName: string;
  address: string;
  fileCount: number;
  totalBytes: number;
  durationMs: number;
  result: UploadResult;
  mode: StorageMode;
  folderPath: string;
  message: string;
  clientIp: string;
  userAgent: string;
  errors: string[];
}

export type IssueStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
export type IssuePriority = 'LOW' | 'NORMAL' | 'HIGH';

export interface IssueComment {
  id: string;
  at: string;
  author: string;
  body: string;
}

export interface Issue {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Optional link to the submission the issue is about. */
  siteId?: string;
  title: string;
  body: string;
  status: IssueStatus;
  priority: IssuePriority;
  author: string;
  comments: IssueComment[];
}

export interface FolderRuleView {
  root: string;
  segments: string[];
  attachmentsFolder: string | null;
  metadataFileName: string | null;
  maxSegmentLength: number;
}

export interface SharePointConfigStatus {
  isLiveConfigured: boolean;
  mode: StorageMode;
  tenantIdConfigured: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
  siteIdConfigured: boolean;
  driveIdConfigured: boolean;
  rootFolder: string;
  folderRule: FolderRuleView;
  examplePath: string;
  message: string;
}

export interface FolderEntry {
  name: string;
  type: 'folder' | 'file';
  size?: number;
  webUrl?: string;
}

/** Client-side per-file progress for the upload modal. */
export interface UploadProgressItem {
  fileId: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  error?: string;
}

/**
 * Account roles.
 *
 *   MASTER   마스터관리자 — the single env-configured account. Sees every
 *                           company's data and holds every setting.
 *   COMPANY  관리자       — 업체 관계자 (백조 / 한샘 ...). Sees submissions for
 *                           the 시공종류 assigned to the account, and nothing else.
 *   TECH     시공기사     — linked to a roster entry; sees only the submissions
 *                           they were listed on.
 *
 * MASTER lives in environment configuration rather than the record store, so a
 * lost or corrupted table can never lock everyone out.
 */
export type AdminRole = 'MASTER' | 'COMPANY' | 'TECH';

/** Roles that can be handed out when creating an account. */
export const ASSIGNABLE_ROLES = ['COMPANY', 'TECH'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABELS: Record<AdminRole, string> = {
  MASTER: '마스터관리자',
  COMPANY: '관리자',
  TECH: '시공기사',
};

export const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  MASTER: '모든 업체의 자료와 전체 설정',
  COMPANY: '담당 시공종류의 시공현황 전체 조회 · 기사 명부 관리',
  TECH: '본인이 참여한 시공 자료만 조회',
};

/** Only the master reaches the full admin console (로그·이슈·설정·계정). */
export function isMaster(role: AdminRole | undefined): boolean {
  return role === 'MASTER';
}

/** 마스터와 업체 관리자 — the two roles that manage the technician roster. */
export function canManageTechnicians(role: AdminRole | undefined): boolean {
  return role === 'MASTER' || role === 'COMPANY';
}

/** Only the master may delete roster entries; others must request by mail. */
export function canDeleteTechnicians(role: AdminRole | undefined): boolean {
  return role === 'MASTER';
}

export interface AdminSession {
  username: string;
  displayName: string;
  role: AdminRole;
  /** COMPANY: the 시공종류 this account may read. Empty for other roles. */
  constructionTypes: string[];
  /** TECH: the roster entry this account is. */
  technicianId?: string;
  /** ISO expiry of the signed session cookie. */
  expiresAt: string;
}

/** A stored account. The password hash never leaves the server. */
export interface AdminUser {
  username: string;
  displayName: string;
  role: AdminRole;
  /** COMPANY only — which 시공종류 the account may read. */
  constructionTypes: string[];
  /** TECH only — the roster entry this account is linked to. */
  technicianId?: string;
  createdAt: string;
  createdBy: string;
  disabled: boolean;
  lastLoginAt?: string;
}

/**
 * What a signed-in account is allowed to see in 시공현황 리스트.
 * Resolved on the server; the client never decides its own scope.
 */
export interface ViewScope {
  /** true for MASTER — no filtering at all. */
  all: boolean;
  constructionTypes: string[];
  technicianId?: string;
}

/** Public-facing progress for the submitter's confirmation screen. */
export interface SubmissionStatus {
  id: string;
  status: SiteStatus;
  totalFiles: number;
  storedFiles: number;
  message: string;
}

export interface PublicConfig {
  mode: StorageMode;
  constructionTypes: string[];
  constructionTypeConfigs: ConstructionTypeConfig[];
  /** Selectable roster for the submission form. */
  technicians: Technician[];
  /** 시공종류별 자료 업로드 입력 항목 차례. 없는 시공종류는 기본 차례. */
  submissionOrders: Record<string, SubmissionFieldKey[]>;
  maxFiles: number;
  maxFileSizeMb: number;
}

/**
 * 시공건 목록의 정렬 기준.
 *
 * 기본은 'sheet' — 원본 시트의 줄 순서입니다. 관리자가 이 목록을 여는 가장
 * 흔한 이유가 "시트와 대조해서 빠진 게 없는지 보는 것"이고, 그때는 두 화면의
 * 줄 순서가 같아야 눈으로 짚어 갈 수 있습니다. 날짜순이 편한 상황(오늘 나갈
 * 건을 훑을 때)은 따로 있으므로 고를 수 있게 둡니다.
 */
export type WorkOrderSort =
  | 'sheet'
  | 'date'
  | 'date-desc'
  | 'name'
  | 'technician'
  | 'region'
  | 'recent';

export const WORK_ORDER_SORTS: Array<{ value: WorkOrderSort; label: string }> = [
  { value: 'sheet', label: '시트 순서' },
  { value: 'date', label: '날짜 빠른순' },
  { value: 'date-desc', label: '날짜 늦은순' },
  { value: 'name', label: '현장 가나다순' },
  { value: 'technician', label: '기사 가나다순' },
  { value: 'region', label: '지역순' },
  { value: 'recent', label: '최근 등록순' },
];

/**
 * 목록 정렬. 저장소가 둘(JSON·Azure Tables)이라 비교 자체는 여기 한 곳에 둡니다.
 *
 * 시트 순서를 기본으로 삼은 이유는 대조 때문입니다 — 관리자가 이 목록을 여는
 * 가장 흔한 이유가 원본 시트와 한 줄씩 맞춰 보는 것이고, 그때 순서가 다르면
 * 두 화면을 오가며 찾아야 합니다. rowIndex 가 없는 오래된 건은 뒤로 보내되
 * 서로는 등록 순서를 지킵니다.
 */
export function compareWorkOrders(sort: WorkOrderSort = 'sheet') {
  const ko = (left = '', right = '') => left.localeCompare(right, 'ko');
  const byDate = (a: WorkOrder, b: WorkOrder) =>
    a.scheduledDate === b.scheduledDate
      ? ko(a.region, b.region)
      : a.scheduledDate.localeCompare(b.scheduledDate);

  return (a: WorkOrder, b: WorkOrder): number => {
    switch (sort) {
      case 'date':
        return byDate(a, b);
      case 'date-desc':
        return -byDate(a, b);
      case 'name':
        return ko(a.building || a.address, b.building || b.address) || byDate(a, b);
      case 'technician':
        return ko(a.technicianName || '', b.technicianName || '') || byDate(a, b);
      case 'region':
        return (
          ko(normalizeRegionGroup(a.regionGroup), normalizeRegionGroup(b.regionGroup)) ||
          ko(a.region, b.region) ||
          byDate(a, b)
        );
      case 'recent':
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      case 'sheet':
      default: {
        const left = a.rowIndex ?? Number.MAX_SAFE_INTEGER;
        const right = b.rowIndex ?? Number.MAX_SAFE_INTEGER;
        return left === right ? (a.createdAt || '').localeCompare(b.createdAt || '') : left - right;
      }
    }
  };
}

export interface ConstructionTypeConfig {
  constructionType: string;
  fields: DynamicFieldConfig[];
  folderRule: {
    root: string;
    segments: string[];
  };
}

export type DynamicFieldInputType = 'select' | 'text';

export interface DynamicFieldConfig {
  id: string;
  label: string;
  /**
   * Folder token without braces, e.g. 주문번호 — written into a folder template
   * as {주문번호}. Chosen by the administrator (defaulted from the label) rather
   * than generated, because the whole point of a token is being able to tell
   * from the template which field it stands for.
   */
  token: string;
  inputType: DynamicFieldInputType;
  required: boolean;
  options: string[];
}

export interface SubmittedFieldValue {
  id: string;
  label: string;
  token: string;
  value: string;
}

/** Human-readable Teams labels plus the actual Graph destination identifiers. */
export interface SharePointStorageTarget {
  id: string;
  /** Microsoft 365 work/school account UPN used only to find joined teams. */
  accountEmail: string;
  teamName: string;
  channelName: string;
  teamId: string;
  channelId: string;
  siteId: string;
  driveId: string;
  /** Standard channels are folders in the team's document library. */
  channelFolder: string;
}

/**
 * The Microsoft work account the app remembers, as the 설정 화면 sees it.
 * The refresh token behind it never leaves the server.
 */
export interface MicrosoftAccountView {
  /** False when the Azure app settings are missing, so sign-in cannot start. */
  configured: boolean;
  /** Must be registered on the Azure app verbatim; shown so it can be copied. */
  redirectUri: string;
  account: {
    upn: string;
    displayName: string;
    connectedAt: string;
  } | null;
  /** For tenants where individual users may not consent for themselves. */
  adminConsentUrl: string;
  /** Deep link to this app registration's 인증(Authentication) blade. */
  azureAuthBladeUrl: string;
}

export interface TeamsWebhookProfile {
  id: string;
  teamName: string;
  channelName: string;
  url: string;
}

/* ------------------------------------------------------------------ */
/* 주문서 · 시공현장 목록                                                */
/* ------------------------------------------------------------------ */

/**
 * Where a 주문 row came from. Kept on the record because it decides what a
 * re-import is allowed to overwrite: a row that is still syncing from a Google
 * Sheet must not have hand-edits silently reverted on the next poll, while an
 * abandoned one-off Excel import has nothing to defend.
 */
export { REGION_GROUPS, regionGroupOf, normalizeRegionGroup, type RegionGroup } from './region';

export type WorkOrderSource = 'EXCEL' | 'CSV' | 'IMAGE' | 'GOOGLE_SHEET' | 'MANUAL';

/**
 * OPEN      아직 자료가 제출되지 않은 시공건 — 기사 화면 목록에 보입니다.
 * SUBMITTED 자료 제출이 끝난 건. 기본적으로 목록에서 빠집니다.
 * CANCELLED 취소된 주문. 다시 나타나지 않습니다.
 */
export type WorkOrderStatus = 'OPEN' | 'SUBMITTED' | 'CANCELLED';

/** 한 건의 시공 예정 현장. 주문서 한 줄이 하나가 됩니다. */
export interface WorkOrder {
  id: string;
  /** 시공종류. 기사가 가장 먼저 고르는 값이므로 반드시 있어야 합니다. */
  constructionType: string;
  /**
   * 현장종류 — 주문서 시트 이름에서 옵니다 (예: 롯데백화점(흥주부)).
   * 폴더 규칙의 {siteType} 토큰으로 들어갑니다.
   */
  siteType?: string;
  /** 주문서에 적힌 담당 기사 이름. 기사 화면의 목록을 거르는 데 씁니다. */
  technicianName?: string;
  /**
   * 원본 시트에서의 줄 번호.
   *
   * 목록의 기본 차례가 시트와 같아야 사람이 한 건씩 짚어 가며 대조할 수
   * 있습니다. 날짜순으로 먼저 정렬해 버리면 그 대조가 불가능해집니다.
   */
  rowIndex?: number;
  /**
   * 값이 덜 채워진 채로 등록된 건. 무엇이 비었는지 적혀 있습니다.
   *
   * 비어 있으면 온전한 주문입니다. 화면에서는 이 값이 있는 건을 눈에 띄게
   * 표시하고, 따로 걸러 볼 수 있게 합니다.
   */
  incomplete?: string;
  /** 주문번호 — 있으면 재업로드 시 같은 건을 알아보는 기준이 됩니다. */
  orderNumber?: string;
  customerName: string;
  phone?: string;
  address: string;
  /** 시공예정일 YYYY-MM-DD. 목록의 날짜 구분 기준입니다. */
  scheduledDate: string;
  /** 주소에서 뽑은 시도+시군구. 지역 구분과 검색에 씁니다. */
  region: string;
  /** 서울 / 수도권 / 충남 … — 필터에 쓰는 큰 권역. */
  regionGroup: string;
  /** 주소에서 뽑은 건물·아파트명. 목록에서 현장을 알아보는 데 씁니다. */
  building?: string;
  notes?: string;
  /**
   * 주문서에 있었지만 위 항목에 해당하지 않는 열.
   *
   * 버리지 않고 그대로 보관합니다. 주문서마다 붙어 오는 열이 다르고, 그중
   * 무엇이 나중에 필요해질지는 등록 시점에 알 수 없습니다.
   */
  extras: Array<{ label: string; value: string }>;
  status: WorkOrderStatus;
  /** 자료가 제출되면 그 현장 기록의 ID. */
  siteId?: string;
  submittedAt?: string;
  source: WorkOrderSource;
  /** 원본에서의 고유 식별자. 같은 값이 다시 들어오면 새로 만들지 않고 갱신합니다. */
  sourceKey: string;
  /** 사람이 화면에서 고친 항목. 시트 재동기화가 덮어쓰지 않습니다. */
  editedFields: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** 주문서를 읽어 만든, 아직 저장 전인 한 줄. */
export interface WorkOrderDraft {
  /** 화면에서 행을 구분하기 위한 임시 키. 저장되지 않습니다. */
  rowKey: string;
  constructionType: string;
  siteType: string;
  technicianName: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  scheduledDate: string;
  notes: string;
  extras: Array<{ label: string; value: string }>;
  /** 이 줄에서 사람이 확인해야 하는 문제. 비어 있으면 그대로 등록해도 됩니다. */
  problems: string[];
  /** 주문상태가 취소여서 등록에서 빠지는 줄. 화면에는 흐리게 보입니다. */
  cancelled?: boolean;
  /** 취소로 판단한 근거가 된 원문. 사람이 오판을 알아볼 수 있게 남깁니다. */
  statusText?: string;
  /** 시트에서의 줄 번호(머리글 다음이 2). 목록 기본 정렬에 씁니다. */
  rowIndex?: number;
  /**
   * 값이 덜 채워진 채로 등록되는 줄. 무엇이 비었는지 적습니다.
   *
   * 빼지 않고 등록하는 이유: 값이 덜 찼을 뿐 실재하는 주문이고, 목록에 없으면
   * 기사가 현장에 가서도 찾지 못합니다. 대신 화면에서 눈에 띄어야 합니다.
   */
  incomplete?: string;
  /** 이미 같은 건이 등록되어 있을 때 그 ID. */
  duplicateOf?: string;
}

/** 주문서의 열을 시스템 항목에 연결한 것. */
export interface WorkOrderColumnMap {
  constructionType: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  address: string;
  scheduledDate: string;
  notes: string;
  /**
   * 주문상태가 적힌 열. 여기에 "취소"가 들어 있으면 등록하지 않습니다.
   *
   * 어느 열인지 화면에서 고를 수 있게 한 이유: 실제 주문서는 상태를 전용 열이
   * 아니라 비고 문장 안에 적습니다("가로 사이즈 불가로 취소 처리"). 자동으로
   * 정하면 "취소 요청 있었으나 진행" 같은 줄까지 빠지므로, 몇 줄이 빠지는지
   * 보여 주고 사람이 확인하게 합니다.
   */
  status: string;
}

/** 주문서의 시트 하나를 읽은 결과. */
export interface WorkOrderSheetPreview {
  /** 시트 이름 = 현장종류. */
  siteType: string;
  /** 원본의 열 이름. 매핑 드롭다운의 선택지가 됩니다. */
  headers: string[];
  /** 자동으로 알아낸 열 연결. 화면에서 바꿀 수 있습니다. */
  mapping: WorkOrderColumnMap;
  rows: WorkOrderDraft[];
  warnings: string[];
}

/** 주문서 파일을 읽은 결과. 등록 전에 화면에서 확인·수정합니다. */
export interface WorkOrderImportPreview {
  source: WorkOrderSource;
  /** 시트별로 나뉩니다. 주문서는 거래처별로 시트를 나눠 쓰기 때문입니다. */
  sheets: WorkOrderSheetPreview[];
  /** 이미지에서 읽은 경우의 원문. 사람이 대조할 수 있게 남깁니다. */
  extractedText?: string;
}

export interface WorkOrderImportResult {
  created: number;
  updated: number;
  /** 이미 있고 내용도 같아 아무것도 하지 않은 줄. */
  unchanged: number;
  skipped: number;
  failed: Array<{ rowKey: string; message: string }>;
  /**
   * 이번에 시트에서 확인한 건들의 식별키.
   *
   * 시트에 없어진 건을 지울 때 "남길 것"의 목록으로 씁니다.
   */
  keys?: string[];
}

/** 기사 화면에서 현장을 고를 때 쓰는, 날짜 → 지역으로 묶인 목록. */
export interface WorkOrderGroup {
  scheduledDate: string;
  regions: Array<{ region: string; orders: WorkOrder[] }>;
}

/** 연결된 구글 계정. 비공개 시트를 공유 설정 없이 읽기 위해 씁니다. */
export interface GoogleAccountView {
  /** OAuth 로그인을 쓸 수 있는지 (GOOGLE_CLIENT_ID/SECRET 설정 여부). */
  configured: boolean;
  redirectUri: string;
  account: { email: string; connectedAt: string } | null;
  /**
   * 서비스 계정 주소. 값이 있으면 이미 인증이 끝난 상태이고, 남은 일은
   * 시트를 이 주소로 공유하는 것뿐입니다.
   */
  serviceAccountEmail: string;
}

/** 시트 동기화 한 번의 결과. 무엇을 받아왔고 무엇을 뺐는지 남깁니다. */
export interface SheetSyncReport {
  id: string;
  at: string;
  linkId: string;
  label: string;
  constructionType: string;
  created: number;
  updated: number;
  /** 이미 있고 내용도 같아 아무것도 하지 않은 줄. */
  unchanged: number;
  /** 상태가 취소·시공완료·시공x 라서 받아오지 않은 줄. */
  excluded: number;
  /** 아직 채우다 만 줄 (시공종류나 날짜가 비어 있음). */
  pending: number;
  failed: number;
  /**
   * 시트에서 사라져 이번에 지운 건.
   *
   * 제출이 끝난 건은 지우지 않으므로 여기 세어지지 않습니다.
   */
  removed?: number;
  /**
   * 탭(시트)별 내역. 한 연동에 탭이 여러 개일 수 있습니다.
   *
   * total 을 함께 담는 이유: 숫자가 맞는지 사람이 직접 더해 볼 수 있어야
   * 합니다. total = 등록 + 제외 + 미완성 + 변동없음 이 아니면 어딘가 규칙이
   * 잘못 걸린 것이고, 그 사실이 화면에서 바로 보여야 합니다.
   */
  tabs: Array<{
    name: string;
    /** 머리글을 뺀 그 탭의 전체 줄 수. */
    total: number;
    created: number;
    updated: number;
    unchanged: number;
    excluded: number;
    pending: number;
    /** 같은 건이 두 줄이거나 이미 제출이 끝나 건너뛴 줄. */
    skipped: number;
    failed: number;
    /** 제외 사유별 건수 — "시공완료 120 · 취소 31". */
    reasons: Array<{ reason: string; count: number }>;
    /** 미완성 사유별 건수 — 무엇이 비어 있어 대기 중인지. */
    pendingReasons: Array<{ reason: string; count: number }>;
  }>;
  /**
   * 뺀 줄의 근거. 전부 담지 않고 앞부분만 남깁니다 — 목적은 감사이지
   * 원본 시트의 사본을 만드는 것이 아닙니다.
   */
  samples: Array<{ reason: string; siteType: string; address: string; customerName: string; statusText: string }>;
  error?: string;
}

/** 구글시트 실시간 연동 설정. */
export interface GoogleSheetLink {
  id: string;
  label: string;
  /** 시트 주소. 공유 링크를 그대로 붙여넣으면 됩니다. */
  url: string;
  /** 이 시트의 모든 행에 적용할 시공종류. 시트에 열이 있으면 그쪽이 우선합니다. */
  constructionType: string;
  mapping: WorkOrderColumnMap;
  /** 자동 동기화 주기(분). 0이면 수동으로만 동기화합니다. */
  intervalMinutes: number;
  enabled: boolean;
  lastSyncedAt?: string;
  lastResult?: string;
}

export interface Paged<T> {
  items: T[];
  /** Opaque cursor for the next page; absent when the list is exhausted. */
  nextCursor?: string;
}
