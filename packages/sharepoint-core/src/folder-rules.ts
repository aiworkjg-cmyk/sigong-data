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
export const DEFAULT_RULE: FolderRule = {
  root: '시공현장자료',
  segments: ['{type}', '{yyyy}', '{MM}월', '{MMdd}_{region}_{building}'],
  attachmentsFolder: null,
  metadataFileName: '현장정보.json',
  maxSegmentLength: 60,
};

export interface FolderContext {
  siteId: string;
  /** Product line the work belongs to, e.g. 백조 / 인덕션. */
  constructionType: string;
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
  originalName: string
): string {
  const kind = fileType === 'image' ? '이미지' : fileType === 'video' ? '동영상' : '파일';
  const dot = originalName.lastIndexOf('.');
  // Only treat a short trailing group as an extension; "2026.08.26 사진" is not.
  const ext = dot > 0 && originalName.length - dot <= 12 ? originalName.slice(dot) : '';

  return sanitizeFileName(
    `${folderLeaf}_${kind}${String(sequence).padStart(3, '0')}${ext}`
  );
}

/**
 * Highest sequence already used in a folder, per kind.
 *
 * Read from the destination rather than from our own records, so a file someone
 * dropped in by hand is counted too — otherwise the next submission would
 * restart at 001 and overwrite it.
 */
export function nextSequences(existingNames: string[]): Record<string, number> {
  const highest: Record<string, number> = { 이미지: 0, 동영상: 0, 파일: 0 };

  for (const name of existingNames) {
    const match = name.match(/_(이미지|동영상|파일)(\d{1,4})(\.|$)/);
    if (!match) continue;

    const kind = match[1];
    const value = Number(match[2]);
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
    quarter: `Q${Math.floor((Number(MM) - 1) / 3) + 1}`,
    type: ctx.constructionType,
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
      template.replace(/\{(\w[\w-]*)\}/g, (_match, key: string) => tokens[key] ?? '')
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
  const fullFolderPath = [rootFolder, ...segments].join('/');
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
  };
}
