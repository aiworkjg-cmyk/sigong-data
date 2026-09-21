import crypto from 'crypto';
import {
  DEFAULT_FILE_NAME_TEMPLATE,
  DEFAULT_RULE,
  RESERVED_TOKENS,
  isValidFieldToken,
  loadFolderRuleFromEnv,
  sanitizeSegment,
  toKoreanTokens,
} from '@jg/sharepoint-core';
import type { FolderRule } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import { TECHNICIAN_TITLES } from '../src/types';
import { normalizeSubmissionOrder } from '../src/submission-layout';
import { validateTechnicianImport } from './technician-import';
import type { SheetTable } from './spreadsheet';
import type { SubmissionFieldKey } from '../src/submission-layout';
import type {
  ConstructionTypeConfig,
  DynamicFieldConfig,
  SharePointStorageTarget,
  TeamsWebhookProfile,
  Technician,
  TechnicianTitle,
} from '../src/types';

const CONSTRUCTION_TYPES_KEY = 'constructionTypes';
const TECHNICIANS_KEY = 'technicians';
const DELETE_REQUEST_EMAILS_KEY = 'deleteRequestEmails';
/** Written by an earlier version that held a single address. */
const LEGACY_DELETE_EMAIL_KEY = 'deleteRequestEmail';
const FOLDER_RULE_KEY = 'folderRule';
const TEAMS_WEBHOOK_KEY = 'teamsWebhookUrl';
const CONSTRUCTION_TYPE_CONFIGS_KEY = 'constructionTypeConfigs';
const STORAGE_TARGET_KEY = 'sharePointStorageTarget';
const STORAGE_TARGETS_KEY = 'sharePointStorageTargets';
const ACTIVE_STORAGE_TARGET_KEY = 'activeSharePointStorageTargetId';
const TEAMS_WEBHOOKS_KEY = 'teamsWebhooks';
const SUBMISSION_ORDER_KEY = 'submissionFieldOrder';
const FOLDER_RULE_DEFAULT_KEY = 'folderRuleDefault';
const MAX_DELETE_EMAILS = 20;
const MAX_SEGMENTS = 8;
const MAX_TEAMS_WEBHOOKS = 20;
const MAX_STORAGE_TARGETS = 20;

/**
 * Hosts Microsoft actually issues Teams incoming-webhook addresses on.
 *
 * This list is longer than it looks like it needs to be because Microsoft has
 * moved the endpoint twice. The retired Office 365 connector lived on
 * office.com / outlook.com; the first generation of Teams **Workflows** issued
 * Logic Apps URLs on *.logic.azure.com; the current generation issues Power
 * Automate URLs on *.environment.api.powerplatform.com. A rule written for any
 * one of those rejects addresses from the others — which is exactly the failure
 * an admin sees as "테스트는 되는데 저장은 안 된다".
 */
const TEAMS_WEBHOOK_HOSTS = [
  'logic.azure.com',
  'logic.azure.us',
  'logic.azure.cn',
  'powerplatform.com',
  'powerplatform.cn',
  'powerautomate.com',
  'microsoftflow.com',
  'microsoftflow.us',
  'azure-apihub.net',
  'azure-apihub.us',
  'webhook.office.com',
  'office.com',
  'office365.us',
  'outlook.com',
  'outlook.office.com',
  'microsoft.com',
  'azure.com',
];

/**
 * Rejects an address the app should not be POSTing submission data to.
 *
 * Shared by the save path and the [테스트 카드 보내기] button on purpose: when
 * the two disagreed, a test could pass against an address that could never be
 * saved, and the admin had no way to tell which of the two was wrong.
 */
