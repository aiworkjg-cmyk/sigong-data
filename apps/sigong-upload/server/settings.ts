import crypto from 'crypto';
import { DEFAULT_RULE, loadFolderRuleFromEnv, sanitizeSegment } from '@jg/sharepoint-core';
import type { FolderRule } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import { TECHNICIAN_TITLES } from '../src/types';
import type { Technician, TechnicianTitle } from '../src/types';

const CONSTRUCTION_TYPES_KEY = 'constructionTypes';
const TECHNICIANS_KEY = 'technicians';
const DELETE_REQUEST_EMAILS_KEY = 'deleteRequestEmails';
/** Written by an earlier version that held a single address. */
const LEGACY_DELETE_EMAIL_KEY = 'deleteRequestEmail';
const FOLDER_RULE_KEY = 'folderRule';
const MAX_DELETE_EMAILS = 20;
const MAX_SEGMENTS = 8;

/** Roster names are shown on a phone, so keep them short. */
const MAX_TECHNICIAN_NAME = 20;
const MAX_TECHNICIANS = 500;
const MAX_PHONE = 20;
const MAX_REGION = 40;

/** A 시공종류 becomes a folder name, so it lives under SharePoint's name rules. */
const MAX_TYPE_LENGTH = 30;
const MAX_TYPES = 40;

export class SettingsError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/**
 * Settings an admin can change from the 설정 screen without a redeploy.
 *
 * The list is held in memory and only re-read when it changes, because the
 * submission endpoint validates every upload against it — that path must not
 * wait on a storage round trip.
 *
 * CONSTRUCTION_TYPES in the environment is the *seed* used the first time the
 * app runs against an empty store. Once a list exists in the store, that stored
 * list wins, so an edit made in the browser is not undone by the next restart.
 */
export class SettingsService {
  private constructionTypeList: string[] = [];
  private technicianList: Technician[] = [];
  private deleteRequestEmailList: string[] = [];
  private folderRuleValue: FolderRule = DEFAULT_RULE;

  constructor(private readonly repo: SettingsRepository) {}

  async load(): Promise<void> {
    const stored = parseList(await this.repo.get(CONSTRUCTION_TYPES_KEY));
    if (stored.length > 0) {
      this.constructionTypeList = stored;
    } else {
      // First run (or a store that was wiped): seed from configuration.
      this.constructionTypeList = config.initialConstructionTypes;
      await this.persistConstructionTypes();
    }

    this.technicianList = parseTechnicians(await this.repo.get(TECHNICIANS_KEY));

    const storedEmails = parseStringList(await this.repo.get(DELETE_REQUEST_EMAILS_KEY));
    if (storedEmails.length > 0) {
      this.deleteRequestEmailList = storedEmails;
    } else {
      // Carry the single address the previous version stored, so the setting
      // does not silently empty itself on upgrade.
      const legacy = (await this.repo.get(LEGACY_DELETE_EMAIL_KEY))?.trim();
      this.deleteRequestEmailList = legacy ? [legacy] : [];
      if (legacy) await this.persistDeleteEmails();
    }

    // The environment supplies the starting rule; once edited on screen, the
    // stored rule wins so a redeploy cannot revert a deliberate change.
    this.folderRuleValue = parseFolderRule(await this.repo.get(FOLDER_RULE_KEY))
      ?? loadFolderRuleFromEnv();
  }

  constructionTypes(): string[] {
    return [...this.constructionTypeList];
  }

  async addConstructionType(rawName: string): Promise<string[]> {
    const name = normalizeTypeName(rawName);

    if (!name) {
      throw new SettingsError('시공종류 이름을 입력해 주세요.');
    }
    if (name.length > MAX_TYPE_LENGTH) {
      throw new SettingsError(`시공종류는 ${MAX_TYPE_LENGTH}자 이내로 입력해 주세요.`);
    }
    // The name is used verbatim as a folder name, so reject anything SharePoint
    // would refuse rather than silently filing uploads under a rewritten name.
    if (sanitizeSegment(name, MAX_TYPE_LENGTH) !== name) {
      throw new SettingsError('시공종류에는 \\ / : * ? " < > | 문자를 사용할 수 없습니다.');
    }
    if (this.constructionTypeList.some((type) => type.toLowerCase() === name.toLowerCase())) {
      throw new SettingsError('이미 등록된 시공종류입니다.', 409);
    }
    if (this.constructionTypeList.length >= MAX_TYPES) {
      throw new SettingsError(`시공종류는 최대 ${MAX_TYPES}개까지 등록할 수 있습니다.`);
    }

    this.constructionTypeList = [...this.constructionTypeList, name];
    await this.persistConstructionTypes();
    return this.constructionTypes();
  }

