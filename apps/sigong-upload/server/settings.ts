import { sanitizeSegment } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';

const CONSTRUCTION_TYPES_KEY = 'constructionTypes';

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

  constructor(private readonly repo: SettingsRepository) {}

  async load(): Promise<void> {
    const raw = await this.repo.get(CONSTRUCTION_TYPES_KEY);
    const stored = parseList(raw);

    if (stored.length > 0) {
      this.constructionTypeList = stored;
      return;
    }

    // First run (or a store that was wiped): seed from configuration.
    this.constructionTypeList = config.initialConstructionTypes;
    await this.persist();
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
    await this.persist();
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
    await this.persist();
    return this.constructionTypes();
  }

  private async persist(): Promise<void> {
    await this.repo.set(CONSTRUCTION_TYPES_KEY, JSON.stringify(this.constructionTypeList));
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
