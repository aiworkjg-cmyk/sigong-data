/**
 * Pluggable folder-classification rules.
 *
 * The final SharePoint layout is not settled yet, so the path is described as
 * data (a root plus a list of template segments) rather than hard-coded string
 * concatenation. Changing how uploads are filed means editing DEFAULT_RULE or
 * setting the SHAREPOINT_FOLDER_* env vars — no upload code changes.
 */

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

export const DEFAULT_RULE: FolderRule = {
  root: '시공현장자료',
  segments: ['{yyyy}-{MM}', '{date}_{address}_{manager}'],
  attachmentsFolder: '첨부파일',
  metadataFileName: '현장정보.json',
  maxSegmentLength: 60,
};

export interface FolderContext {
  siteId: string;
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
 * Splits a Korean address into its administrative head parts so rules can file
 * by region. "경기 광명시 하안로 60" -> sido "경기", sigungu "광명시".
 */
function splitAddress(address: string): { sido: string; sigungu: string } {
  const parts = (address || '').trim().split(/\s+/).filter(Boolean);
  return { sido: parts[0] || '미지정', sigungu: parts[1] || '미지정' };
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
  const { sido, sigungu } = splitAddress(ctx.address);
  const submitted = new Date(ctx.submittedAt || Date.now());

  const raw: Record<string, string> = {
    yyyy,
    MM,
    dd,
    date,
    'yyyy-MM': `${yyyy}-${MM}`,
    quarter: `Q${Math.floor((Number(MM) - 1) / 3) + 1}`,
    address: ctx.address,
    sido,
    sigungu,
    manager: ctx.managerName,
    siteId: ctx.siteId,
    submittedDate: submitted.toISOString().slice(0, 10),
  };

  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    tokens[key] = sanitizeSegment(value, maxLength);
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
    .map((segment) => sanitizeSegment(segment, rule.maxSegmentLength))
    .filter((segment) => segment && segment !== '미지정');

  const rootFolder = sanitizeSegment(rule.root, rule.maxSegmentLength);
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
