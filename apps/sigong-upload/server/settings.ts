import crypto from 'crypto';
import { sanitizeSegment } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import { TECHNICIAN_TITLES } from '../src/types';
import type { Technician, TechnicianTitle } from '../src/types';

const CONSTRUCTION_TYPES_KEY = 'constructionTypes';
const TECHNICIANS_KEY = 'technicians';
const DELETE_REQUEST_EMAIL_KEY = 'deleteRequestEmail';

/** Roster names are shown on a phone, so keep them short. */
const MAX_TECHNICIAN_NAME = 20;
const MAX_TECHNICIANS = 500;

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
  private deleteRequestEmailValue = '';

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
    this.deleteRequestEmailValue = (await this.repo.get(DELETE_REQUEST_EMAIL_KEY)) || '';
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
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };

    this.technicianList = [...this.technicianList, technician];
    await this.persistTechnicians();
    return technician;
  }

  /** Renames or re-ranks someone. Past submissions keep their own snapshot. */
  async updateTechnician(
    id: string,
    patch: { name?: string; title?: string }
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

    const updated: Technician = { ...existing, name, title };
    this.technicianList = this.technicianList.map((tech) => (tech.id === id ? updated : tech));
    await this.persistTechnicians();
    return updated;
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

  /** Where 업체 관리자 are told to write when they need a roster deletion. */
  deleteRequestEmail(): string {
    return this.deleteRequestEmailValue;
  }

  async setDeleteRequestEmail(value: string): Promise<string> {
    const email = (value || '').trim();
    // Empty is allowed: the popup then just says to contact the master.
    if (email && !EMAIL_PATTERN.test(email)) {
      throw new SettingsError('올바른 이메일 주소를 입력해 주세요.');
    }

    this.deleteRequestEmailValue = email;
    await this.repo.set(DELETE_REQUEST_EMAIL_KEY, email);
    return email;
  }

  /* ---------------------------------------------------------------- */

  private async persistConstructionTypes(): Promise<void> {
    await this.repo.set(CONSTRUCTION_TYPES_KEY, JSON.stringify(this.constructionTypeList));
  }

  private async persistTechnicians(): Promise<void> {
    await this.repo.set(TECHNICIANS_KEY, JSON.stringify(this.technicianList));
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
