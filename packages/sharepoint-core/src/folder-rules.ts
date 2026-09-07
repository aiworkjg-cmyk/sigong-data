/**
 * Pluggable folder-classification rules.
 *
 * The final SharePoint layout is not settled yet, so the path is described as
 * data (a root plus a list of template segments) rather than hard-coded string
 * concatenation. Changing how uploads are filed means editing DEFAULT_RULE or
 * setting the SHAREPOINT_FOLDER_* env vars — no upload code changes.
 */

import { parseAddress } from './address';

export interface FolderRule {
  /** Top-level library folder every site lands under. */
  root: string;
  /** Nested folder templates, outermost first. Empty results are dropped. */
  segments: string[];
  /** Subfolder that receives the attachments; null files them beside metadata. */
  attachmentsFolder: string | null;
  /** Metadata sidecar written into the site folder; null skips it. */
  metadataFileName: string | null;
  /** Per-segment character cap. SharePoint rejects very long path components. */
  maxSegmentLength: number;
  /**
   * 저장되는 파일 이름의 형태. 쓸 수 있는 토큰은 {폴더명} {종류} {번호} {원본파일명}.
   *
   * 폴더 규칙과 달리 공통 하나만 둡니다 — 파일 이름까지 업체별로 갈라 두면
   * 나중에 자료를 한데 모았을 때 규칙이 섞여 정렬조차 되지 않습니다.
   */
  fileNameTemplate?: string;
}

/**
 * 시공현장자료 / 백조 / 2026 / 08월 / 0824_경기도광명시_이편한세상
 *
 * The site folder is 날짜_지역_건물, not the raw address: the unit number is
 * dropped so every household in one building shares a folder, and the region
 * stops at 시군구 so folders stay readable at a glance.
 *
 * Attachments land directly in the dated site folder; there is no extra
 * subfolder level below it.
 */
/**
 * 저장되는 파일 이름의 기본 형태.
 *
 * 폴더 이름을 앞에 두는 이유: SharePoint 에서 파일을 내려받아 다른 곳에 옮겨
 * 놓아도 어느 현장의 자료인지 이름만으로 알 수 있어야 합니다. 원본 파일명
 * ("KakaoTalk_20260803_171545806.jpg")은 그 일을 전혀 하지 못합니다.
 */
export const DEFAULT_FILE_NAME_TEMPLATE = '{폴더명}_{종류}{번호}';

export const DEFAULT_RULE: FolderRule = {
  root: '시공현장자료',
  segments: ['{시공종류}', '{연도}', '{월}월', '{월일}_{지역}_{건물명}'],
  attachmentsFolder: null,
  metadataFileName: '현장정보.json',
  maxSegmentLength: 60,
  fileNameTemplate: DEFAULT_FILE_NAME_TEMPLATE,
};

/**
 * Token names an administrator may not reuse for a 시공종류 input field.
 *
 * These are the values buildTokens() fills in from the submission itself. A
 * field allowed to take one of these names would silently shadow it — a folder
 * template reading {type} would stop meaning 시공종류 — so the collision is
 * refused at the point the field is named rather than discovered later in a
 * misfiled folder.
 */
export const RESERVED_TOKENS = [
  'yyyy', 'MM', 'dd', 'date', 'MMdd', 'yyyy-MM', 'quarter', 'type',
  'address', 'addressCompact', 'sido', 'sigungu', 'region', 'dong', 'building',
  'manager', 'siteId', 'submittedDate',
  // 같은 값의 한글 이름. 화면에서 쓰는 쪽은 이제 이쪽입니다.
  '연도', '월', '일', '시공일', '월일', '연월', '연월일', '짧은연도', '분기', '시공종류',
  '주소', '주소압축', '시도', '시군구', '지역', '읍면동', '건물명',
  '시공기사', '현장ID', '제출일',
  // 현장종류·주문자명은 여기 없습니다 — siteType·customerName 과 마찬가지로
  // 시공종류별 입력 항목이 쓰는 이름이고, 그 값이 토큰 값이 됩니다.
] as const;