export function assertTeamsWebhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SettingsError('올바른 주소가 아닙니다. https:// 로 시작하는 전체 주소를 넣어 주세요.');
  }
  // The app posts to this address on every submission, so it must not be a
  // plain-text hop or an arbitrary host chosen by mistake.
  if (parsed.protocol !== 'https:') {
    throw new SettingsError('보안을 위해 https:// 주소만 사용할 수 있습니다.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed = TEAMS_WEBHOOK_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`)
  );
  if (!allowed) {
    // Naming the host is the whole point of this message: without it the admin
    // is told the address is wrong and given no way to find out why.
    throw new SettingsError(
      `Microsoft Teams 워크플로 주소로 볼 수 없는 서버입니다 (${hostname}). ` +
        'Teams 채널 ··· > 워크플로 > "웹후크 요청을 받으면 채널에 게시" 에서 만들어진 주소를 그대로 붙여넣어 주세요.'
    );
  }
  return parsed;
}

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
  private folderRuleDefaultValue: {
    root: string;
    segments: string[];
    fileNameTemplate?: string;
  } | null = null;
  private teamsWebhookList: TeamsWebhookProfile[] = [];
  private submissionOrderMap: Record<string, SubmissionFieldKey[]> = {};
  private constructionTypeConfigList: ConstructionTypeConfig[] = [];
  private storageTargetList: SharePointStorageTarget[] = [];
  private activeStorageTargetId = '';

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
    // 예전에 저장된 영문 토큰을 한글 이름으로 올려 둡니다. 값은 그대로이고
    // 이름만 바뀌므로 폴더 경로는 달라지지 않습니다.
    this.folderRuleValue = {
      ...this.folderRuleValue,
      segments: this.folderRuleValue.segments.map(toKoreanTokens),
    };

    const legacyWebhook = (await this.repo.get(TEAMS_WEBHOOK_KEY)) || '';
    this.teamsWebhookList = parseTeamsWebhooks(await this.repo.get(TEAMS_WEBHOOKS_KEY));
    if (this.teamsWebhookList.length === 0 && legacyWebhook) {
      this.teamsWebhookList = [{ id: makeId('hook'), teamName: '기존 Teams', channelName: '기존 채널', url: legacyWebhook }];
      await this.persistTeamsWebhooks();
    }

    this.constructionTypeConfigList = parseConstructionTypeConfigs(
      await this.repo.get(CONSTRUCTION_TYPE_CONFIGS_KEY),
      this.constructionTypeList,
      this.folderRuleValue
    ).map((entry) => ({
      ...entry,
      folderRule: { ...entry.folderRule, segments: entry.folderRule.segments.map(toKoreanTokens) },
    }));
    this.storageTargetList = parseStorageTargets(await this.repo.get(STORAGE_TARGETS_KEY));
    if (this.storageTargetList.length === 0) {
      const legacy = parseStorageTarget(await this.repo.get(STORAGE_TARGET_KEY));
      this.storageTargetList = [legacy ?? {
        id: makeId('target'), accountEmail: '', teamName: '기존 Teams', channelName: '기존 채널',
        teamId: '', channelId: '',
        siteId: config.sharePoint.siteId, driveId: config.sharePoint.driveId, channelFolder: '',
      }];
      await this.persistStorageTargets();
    }
    const storedActive = (await this.repo.get(ACTIVE_STORAGE_TARGET_KEY)) || '';
    this.activeStorageTargetId = this.storageTargetList.some((target) => target.id === storedActive)
      ? storedActive : this.storageTargetList[0].id;
    await this.repo.set(ACTIVE_STORAGE_TARGET_KEY, this.activeStorageTargetId);

    this.submissionOrderMap = parseSubmissionOrders(await this.repo.get(SUBMISSION_ORDER_KEY));

    try {
      const stored = JSON.parse((await this.repo.get(FOLDER_RULE_DEFAULT_KEY)) || 'null');
      this.folderRuleDefaultValue =
        stored && typeof stored.root === 'string' && Array.isArray(stored.segments)
          ? {
              root: stored.root,
              segments: stored.segments.map(toKoreanTokens),
              fileNameTemplate: stored.fileNameTemplate,
            }
          : null;
    } catch {
      this.folderRuleDefaultValue = null;
    }
  }

  /**
   * 시공종류별 입력 항목 차례.
   *
   * 업체마다 기사에게 묻는 차례가 다릅니다 — 현장을 먼저 특정하는 곳도 있고
   * 누가 갔는지를 먼저 적는 곳도 있습니다. 그래서 하나가 아니라 시공종류마다
   * 따로 둡니다. 정해 두지 않은 시공종류는 기본 차례를 씁니다.
   */
  submissionOrders(): Record<string, SubmissionFieldKey[]> {
    const result: Record<string, SubmissionFieldKey[]> = {};
    for (const name of this.constructionTypeList) {
      result[name] = normalizeSubmissionOrder(this.submissionOrderMap[name]);
    }
    return result;
  }

  submissionOrder(constructionType = ''): SubmissionFieldKey[] {
    return normalizeSubmissionOrder(this.submissionOrderMap[constructionType]);
  }

  async setSubmissionOrder(constructionType: string, input: unknown): Promise<SubmissionFieldKey[]> {
    const name = normalizeTypeName(constructionType);
    if (!this.constructionTypeList.includes(name)) {
      throw new SettingsError('등록되지 않은 시공종류입니다.', 404);
    }
    // 저장 전에 정규화합니다. 모르는 키나 빠진 키가 들어와도 화면에서 항목이
    // 사라지지 않아야 하고, 그 보정은 읽는 쪽마다 하는 것보다 여기서 한 번
    // 하는 편이 어긋날 여지가 없습니다.
    this.submissionOrderMap = {
      ...this.submissionOrderMap,
      [name]: normalizeSubmissionOrder(input),
    };
    await this.repo.set(SUBMISSION_ORDER_KEY, JSON.stringify(this.submissionOrderMap));
    return this.submissionOrder(name);
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
    this.constructionTypeConfigList.push(defaultTypeConfig(name, this.folderRuleValue));
    await this.persistConstructionTypeConfigs();
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
    this.constructionTypeConfigList = this.constructionTypeConfigList.filter(
      (entry) => entry.constructionType !== name
    );
    await this.persistConstructionTypeConfigs();
    return this.constructionTypes();
  }

  constructionTypeConfigs(): ConstructionTypeConfig[] {
    return this.constructionTypeList.map((name) => {
      const found = this.constructionTypeConfigList.find((entry) => entry.constructionType === name)
        ?? defaultTypeConfig(name, this.folderRuleValue);
      return cloneTypeConfig(found);
    });
  }

  constructionTypeConfig(name: string): ConstructionTypeConfig | null {
    return this.constructionTypeConfigs().find((entry) => entry.constructionType === name) ?? null;
  }

  /**
   * 주문서에서 들어온 현장종류를 그 시공종류의 선택값으로 반영합니다.
   *
   * 현장종류는 시트 탭 이름입니다("롯데백화점(흥주부)"). 관리자가 그 목록을
   * 손으로 유지하게 하면 시트에 탭이 하나 늘 때마다 설정 화면을 다시 열어야
   * 하고, 잊으면 기사 화면의 직접 입력에서 그 현장을 고를 수 없게 됩니다.
   * 그래서 주문서를 읽을 때마다 자동으로 채웁니다.
   *
   * 시트에 있는 탭 이름 **그대로** 맞춥니다 — 더하기만 하지 않고 없어진
   * 이름은 뺍니다. 예전에는 더하기만 해서, 시험 삼아 만들었다 지운 탭
   * ("롯데백화점(흥주부)1")이 선택값에 영원히 남았습니다. 주문서가 원본이고
   * 이 목록은 그 사본이므로, 원본에 없는 이름이 남아 있으면 기사가 존재하지
   * 않는 현장을 고를 수 있게 됩니다.
   */
  async ensureSiteTypeOptions(constructionType: string, names: string[]): Promise<void> {
    const wanted = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (wanted.length === 0 || !this.constructionTypeList.includes(constructionType)) return;

    const existing = this.constructionTypeConfig(constructionType);
    if (!existing) return;

    const field = existing.fields.find((entry) => entry.token === 'siteType');
    const current = field?.options ?? [];
    const same =
      current.length === wanted.length && current.every((name, index) => name === wanted[index]);
    if (field && same) return;

    const fields = field
      ? existing.fields.map((entry) =>
          entry.token === 'siteType' ? { ...entry, options: wanted } : entry
        )
      : [
          // 처음 들어온 경우 항목 자체를 만들어 줍니다. 폴더 규칙에서 {siteType}
          // 으로 쓸 수 있게 되는 것이 이 항목의 목적입니다.
          ...existing.fields,
          {
            id: 'site-type',
            label: '현장종류',
            token: 'siteType',
            inputType: 'select' as const,
            required: false,
            options: wanted,
          },
        ];

    this.constructionTypeConfigList = [
      ...this.constructionTypeConfigList.filter((entry) => entry.constructionType !== constructionType),
      { ...existing, fields },
    ];
    await this.persistConstructionTypeConfigs();
  }

  async setConstructionTypeConfig(
    name: string,
    input: Partial<ConstructionTypeConfig>
  ): Promise<ConstructionTypeConfig> {
    if (!this.constructionTypeList.includes(name)) {
      throw new SettingsError('등록되지 않은 시공종류입니다.', 404);
    }
    const existing = this.constructionTypeConfig(name)!;
    const fields = normalizeDynamicFields(input.fields ?? existing.fields);

    const root = normalizePath(input.folderRule?.root ?? existing.folderRule.root);
    const segments = (input.folderRule?.segments ?? existing.folderRule.segments)
      .map((segment) => toKoreanTokens(normalizeSegment(segment))).filter(Boolean);
    if (segments.length === 0 || segments.length > MAX_SEGMENTS) {
      throw new SettingsError(`폴더 단계는 1개 이상 ${MAX_SEGMENTS}개 이하로 지정해 주세요.`);
    }
    if (/[\\:*?"<>|]/.test(root) || segments.some((segment) => /[\\/:*?"<>|]/.test(segment))) {
      throw new SettingsError('폴더 이름에는 \\ : * ? " < > | 문자를 사용할 수 없습니다.');
    }

    const updated: ConstructionTypeConfig = {
      constructionType: name,
      fields,
      folderRule: { root, segments, fileNameTemplate: validateFileNameTemplate(input.folderRule?.fileNameTemplate ?? existing.folderRule.fileNameTemplate) },
    };
    this.constructionTypeConfigList = [
      ...this.constructionTypeConfigList.filter((entry) => entry.constructionType !== name),
      updated,
    ];
    await this.persistConstructionTypeConfigs();
    return cloneTypeConfig(updated);
  }

  storageTarget(): SharePointStorageTarget {
    return { ...(this.storageTargetList.find((target) => target.id === this.activeStorageTargetId)
      ?? this.storageTargetList[0]) };
  }

  storageTargets(): { targets: SharePointStorageTarget[]; activeTargetId: string } {
    return { targets: this.storageTargetList.map((target) => ({ ...target })), activeTargetId: this.activeStorageTargetId };
  }

  /**
   * Creates or updates one saved destination.
   *
   * `channelFolder` is no longer something an administrator types. Graph
   * reports the channel's real folder when the target is resolved by name, and
   * that answer is authoritative — a standard channel's folder is not always
   * spelled the same as the channel (renaming a channel does not rename the
   * folder behind it). So an edit that does not carry the field keeps whatever
   * was resolved, and only a brand-new hand-entered target falls back to the
   * channel name.
   */
  async saveStorageTarget(input: Partial<SharePointStorageTarget>): Promise<SharePointStorageTarget> {
    const id = String(input.id || '').trim() || makeId('target');
    const existing = this.storageTargetList.find((entry) => entry.id === id) ?? null;

    const target: SharePointStorageTarget = {
      id,
      accountEmail: String(input.accountEmail ?? existing?.accountEmail ?? '').trim().slice(0, 254),
      teamName: cleanLabel(input.teamName ?? existing?.teamName, 80),
      channelName: cleanLabel(input.channelName ?? existing?.channelName, 80),
      teamId: String(input.teamId ?? existing?.teamId ?? '').trim(),
      channelId: String(input.channelId ?? existing?.channelId ?? '').trim(),
      siteId: String(input.siteId ?? existing?.siteId ?? '').trim(),
      driveId: String(input.driveId ?? existing?.driveId ?? '').trim(),
      channelFolder: normalizePath(
        input.channelFolder ?? existing?.channelFolder ?? input.channelName ?? ''
      ),
    };
    if (!target.teamName || !target.channelName) {
      throw new SettingsError('Teams 팀 이름과 채널 이름을 입력해 주세요.');
    }
    if (!target.siteId && !target.driveId) {
      throw new SettingsError(
        '이 저장 대상에 연결된 SharePoint 위치가 없습니다. Microsoft 로그인 후 팀·채널 이름으로 다시 연결해 주세요.'
      );
    }
    if (!existing && this.storageTargetList.length >= MAX_STORAGE_TARGETS) {
      throw new SettingsError(`저장 대상은 최대 ${MAX_STORAGE_TARGETS}개까지 등록할 수 있습니다.`);
    }

    this.storageTargetList = existing
      ? this.storageTargetList.map((entry) => entry.id === target.id ? target : entry)
      : [...this.storageTargetList, target];
    if (!this.activeStorageTargetId) this.activeStorageTargetId = target.id;
    await this.persistStorageTargets();
    return { ...target };
  }

  async selectStorageTarget(id: string): Promise<SharePointStorageTarget> {
    const target = this.storageTargetList.find((entry) => entry.id === id);
    if (!target) throw new SettingsError('등록되지 않은 저장 대상입니다.', 404);
    this.activeStorageTargetId = id;
    await this.repo.set(ACTIVE_STORAGE_TARGET_KEY, id);
    return { ...target };
  }

  async removeStorageTarget(id: string): Promise<void> {
    if (this.storageTargetList.length <= 1) throw new SettingsError('저장 대상은 최소 1개 이상 남아 있어야 합니다.');
    if (!this.storageTargetList.some((entry) => entry.id === id)) throw new SettingsError('등록되지 않은 저장 대상입니다.', 404);
    this.storageTargetList = this.storageTargetList.filter((entry) => entry.id !== id);
    if (this.activeStorageTargetId === id) {
      this.activeStorageTargetId = this.storageTargetList[0].id;
      await this.repo.set(ACTIVE_STORAGE_TARGET_KEY, this.activeStorageTargetId);
    }
    await this.persistStorageTargets();
  }

  /** Rule used by uploads: channel folder + the selected type's own rule. */
  effectiveFolderRule(constructionType: string): FolderRule {
    const configured = this.constructionTypeConfig(constructionType);
    const selected = configured?.folderRule ?? this.folderRuleValue;
    const root = [this.storageTarget().channelFolder, selected.root].filter(Boolean).join('/');
    return { ...this.folderRuleValue, ...selected, root, segments: [...selected.segments],
      fileNameTemplate: selected.fileNameTemplate || this.folderRuleValue.fileNameTemplate };
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

  private rosterWrite: Promise<unknown> = Promise.resolve();
  private writeRoster<T>(work: () => Promise<T>): Promise<T> {
    const task = this.rosterWrite.then(work);
    this.rosterWrite = task.catch(() => undefined);
    return task;
  }
  addTechnician(input: Parameters<SettingsService['addTechnicianUnlocked']>[0]): Promise<Technician> {
    return this.writeRoster(() => this.addTechnicianUnlocked(input));
  }
  private async addTechnicianUnlocked(input: {
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
    if (!title) throw new SettingsError(`직함은 ${TECHNICIAN_TITLES.join(' / ')} 중에서 선택해 주세요.`);
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
  importTechnicians(table: SheetTable, allowedTypes: string[], createdBy: string): Promise<number> {
    return this.writeRoster(() => this.importTechniciansUnlocked(table, allowedTypes, createdBy));
  }
  private async importTechniciansUnlocked(table: SheetTable, allowedTypes: string[], createdBy: string): Promise<number> {
    const result = validateTechnicianImport(table, this.technicianList, allowedTypes.filter((type) => this.constructionTypeList.includes(type)));
    if (result.errors.length) throw new SettingsError(result.errors.join('\n'));
    const added = result.rows.map((row): Technician => ({ ...row, id: `tech-${crypto.randomBytes(6).toString('hex')}`, createdBy, createdAt: new Date().toISOString() }));
    const next = [...this.technicianList, ...added];
    // Persist the complete batch before exposing any newly imported person.
    await this.repo.set(TECHNICIANS_KEY, JSON.stringify(next));
    this.technicianList = next;
    return added.length;
  }

  /** Edits a roster entry. Past submissions keep their own name/title snapshot. */
  updateTechnician(id: string, patch: Parameters<SettingsService['updateTechnicianUnlocked']>[1]): Promise<Technician> {
    return this.writeRoster(() => this.updateTechnicianUnlocked(id, patch));
  }
  private async updateTechnicianUnlocked(
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
    if (!title) throw new SettingsError(`직함은 ${TECHNICIAN_TITLES.join(' / ')} 중에서 선택해 주세요.`);
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

  removeTechnician(id: string): Promise<void> {
    return this.writeRoster(() => this.removeTechnicianUnlocked(id));
  }
  private async removeTechnicianUnlocked(id: string): Promise<void> {
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

  /**
   * 관리자가 "기본값"으로 저장해 둔 폴더 규칙.
   *
   * 지금 쓰는 규칙과 따로 둡니다. 운영 중에 규칙을 이리저리 바꿔 보다가
   * 원래대로 돌아가고 싶을 때, 코드에 박힌 초기값이 아니라 **이 회사가 정한
   * 값**으로 돌아가야 의미가 있습니다. 저장해 둔 값이 없으면 null 입니다.
   */
  folderRuleDefault(): { root: string; segments: string[]; fileNameTemplate?: string } | null {
    return this.folderRuleDefaultValue ? { ...this.folderRuleDefaultValue } : null;
  }

  async saveFolderRuleAsDefault(): Promise<void> {
    this.folderRuleDefaultValue = {
      root: this.folderRuleValue.root,
      segments: [...this.folderRuleValue.segments],
      fileNameTemplate: this.folderRuleValue.fileNameTemplate,
    };
    await this.repo.set(FOLDER_RULE_DEFAULT_KEY, JSON.stringify(this.folderRuleDefaultValue));
  }

  folderRule(): FolderRule {
    return { ...this.folderRuleValue, segments: [...this.folderRuleValue.segments] };
  }

  async setFolderRule(input: {
    root: string;
    segments: string[];
    fileNameTemplate?: string;
  }): Promise<FolderRule> {
    const previous = this.folderRuleValue;
    // The root is a path, not one name: targeting a Teams channel means
    // "채널이름/시공현장자료". Each level is tidied separately so the slashes
    // survive while the names themselves stay clean.
    const root = (typeof input.root === 'string' ? input.root : '')
      .split('/')
      .map(normalizeSegment)
      .filter(Boolean)
      .join('/');
    if (!root) throw new SettingsError('최상위 폴더 이름을 입력해 주세요.');

    // 영문 토큰은 저장할 때 한글 이름으로 바꿉니다. 해석은 두 이름을 모두
    // 받으므로 동작은 그대로이고, 다음에 이 규칙을 열어 보는 사람이 무엇이
    // 들어갈지 바로 읽을 수 있게 됩니다.
    const segments = (Array.isArray(input.segments) ? input.segments : [])
      .map((segment) => toKoreanTokens(normalizeSegment(segment)))
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

    /*
     * 파일 이름 규칙. 공통 하나만 둡니다.
     *
     * {번호} 가 없으면 한 폴더의 모든 파일이 같은 이름이 되고 SharePoint 는
     * 같은 이름을 덮어씁니다 — 11장을 올렸는데 1장만 남습니다. 저장하는
     * 시점에 막습니다. 실수를 조용히 고쳐 주는 것보다 지금 알려 주는 편이
     * 낫습니다.
     */
    const fileNameTemplate =
      toKoreanTokens(
        String(input.fileNameTemplate ?? this.folderRuleValue.fileNameTemplate ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
      ) || DEFAULT_FILE_NAME_TEMPLATE;
    if (!fileNameTemplate.includes('{번호}')) {
      throw new SettingsError(
        '파일 이름 규칙에는 {번호} 가 반드시 들어가야 합니다. 없으면 같은 이름끼리 덮어써서 자료가 사라집니다.'
      );
    }
    if (/[\\/:*?"<>|]/.test(fileNameTemplate)) {
      throw new SettingsError('파일 이름에는 \\ / : * ? " < > | 문자를 사용할 수 없습니다.');
    }

    this.folderRuleValue = { ...this.folderRuleValue, root, segments, fileNameTemplate };
    this.constructionTypeConfigList = this.constructionTypeConfigList.map((entry) =>
      entry.folderRule.root === previous.root &&
      JSON.stringify(entry.folderRule.segments) === JSON.stringify(previous.segments)
        ? { ...entry, folderRule: { ...entry.folderRule, root, segments: [...segments] } }
        : entry
    );
    await this.repo.set(FOLDER_RULE_KEY, JSON.stringify({ root, segments, fileNameTemplate }));
    await this.persistConstructionTypeConfigs();
    return this.folderRule();
  }

  /* ---------------------------------------------------------------- */
  /* Teams 알림                                                         */
  /* ---------------------------------------------------------------- */

  teamsWebhooks(): TeamsWebhookProfile[] {
    return this.teamsWebhookList.map((entry) => ({ ...entry }));
  }

  teamsWebhookUrls(): string[] {
    return this.teamsWebhookList.map((entry) => entry.url);
  }

  teamsWebhookUrl(): string {
    return this.teamsWebhookList[0]?.url || '';
  }

  async saveTeamsWebhook(input: Partial<TeamsWebhookProfile>): Promise<TeamsWebhookProfile> {
    const url = String(input.url || '').trim();

    assertTeamsWebhookUrl(url);

    const profile: TeamsWebhookProfile = {
      id: String(input.id || '').trim() || makeId('hook'),
      teamName: cleanLabel(input.teamName, 80),
      channelName: cleanLabel(input.channelName, 80),
      url,
    };
    if (!profile.teamName || !profile.channelName) {
      throw new SettingsError('Teams 팀 이름과 채널 이름을 입력해 주세요.');
    }
    // The same address saved twice would post the same card to the same channel
    // twice per submission, which reads in Teams as a duplicate submission.
    if (this.teamsWebhookList.some((entry) => entry.id !== profile.id && entry.url === profile.url)) {
      throw new SettingsError('이미 등록된 워크플로 주소입니다.', 409);
    }
    const exists = this.teamsWebhookList.some((entry) => entry.id === profile.id);
    if (!exists && this.teamsWebhookList.length >= MAX_TEAMS_WEBHOOKS) {
      throw new SettingsError(`Teams 알림 대상은 최대 ${MAX_TEAMS_WEBHOOKS}개까지 등록할 수 있습니다.`);
    }
    this.teamsWebhookList = exists
      ? this.teamsWebhookList.map((entry) => entry.id === profile.id ? profile : entry)
      : [...this.teamsWebhookList, profile];
    await this.persistTeamsWebhooks();
    return { ...profile };
  }

  async removeTeamsWebhook(id: string): Promise<void> {
    if (!this.teamsWebhookList.some((entry) => entry.id === id)) {
      throw new SettingsError('등록되지 않은 Teams 알림입니다.', 404);
    }
    this.teamsWebhookList = this.teamsWebhookList.filter((entry) => entry.id !== id);
    await this.persistTeamsWebhooks();
  }

  /* ---------------------------------------------------------------- */

  private async persistConstructionTypes(): Promise<void> {
    await this.repo.set(CONSTRUCTION_TYPES_KEY, JSON.stringify(this.constructionTypeList));
  }

  private async persistConstructionTypeConfigs(): Promise<void> {
    await this.repo.set(CONSTRUCTION_TYPE_CONFIGS_KEY, JSON.stringify(this.constructionTypeConfigList));
  }

  private async persistStorageTargets(): Promise<void> {
    await this.repo.set(STORAGE_TARGETS_KEY, JSON.stringify(this.storageTargetList));
  }

  private async persistTeamsWebhooks(): Promise<void> {
    await this.repo.set(TEAMS_WEBHOOKS_KEY, JSON.stringify(this.teamsWebhookList));
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

function normalizePath(value: unknown): string {
  return typeof value === 'string'
    ? value.split('/').map(normalizeSegment).filter(Boolean).join('/')
    : '';
}

function normalizeOption(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

function cleanLabel(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

/**
 * 저장된 차례를 읽습니다.
 *
 * 예전에는 전체가 하나의 배열이었습니다. 그 형태로 저장된 값을 만나면 모든
 * 시공종류의 출발점으로 삼지 않고 버립니다 — 업체별로 다르게 쓰라고 나눈
 * 것인데 옛 값을 전부에 복사하면 나눈 의미가 없어집니다. 정하지 않은
 * 시공종류는 어차피 기본 차례로 그려집니다.
 */
function parseSubmissionOrders(raw: string | null): Record<string, SubmissionFieldKey[]> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    const result: Record<string, SubmissionFieldKey[]> = {};
    for (const [name, order] of Object.entries(value)) {
      result[name] = normalizeSubmissionOrder(order);
    }
    return result;
  } catch {
    return {};
  }
}

function defaultTypeConfig(name: string, rule: FolderRule): ConstructionTypeConfig {
  return {
    constructionType: name,
    fields: [],
    folderRule: { root: rule.root, segments: [...rule.segments] },
  };
}

function validateFileNameTemplate(value: unknown): string | undefined {
  const template = toKoreanTokens(String(value ?? '').trim().replace(/\s+/g, ' '));
  if (!template) return undefined;
  if (template.length > 120 || !template.includes('{번호}') || /[\\/:*?"<>|]/.test(template)) {
    throw new SettingsError('파일 이름 규칙은 120자 이내이며 {번호}가 필요합니다. \\ / : * ? " < > | 는 사용할 수 없습니다.');
  }
  return template;
}

function cloneTypeConfig(value: ConstructionTypeConfig): ConstructionTypeConfig {
  return {
    ...value,
    fields: value.fields.map((field) => ({ ...field, options: [...field.options] })),
    folderRule: { ...value.folderRule, segments: [...value.folderRule.segments] },
  };
}

function parseConstructionTypeConfigs(
  raw: string | null,
  names: string[],
  fallbackRule: FolderRule
): ConstructionTypeConfig[] {
  let parsed: unknown[] = [];
  try {
    const value = raw ? JSON.parse(raw) : [];
    if (Array.isArray(value)) parsed = value;
  } catch {
    parsed = [];
  }
  return names.map((name) => {
    const value: any = parsed.find((entry: any) => entry?.constructionType === name);
    if (!value) return defaultTypeConfig(name, fallbackRule);
    const legacyFields: DynamicFieldConfig[] = [];
    if (value.siteType?.enabled) legacyFields.push({
      id: 'site-type', label: '현장종류', token: 'siteType', inputType: 'select',
      required: Boolean(value.siteType.required),
      options: Array.isArray(value.siteType.options) ? value.siteType.options : [],
    });
    if (value.customerName?.enabled) legacyFields.push({
      id: 'customer-name', label: '주문자명', token: 'customerName', inputType: 'text',
      required: Boolean(value.customerName.required), options: [],
    });
    const segments: string[] = Array.isArray(value.folderRule?.segments)
      ? value.folderRule.segments.map(normalizeSegment).filter(Boolean) as string[]
      : [...fallbackRule.segments];
    let fields: DynamicFieldConfig[] = [];
    try {
      fields = normalizeDynamicFields(Array.isArray(value.fields) ? value.fields : legacyFields);
    } catch {
      fields = legacyFields.filter((field) => field.inputType !== 'select' || field.options.length > 0);
    }
    return {
      constructionType: name,
      fields,
      folderRule: {
        root: normalizePath(value.folderRule?.root ?? fallbackRule.root),
        segments: segments.length ? segments : [...fallbackRule.segments],
        ...(value.folderRule?.fileNameTemplate ? { fileNameTemplate: validateFileNameTemplate(value.folderRule.fileNameTemplate) } : {}),
      },
    };
  });
}

function parseStorageTarget(raw: string | null): SharePointStorageTarget | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    return {
      id: String(value.id || '').trim() || makeId('target'),
      accountEmail: String(value.accountEmail || '').trim().slice(0, 254),
      teamName: cleanLabel(value.teamName, 80),
      channelName: cleanLabel(value.channelName, 80),
      teamId: String(value.teamId || '').trim(),
      channelId: String(value.channelId || '').trim(),
      siteId: String(value.siteId || '').trim(),
      driveId: String(value.driveId || '').trim(),
      channelFolder: normalizePath(value.channelFolder || value.channelName),
    };
  } catch {
    return null;
  }
}

function parseStorageTargets(raw: string | null): SharePointStorageTarget[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => parseStorageTarget(JSON.stringify(value))).filter(Boolean) as SharePointStorageTarget[];
  } catch { return []; }
}

function parseTeamsWebhooks(raw: string | null): TeamsWebhookProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value) => value && typeof value.url === 'string').map((value) => ({
      id: String(value.id || '').trim() || makeId('hook'),
      teamName: cleanLabel(value.teamName, 80) || 'Teams',
      channelName: cleanLabel(value.channelName, 80) || '채널',
      url: String(value.url).trim(),
    })).filter((value) => value.url);
  } catch { return []; }
}

/**
 * Turns an item name into a folder token an administrator would recognise.
 *
 * "주문번호" becomes {주문번호}, not {field_9f2a1c}. The old random suffix was
 * unique and completely opaque: the admin who added the field had to copy an
 * arbitrary hex string out of one card to use it in the folder template below,
 * and could not tell two of them apart afterwards. A name derived from the
 * label is guessable, readable in the saved rule, and still editable by hand.
 */
function tokenFromLabel(label: string): string {
  const derived = label
    .replace(/\s+/g, '_')
    // Anything the template syntax cannot carry is dropped rather than mangled.
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/^[-]+/, '')
    .slice(0, 30);
  return isValidFieldToken(derived) ? derived : `field_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeDynamicFields(values: unknown): DynamicFieldConfig[] {
  if (!Array.isArray(values)) return [];
  if (values.length > 20) throw new SettingsError('추가 입력 항목은 시공종류별 최대 20개까지 만들 수 있습니다.');
  const seenLabels = new Set<string>();
  const seenTokens = new Set<string>();
  const seenIds = new Set<string>();
  return values.map((raw: any) => {
    const label = cleanLabel(raw?.label, 30);
    if (!label) throw new SettingsError('추가 입력 항목 이름을 입력해 주세요.');
    if (seenLabels.has(label.toLowerCase())) throw new SettingsError(`중복된 입력 항목입니다: ${label}`);
    seenLabels.add(label.toLowerCase());
    const inputType = raw?.inputType === 'select' ? 'select' : 'text';
    const options = inputType === 'select'
      ? [...new Set<string>((Array.isArray(raw?.options) ? raw.options : []).map(normalizeOption).filter(Boolean))]
      : [];
    if (inputType === 'select' && options.length === 0) {
      throw new SettingsError(`${label} 선택값을 1개 이상 입력해 주세요.`);
    }
    if (options.length > 200) throw new SettingsError(`${label} 선택값은 최대 200개까지 등록할 수 있습니다.`);
    // 같은 id 가 두 번 오면 새 id 를 줍니다. 화면은 입력값을 id 로 담으므로
    // 중복된 id 는 두 칸이 서로의 값을 덮어쓰는 결과가 됩니다.
    let id = String(raw?.id || '').trim() || makeId('field');
    if (seenIds.has(id)) id = makeId('field');
    seenIds.add(id);

    // A token the admin typed is honoured as typed; a blank one is derived from
    // the label. Only a genuinely unusable value is rejected, and the message
    // says which rule it broke rather than silently substituting a random name.
    const requestedToken = String(raw?.token || '').trim();
    let token = requestedToken || tokenFromLabel(label);
    // Legacy configurations carry these two built-in names, so they stay valid
    // even though they also exist as submission fields.
    const grandfathered =
      token === 'siteType' || token === 'customerName' ||
      token === '현장종류' || token === '주문자명';
    if (!grandfathered && !isValidFieldToken(token)) {
      if ((RESERVED_TOKENS as readonly string[]).includes(token)) {
        throw new SettingsError(
          `'${token}' 은(는) 시스템이 이미 쓰고 있는 폴더 토큰입니다. (${label}) 다른 이름을 지어 주세요.`
        );
      }
      throw new SettingsError(
        `'${token}' 은(는) 폴더 토큰으로 쓸 수 없습니다. (${label}) 한글·영문·숫자·밑줄만 30자 이내로 써 주세요.`
      );
    }
    if (seenTokens.has(token)) {
      throw new SettingsError(`중복된 폴더 토큰입니다: {${token}} (${label})`);
    }
    seenTokens.add(token);
    return { id, label, token, inputType, required: Boolean(raw?.required), options };
  });
}

function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
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

    // Only the editable fields are stored; the rest stay as configured.
    return {
      ...loadFolderRuleFromEnv(),
      root: parsed.root,
      segments,
      fileNameTemplate:
        typeof parsed?.fileNameTemplate === 'string' && parsed.fileNameTemplate.trim()
          ? parsed.fileNameTemplate.trim()
          : DEFAULT_FILE_NAME_TEMPLATE,
    };
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