  async removeConstructionType(rawName: string): Promise<string[]> {
    const name = normalizeTypeName(rawName);
    const remaining = this.constructionTypeList.filter((type) => type !== name);

    if (remaining.length === this.constructionTypeList.length) {
      throw new SettingsError('등록되지 않은 시공종류입니다.', 404);
    }
    // The submission form has no other way to pick a value, so an empty list
    // would make the whole upload page unusable.
    if (remaining.length === 0) {
      throw new SettingsError('시공종류는 최소 1개 이상 남아 있어야 합니다.');
    }

    this.constructionTypeList = remaining;
    await this.persistConstructionTypes();
    return this.constructionTypes();
  }

  /* ---------------------------------------------------------------- */
  /* 시공기사 명부                                                      */
  /* ---------------------------------------------------------------- */

  technicians(): Technician[] {
    return this.technicianList.map((tech) => ({ ...tech }));
  }

  findTechnician(id: string): Technician | null {
    return this.technicianList.find((tech) => tech.id === id) ?? null;
  }

  /** Resolves posted ids to roster entries, dropping anything unknown. */
  resolveTechnicians(ids: string[]): Technician[] {
    const seen = new Set<string>();
    const resolved: Technician[] = [];

    for (const id of ids) {
      if (seen.has(id)) continue;
      const tech = this.findTechnician(id);
      if (tech) {
        seen.add(id);
        resolved.push(tech);
      }
    }
    return resolved;
  }

  async addTechnician(input: {
    name: string;
    title: string;
    constructionTypes?: string[];
    phone?: string;
    region?: string;
    createdBy: string;
  }): Promise<Technician> {
    const name = normalizeName(input.name);
    const title = readTitle(input.title);

    if (!name) throw new SettingsError('시공기사 이름을 입력해 주세요.');
    if (name.length > MAX_TECHNICIAN_NAME) {
      throw new SettingsError(`이름은 ${MAX_TECHNICIAN_NAME}자 이내로 입력해 주세요.`);
    }
    if (!title) throw new SettingsError('직함은 팀장 / 사수 / 부사수 중에서 선택해 주세요.');
    // Same name at the same rank is nearly always a double-submit, not twins.
    if (this.technicianList.some((tech) => tech.name === name && tech.title === title)) {
      throw new SettingsError(`이미 등록된 기사입니다. (${name} ${title})`, 409);
    }
    if (this.technicianList.length >= MAX_TECHNICIANS) {
      throw new SettingsError(`시공기사는 최대 ${MAX_TECHNICIANS}명까지 등록할 수 있습니다.`);
    }

    const technician: Technician = {
      id: `tech-${crypto.randomBytes(6).toString('hex')}`,
      name,
      title,
      // Only 시공종류 that actually exist; a stale tag would hide the person
      // from everyone without any visible reason.
      constructionTypes: this.filterKnownTypes(input.constructionTypes),
      phone: normalizeContact(input.phone, MAX_PHONE),
      region: normalizeContact(input.region, MAX_REGION),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };

    this.technicianList = [...this.technicianList, technician];
    await this.persistTechnicians();
    return technician;
  }

  /** Edits a roster entry. Past submissions keep their own name/title snapshot. */
  async updateTechnician(
    id: string,
    patch: {
      name?: string;
      title?: string;
      constructionTypes?: string[];
      phone?: string;
      region?: string;
    }
  ): Promise<Technician> {
    const existing = this.findTechnician(id);
    if (!existing) throw new SettingsError('등록되지 않은 시공기사입니다.', 404);

    const name = patch.name === undefined ? existing.name : normalizeName(patch.name);
    const title = patch.title === undefined ? existing.title : readTitle(patch.title);

    if (!name) throw new SettingsError('시공기사 이름을 입력해 주세요.');
    if (name.length > MAX_TECHNICIAN_NAME) {
      throw new SettingsError(`이름은 ${MAX_TECHNICIAN_NAME}자 이내로 입력해 주세요.`);
    }
    if (!title) throw new SettingsError('직함은 팀장 / 사수 / 부사수 중에서 선택해 주세요.');
    if (
      this.technicianList.some(
        (tech) => tech.id !== id && tech.name === name && tech.title === title
      )
    ) {
      throw new SettingsError(`이미 등록된 기사입니다. (${name} ${title})`, 409);
    }

    const updated: Technician = {
      ...existing,
      name,
      title,
      constructionTypes:
        patch.constructionTypes === undefined
          ? existing.constructionTypes
          : this.filterKnownTypes(patch.constructionTypes),
      phone: patch.phone === undefined ? existing.phone : normalizeContact(patch.phone, MAX_PHONE),
      region:
        patch.region === undefined ? existing.region : normalizeContact(patch.region, MAX_REGION),
    };
    this.technicianList = this.technicianList.map((tech) => (tech.id === id ? updated : tech));
    await this.persistTechnicians();
    return updated;
  }