/**
 * 영문 토큰 이름 → 한글 이름.
 *
 * 토큰은 폴더 규칙을 읽는 사람이 무엇이 들어갈지 알아보라고 있는 것인데,
 * 이 시스템을 쓰는 사람들은 한국어로 일합니다. {building} 보다 {건물명} 이
 * 그 목적에 맞습니다. 영문 이름도 계속 동작하게 두는 이유는 이미 저장된
 * 규칙들 때문입니다 — 이름을 갈아 끼우는 순간 그 규칙들이 빈 폴더를
 * 만들어 버립니다.
 */
export const TOKEN_ALIASES: Record<string, string> = {
  yyyy: '연도',
  MM: '월',
  dd: '일',
  date: '시공일',
  MMdd: '월일',
  'yyyy-MM': '연월',
  yyMMdd: '연월일',
  yy: '짧은연도',
  quarter: '분기',
  type: '시공종류',
  siteType: '현장종류',
  customerName: '주문자명',
  address: '주소',
  addressCompact: '주소압축',
  sido: '시도',
  sigungu: '시군구',
  region: '지역',
  dong: '읍면동',
  building: '건물명',
  manager: '시공기사',
  siteId: '현장ID',
  submittedDate: '제출일',
};

/**
 * 규칙에 남아 있는 영문 토큰을 한글 이름으로 바꿔 씁니다.
 *
 * 저장할 때 한 번 돌려서 화면에 보이는 규칙과 실제로 적용되는 규칙이
 * 같아지게 합니다. 해석은 두 이름 모두 받으므로, 바꾸지 않은 규칙도
 * 그대로 동작합니다.
 */
export function toKoreanTokens(template: string): string {
  return template.replace(TOKEN_REFERENCE, (match, key: string) =>
    TOKEN_ALIASES[key] ? `{${TOKEN_ALIASES[key]}}` : match
  );
}

/**
 * A token name may be written in the administrator's own language.
 *
 * The point of a token is that somebody reading the folder template can tell
 * what will be substituted in, and "field_a1b2c3" tells them nothing. Korean
 * letters are therefore first-class here, which is why the pattern is built
 * from Unicode classes rather than \w — \w is ASCII-only in JavaScript and
 * would have rejected every name a Korean-speaking admin would naturally pick.
 */
export const FIELD_TOKEN_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,29}$/u;

/** Template placeholder syntax — must accept exactly what the pattern allows. */
const TOKEN_REFERENCE = /\{([\p{L}\p{N}_][\p{L}\p{N}_-]*)\}/gu;

/**
 * Whether a name may be used as a custom field's folder token.
 * `siteType` and `customerName` are grandfathered: they were the two built-in
 * optional fields before fields became administrator-defined, and existing
 * configurations still carry them.
 */
export function isValidFieldToken(name: string): boolean {
  if (!FIELD_TOKEN_PATTERN.test(name)) return false;
  return !(RESERVED_TOKENS as readonly string[]).includes(name);
}

export interface FolderContext {
  siteId: string;
  /** Product line the work belongs to, e.g. 백조 / 인덕션. */
  constructionType: string;
  siteType?: string;
  customerName?: string;
  customFields?: Array<{ token: string; value: string }>;
  constructionDate: string;
  address: string;
  managerName: string;
  submittedAt: string;
}

export interface ResolvedFolder {
  rootFolder: string;
  /** Resolved segments below the root, outermost first. */
  segments: string[];
  /** root + segments, e.g. "시공현장자료/2026-08/2026-08-14_주소_홍길동". */
  fullFolderPath: string;
  /** Where attachments go — equals fullFolderPath when attachmentsFolder is null. */
  attachmentsFolderPath: string;
  /** Full path of the metadata sidecar, or null when disabled. */
  metadataFilePath: string | null;
  /** 이 제출에 대해 계산된 토큰 값. 파일 이름 규칙이 같은 값을 씁니다. */
  tokens: Record<string, string>;
}

/** Characters SharePoint / OneDrive reject in an item name: " * : < > ? / \ | */
const FORBIDDEN_CHARS = /[\/:*?"<>|\r\n\t]/g;

/**
 * Makes an arbitrary string safe to use as one path component. SharePoint also
 * rejects names that are empty, start/end with a space, or end with a period.
 */
export function sanitizeSegment(name: string, maxLength = 60): string {
  const cleaned = (name || '')
    .replace(FORBIDDEN_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/[.\s]+$/, '')
    .trim();
  return cleaned || '미지정';
}

/**
 * The stored name for one attachment: 0826_경기도광명시_이편한세상_이미지001.jpg
 *
 * Images and videos are counted separately so a folder listing reads as
 * "photos 1..10, videos 1..2" rather than one interleaved run — that is how
 * people actually look for a picture. The folder's own name is repeated in the
 * file name because files get copied, mailed and dragged out of the folder, and
 * a bare "이미지001.jpg" tells the person holding it nothing.
 */
export function buildStoredName(
  folderLeaf: string,
  fileType: 'image' | 'video' | 'other',
  sequence: number,
  originalName: string,
  template: string = DEFAULT_FILE_NAME_TEMPLATE,
  /**
   * 폴더 규칙이 쓰는 토큰들. 파일 이름에도 그대로 쓸 수 있게 넘겨받습니다.
   *
   * {폴더명} 만으로는 부족합니다 — 폴더 이름이 "시공완료사진" 처럼 업체마다
   * 겹칠 수 있는 말이면, 파일만 따로 내려받아 모았을 때 어느 업체의 어느
   * 현장인지 알 수 없게 됩니다. 날짜·지역·건물명을 파일 이름에 직접 넣을 수
   * 있어야 그 문제가 없습니다.
   */
  folderTokens: Record<string, string> = {}
): string {
  const kind = fileType === 'image' ? '이미지' : fileType === 'video' ? '동영상' : '파일';
  const dot = originalName.lastIndexOf('.');
  // Only treat a short trailing group as an extension; "2026.08.26 사진" is not.
  const ext = dot > 0 && originalName.length - dot <= 12 ? originalName.slice(dot) : '';
  const base = dot > 0 && ext ? originalName.slice(0, dot) : originalName;

  const values: Record<string, string> = {
    ...folderTokens,
    폴더명: folderLeaf,
    종류: kind,
    // 세 자리는 폴더 하나에 999장까지를 가정한 것입니다. 넘으면 자릿수가
    // 늘어나되 순서는 유지됩니다.
    번호: String(sequence).padStart(3, '0'),
    원본파일명: base,
  };

  const rendered = (template || DEFAULT_FILE_NAME_TEMPLATE)
    // 모르는 토큰과 빈 값은 사라집니다. `{foo}` 를 이름에 그대로 남기면
    // 사람이 보기에 고장 난 파일이 되고, 값이 비어 구분자만 남는 것도
    // ("0809__이미지001") 마찬가지입니다.
    .replace(TOKEN_REFERENCE, (_match, key: string) => values[key] ?? '')
    .replace(/[_-]{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  /*
   * 번호는 반드시 들어갑니다.
   *
   * 관리자가 템플릿에서 {번호} 를 빼면 한 폴더의 모든 파일이 같은 이름이
   * 되고, SharePoint 는 같은 이름을 덮어씁니다 — 11장을 올렸는데 1장만
   * 남습니다. 설정 한 줄이 자료를 지우게 둘 수는 없으므로, 빠져 있으면
   * 뒤에 붙입니다.
   */
  const numbered = (template || DEFAULT_FILE_NAME_TEMPLATE).includes('{번호}')
    ? rendered
    : `${rendered}_${values.번호}`;

  return sanitizeFileName(`${numbered || folderLeaf}${ext}`);
}

/**
 * Highest sequence already used in a folder, per kind.
 *
 * Read from the destination rather than from our own records, so a file someone
 * dropped in by hand is counted too — otherwise the next submission would
 * restart at 001 and overwrite it.
 */
/** 파일 이름 규칙이 제 힘으로 채울 수 있는 토큰. 나머지는 제출 정보에서 옵니다. */
const SELF_CONTAINED_TOKENS = ['폴더명', '종류', '번호', '원본파일명'];

/** 규칙이 제출 정보(날짜·지역·건물명 등)를 필요로 하는지. */
export function needsSubmissionTokens(template: string): boolean {
  const names = [...(template || '').matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  return names.some((name) => !SELF_CONTAINED_TOKENS.includes(name));
}

/**
 * 이미 이 규칙대로 지어진 이름인지.
 *
 * 수동 업로드 정리가 자기가 방금 지은 이름을 다시 바꾸지 않도록 하는 데
 * 씁니다. 규칙을 정규식으로 바꿔서 비교하는 이유는, 관리자가 규칙을 고치면
 * "관리되는 이름"의 모양도 함께 달라지기 때문입니다 — 기본 모양만 알고
 * 있으면 규칙을 바꾼 순간 앱이 올린 파일을 매분 다시 이름 바꾸게 됩니다.
 */
export function followsFileNameRule(
  folderLeaf: string,
  name: string,
  template: string = DEFAULT_FILE_NAME_TEMPLATE
): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = (template || DEFAULT_FILE_NAME_TEMPLATE)
    .split(/(\{[^}]+\})/)
    .map((part) => {
      if (!/^\{[^}]+\}$/.test(part)) return escape(part);
      const token = part.slice(1, -1);
      if (token === '번호') return '\\d{3,}';
      if (token === '종류') return '(?:이미지|동영상|파일)';
      if (token === '폴더명') return escape(folderLeaf);
      // 날짜·주소·원본파일명에는 밑줄이 들어갈 수 있습니다. 뒤의 고정
      // 문자열이 경계를 잡도록 최소 일치로 받아야 앱이 만든 이름을 수동
      // 업로드 감시기가 다시 바꾸지 않습니다.
      return '.+?';
    })
    .join('');

  return new RegExp(`^${pattern}(?:\\.[^.]+)?$`, 'i').test(name);
}

export function nextSequences(
  existingNames: string[],
  folderLeaf = '',
  template: string = DEFAULT_FILE_NAME_TEMPLATE
): Record<string, number> {
  const highest: Record<string, number> = { 이미지: 0, 동영상: 0, 파일: 0 };

  const activeTemplate = template || DEFAULT_FILE_NAME_TEMPLATE;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasKind = activeTemplate.includes('{종류}');
  let captureCount = 0;
  let sequenceCapture = 0;
  let kindCapture = 0;
  const templatePattern = activeTemplate
    .split(/(\{[^}]+\})/)
    .map((part) => {
      if (!/^\{[^}]+\}$/.test(part)) return escape(part);
      const token = part.slice(1, -1);
      if (token === '번호') {
        if (sequenceCapture) return '\\d+';
        sequenceCapture = ++captureCount;
        return '(\\d+)';
      }
      if (token === '종류') {
        if (kindCapture) return '(?:이미지|동영상|파일)';
        kindCapture = ++captureCount;
        return '(이미지|동영상|파일)';
      }
      if (token === '폴더명' && folderLeaf) return escape(folderLeaf);
      // 날짜·주소·원본파일명 같은 값에는 밑줄도 들어갈 수 있습니다. 뒤의
      // 고정 문자열과 번호가 경계를 잡으므로 최소 일치로 받아도 안전합니다.
      return '.+?';
    })
    .join('');
  const customPattern = activeTemplate.includes('{번호}')
    ? new RegExp(`^${templatePattern}(?:\\.[^.]+)?$`, 'i')
    : null;

  for (const name of existingNames) {
    const custom = customPattern?.exec(name);
    if (custom && sequenceCapture) {
      const value = Number(custom[sequenceCapture]);
      const kind = kindCapture ? custom[kindCapture] : '';
      if (!Number.isFinite(value)) continue;
      if (hasKind && kind && kind in highest) {
        if (value > highest[kind]) highest[kind] = value;
      } else {
        // {종류}가 없는 규칙은 이미지·동영상을 같은 번호 공간에서 셉니다.
        // 유형별로 001부터 시작하면 확장자가 같은 두 파일이 충돌할 수 있습니다.
        for (const key of Object.keys(highest)) {
          if (value > highest[key]) highest[key] = value;
        }
      }
      continue;
    }

    // 이전 기본 규칙으로 저장된 파일도 계속 셉니다. 규칙을 바꾼 직후 기존
    // 번호를 잊으면 새 001이 과거 001을 덮어쓸 수 있기 때문입니다.
    const legacy = name.match(/_(이미지|동영상|파일)(\d+)(\.|$)/);
    if (!legacy) continue;

    const kind = legacy[1];
    const value = Number(legacy[2]);
    if (Number.isFinite(value) && value > highest[kind]) highest[kind] = value;
  }
  return highest;
}