  /**
   * The roster as one account may see it.
   *
   * A 업체 관리자 sees only the people carrying their own 업체 — including an
   * entry tagged with several, of which one is theirs. Untagged entries are
   * master-only on purpose: leaving 업체 blank means "not this company's".
   */
  visibleTechnicians(scope: { all: boolean; constructionTypes: string[] }): Technician[] {
    if (scope.all) return this.technicians();

    return this.technicians().filter((tech) =>
      tech.constructionTypes.some((type) => scope.constructionTypes.includes(type))
    );
  }

  /** Drops 시공종류 that are not (or no longer) configured. */
  private filterKnownTypes(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    const known = new Set(this.constructionTypeList);
    const seen = new Set<string>();

    for (const value of values) {
      if (typeof value === 'string' && known.has(value.trim())) seen.add(value.trim());
    }
    return [...seen];
  }

  async removeTechnician(id: string): Promise<void> {
    const remaining = this.technicianList.filter((tech) => tech.id !== id);
    if (remaining.length === this.technicianList.length) {
      throw new SettingsError('등록되지 않은 시공기사입니다.', 404);
    }

    this.technicianList = remaining;
    await this.persistTechnicians();
  }

  /* ---------------------------------------------------------------- */
  /* 삭제 요청 수신 메일                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Everyone who should receive a roster-deletion request.
   *
   * A list rather than one address: the person who can act on a request is not
   * always the person who configured the app, and a single address turns into a
   * silent dead end the moment that one mailbox stops being read.
   */
  deleteRequestEmails(): string[] {
    return [...this.deleteRequestEmailList];
  }

  async addDeleteRequestEmail(value: string): Promise<string[]> {
    const email = normalizeEmail(value);
    if (!email) throw new SettingsError('이메일 주소를 입력해 주세요.');
    if (!EMAIL_PATTERN.test(email)) {
      throw new SettingsError('올바른 이메일 주소를 입력해 주세요.');
    }
    if (this.deleteRequestEmailList.some((entry) => entry.toLowerCase() === email.toLowerCase())) {
      throw new SettingsError('이미 등록된 주소입니다.', 409);
    }
    if (this.deleteRequestEmailList.length >= MAX_DELETE_EMAILS) {
      throw new SettingsError(`수신 주소는 최대 ${MAX_DELETE_EMAILS}개까지 등록할 수 있습니다.`);
    }

    this.deleteRequestEmailList = [...this.deleteRequestEmailList, email];
    await this.persistDeleteEmails();
    return this.deleteRequestEmails();
  }

  async updateDeleteRequestEmail(current: string, next: string): Promise<string[]> {
    const from = normalizeEmail(current);
    const to = normalizeEmail(next);

    if (!EMAIL_PATTERN.test(to)) {
      throw new SettingsError('올바른 이메일 주소를 입력해 주세요.');
    }
    const index = this.deleteRequestEmailList.findIndex(
      (entry) => entry.toLowerCase() === from.toLowerCase()
    );
    if (index < 0) throw new SettingsError('등록되지 않은 주소입니다.', 404);

    if (
      this.deleteRequestEmailList.some(
        (entry, position) => position !== index && entry.toLowerCase() === to.toLowerCase()
      )
    ) {
      throw new SettingsError('이미 등록된 주소입니다.', 409);
    }

    this.deleteRequestEmailList = this.deleteRequestEmailList.map((entry, position) =>
      position === index ? to : entry
    );
    await this.persistDeleteEmails();
    return this.deleteRequestEmails();
  }

  async removeDeleteRequestEmail(value: string): Promise<string[]> {
    const email = normalizeEmail(value);
    const remaining = this.deleteRequestEmailList.filter(
      (entry) => entry.toLowerCase() !== email.toLowerCase()
    );
    if (remaining.length === this.deleteRequestEmailList.length) {
      throw new SettingsError('등록되지 않은 주소입니다.', 404);
    }

    this.deleteRequestEmailList = remaining;
    await this.persistDeleteEmails();
    return this.deleteRequestEmails();
  }