/** Keeps a filename safe while preserving its extension through truncation. */
export function sanitizeFileName(name: string, maxLength = 120): string {
  const safe = (name || '').replace(FORBIDDEN_CHARS, '_').replace(/\s+/g, ' ').trim();
  if (!safe) return '파일';
  if (safe.length <= maxLength) return safe.replace(/[.\s]+$/, '') || '파일';

  const dot = safe.lastIndexOf('.');
  // Treat a trailing dot group as an extension only when it looks like one.
  if (dot > 0 && safe.length - dot <= 12) {
    const ext = safe.slice(dot);
    return safe.slice(0, maxLength - ext.length).trim() + ext;
  }
  return safe.slice(0, maxLength).trim();
}

/**
 * Builds the token table a segment template can reference. Every value is
 * sanitized here so a template may combine tokens with literal separators
 * (`_`, `-`) without a user-supplied slash escaping the intended depth.
 */
function buildTokens(ctx: FolderContext, maxLength: number): Record<string, string> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.constructionDate)
    ? ctx.constructionDate
    : new Date(ctx.submittedAt || Date.now()).toISOString().slice(0, 10);

  const [yyyy, MM, dd] = date.split('-');
  const { sido, sigungu, region, dong, building } = parseAddress(ctx.address);
  const submitted = new Date(ctx.submittedAt || Date.now());

  const raw: Record<string, string> = {
    yyyy,
    MM,
    dd,
    date,
    MMdd: `${MM}${dd}`,
    'yyyy-MM': `${yyyy}-${MM}`,
    // 260809 — 파일 이름 앞에 붙이는 짧은 날짜. 폴더가 이미 연·월로 나뉘어
    // 있어도 파일만 따로 내려받아 모으면 날짜가 필요해집니다.
    yyMMdd: `${yyyy.slice(2)}${MM}${dd}`,
    yy: yyyy.slice(2),
    quarter: `Q${Math.floor((Number(MM) - 1) / 3) + 1}`,
    type: ctx.constructionType,
    siteType: ctx.siteType || '',
    customerName: ctx.customerName || '',
    address: ctx.address,
    // Whitespace removed so a full street address stays one compact component.
    addressCompact: (ctx.address || '').replace(/\s+/g, ''),
    sido,
    sigungu,
    // 시도+시군구, e.g. 경기도광명시
    region,
    // 읍/면/동/리
    dong,
    // 아파트·건물 이름. 동호수와 상세주소는 제외되며, 건물명이 없으면 동 이름이 들어갑니다.
    building,
    manager: ctx.managerName,
    siteId: ctx.siteId,
    submittedDate: submitted.toISOString().slice(0, 10),
  };
  for (const field of ctx.customFields || []) {
    // isValidFieldToken() refuses the built-in names at the point a field is
    // saved, but a configuration written before that guard existed could still
    // carry one — so a value already filled in from the submission itself is
    // never overwritten here. siteType and customerName are the exception that
    // makes the empty-value check necessary: they are legitimate field tokens
    // that buildTokens also seeds (usually blank) from the legacy ctx fields.
    if (isValidFieldToken(field.token) && !raw[field.token]) {
      raw[field.token] = field.value;
    }
  }

  // 한글 이름을 같은 값에 연결합니다. 영문 이름은 이미 저장된 규칙 때문에
  // 남겨 둡니다 — 둘 다 같은 곳을 가리키므로 어느 쪽으로 써도 결과가 같습니다.
  for (const [english, korean] of Object.entries(TOKEN_ALIASES)) {
    if (raw[korean] === undefined && raw[english] !== undefined) raw[korean] = raw[english];
  }

  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // An absent value stays empty so the template can drop it along with its
    // separators. sanitizeSegment's "미지정" fallback is for a whole segment
    // that came out blank, not for one missing piece of it — an address with
    // no building name should yield "0824_경기도광명시", not "…_미지정".
    tokens[key] = value ? sanitizeSegment(value, maxLength) : '';
  }
  return tokens;
}

/** Applies a rule to one submission and returns every path the sync needs. */
export function resolveFolder(ctx: FolderContext, rule: FolderRule = DEFAULT_RULE): ResolvedFolder {
  const tokens = buildTokens(ctx, rule.maxSegmentLength);

  const segments = rule.segments
    .map((template) =>
      // Unknown tokens collapse to empty rather than leaking a literal "{foo}".
      template.replace(TOKEN_REFERENCE, (_match, key: string) => tokens[key] ?? '')
    )
    // An empty token would otherwise leave its separators behind
    // ("0824_경기도광명시_" when the address carries no building name).
    .map((segment) => segment.replace(/[_-]{2,}/g, '_').replace(/^[_-]+|[_-]+$/g, ''))
    .map((segment) => sanitizeSegment(segment, rule.maxSegmentLength))
    .filter((segment) => segment && segment !== '미지정');

  // The root may name several levels — "채널이름/시공현장자료" when the target is
  // a Teams channel — so each level is sanitized on its own and the separators
  // survive. Sanitizing the whole string would turn the slashes into "_" and
  // silently flatten the intended depth into one oddly named folder.
  const rootFolder = rule.root
    .split('/')
    .map((part) => sanitizeSegment(part, rule.maxSegmentLength))
    .filter(Boolean)
    .join('/');
  const fullFolderPath = [rootFolder, ...segments].filter(Boolean).join('/');
  const attachmentsFolderPath = rule.attachmentsFolder
    ? `${fullFolderPath}/${sanitizeSegment(rule.attachmentsFolder, rule.maxSegmentLength)}`
    : fullFolderPath;

  return {
    rootFolder,
    segments,
    fullFolderPath,
    attachmentsFolderPath,
    metadataFilePath: rule.metadataFileName
      ? `${fullFolderPath}/${sanitizeFileName(rule.metadataFileName)}`
      : null,
    tokens,
  };
}