  /* ---------------------------------------------------------------- */
  /* 폴더 생성 규칙                                                     */
  /* ---------------------------------------------------------------- */

  folderRule(): FolderRule {
    return { ...this.folderRuleValue, segments: [...this.folderRuleValue.segments] };
  }

  async setFolderRule(input: { root: string; segments: string[] }): Promise<FolderRule> {
    // The root is a path, not one name: targeting a Teams channel means
    // "채널이름/시공현장자료". Each level is tidied separately so the slashes
    // survive while the names themselves stay clean.
    const root = (typeof input.root === 'string' ? input.root : '')
      .split('/')
      .map(normalizeSegment)
      .filter(Boolean)
      .join('/');
    if (!root) throw new SettingsError('최상위 폴더 이름을 입력해 주세요.');

    const segments = (Array.isArray(input.segments) ? input.segments : [])
      .map(normalizeSegment)
      .filter(Boolean);

    if (segments.length === 0) {
      throw new SettingsError('폴더 단계를 1개 이상 지정해 주세요.');
    }
    if (segments.length > MAX_SEGMENTS) {
      throw new SettingsError(`폴더 단계는 최대 ${MAX_SEGMENTS}단계까지 지정할 수 있습니다.`);
    }

    // The root may span levels (see above), so a slash is allowed there and
    // creates the folders in turn. A slash inside a *segment* would silently
    // add a level the admin did not intend, so the depth below the root stays
    // exactly what the list says.
    if (/[\\:*?"<>|]/.test(root)) {
      throw new SettingsError('최상위 폴더에는 \\ : * ? " < > | 문자를 사용할 수 없습니다.');
    }
    for (const segment of segments) {
      if (/[\\/:*?"<>|]/.test(segment)) {
        throw new SettingsError('폴더 단계에는 \\ / : * ? " < > | 문자를 사용할 수 없습니다.');
      }
    }

    this.folderRuleValue = { ...this.folderRuleValue, root, segments };
    await this.repo.set(FOLDER_RULE_KEY, JSON.stringify({ root, segments }));
    return this.folderRule();
  }

  /* ---------------------------------------------------------------- */

  private async persistConstructionTypes(): Promise<void> {
    await this.repo.set(CONSTRUCTION_TYPES_KEY, JSON.stringify(this.constructionTypeList));
  }

  private async persistTechnicians(): Promise<void> {
    await this.repo.set(TECHNICIANS_KEY, JSON.stringify(this.technicianList));
  }

  private async persistDeleteEmails(): Promise<void> {
    await this.repo.set(DELETE_REQUEST_EMAILS_KEY, JSON.stringify(this.deleteRequestEmailList));
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Optional free text — blank collapses to undefined rather than "". */
function normalizeContact(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return cleaned || undefined;
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSegment(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

function parseStringList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  } catch {
    return [];
  }
}

/** Returns null when nothing usable is stored, so the caller can fall back. */
function parseFolderRule(raw: string | null): FolderRule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const segments = Array.isArray(parsed?.segments)
      ? parsed.segments.filter((entry: unknown): entry is string => typeof entry === 'string')
      : [];
    if (typeof parsed?.root !== 'string' || !parsed.root || segments.length === 0) return null;

    // Only the two editable fields are stored; the rest stay as configured.
    return { ...loadFolderRuleFromEnv(), root: parsed.root, segments };
  } catch {
    return null;
  }
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function readTitle(value: unknown): TechnicianTitle | '' {
  return TECHNICIAN_TITLES.includes(value as TechnicianTitle) ? (value as TechnicianTitle) : '';
}

/** Tolerates a hand-edited or partly corrupted roster rather than failing to boot. */
function parseTechnicians(raw: string | null): Technician[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
      .map<Technician>((entry) => ({
        id: entry.id,
        name: entry.name,
        title: readTitle(entry.title) || '부사수',
        // Entries written before 업체 tagging existed carry none, which means
        // master-only until somebody assigns them.
        constructionTypes: Array.isArray(entry.constructionTypes)
          ? entry.constructionTypes.filter((value: unknown) => typeof value === 'string')
          : [],
        phone: entry.phone || undefined,
        region: entry.region || undefined,
        createdAt: entry.createdAt || '',
        createdBy: entry.createdBy || '',
      }));
  } catch {
    return [];
  }
}

function normalizeTypeName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Tolerates a corrupted or hand-edited value rather than failing to boot. */
function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeTypeName).filter(Boolean);
  } catch {
    return [];
  }
}