/** Opt-out sentinel for the optional parts of a rule. */
const DISABLED = 'none';

/**
 * Resolves one optional rule field.
 *
 * A blank value means "use the default", not "disable" — a .env file lists
 * every key with an empty value, so treating blank as an opt-out would
 * silently switch features off just by copying .env.example. Disabling is
 * therefore explicit: set the value to "none".
 */
function optional(value: string | undefined, fallback: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.toLowerCase() === DISABLED ? null : trimmed;
}

/**
 * Reads a rule from the environment, falling back to DEFAULT_RULE per field.
 * SHAREPOINT_FOLDER_SEGMENTS is a comma-separated template list, e.g.
 * "{yyyy},{MM},{sigungu},{date}_{manager}".
 */
export function loadFolderRuleFromEnv(env: NodeJS.ProcessEnv = process.env): FolderRule {
  const segments = (env.SHAREPOINT_FOLDER_SEGMENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    root: env.SHAREPOINT_ROOT_FOLDER?.trim() || DEFAULT_RULE.root,
    segments: segments.length ? segments : DEFAULT_RULE.segments,
    attachmentsFolder: optional(
      env.SHAREPOINT_ATTACHMENTS_FOLDER,
      DEFAULT_RULE.attachmentsFolder
    ),
    metadataFileName: optional(env.SHAREPOINT_METADATA_FILENAME, DEFAULT_RULE.metadataFileName),
    maxSegmentLength: Number(env.SHAREPOINT_MAX_SEGMENT_LENGTH) || DEFAULT_RULE.maxSegmentLength,
    fileNameTemplate:
      env.SHAREPOINT_FILE_NAME_TEMPLATE?.trim() || DEFAULT_RULE.fileNameTemplate,
  };
}
