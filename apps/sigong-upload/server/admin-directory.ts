import { config } from './config';
import { hashPassword, verifyPassword } from './auth';
import type { AdminUserRepository, StoredAdminUser } from './repositories';
import type { AdminRole, AdminUser, AssignableRole, ViewScope } from '../src/types';

/** Usernames are used as Table Storage row keys, so keep them simple. */
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/i;
export const MIN_PASSWORD_LENGTH = 10;

export class AdminError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface ResolvedAdmin {
  username: string;
  displayName: string;
  role: AdminRole;
  /** COMPANY only — 조회 허용 시공종류. */
  constructionTypes: string[];
  /** TECH only — linked roster entry. */
  technicianId?: string;
}

/**
 * What this account may read in 시공현황 리스트.
 *
 * Always derived on the server from the stored account, never from anything the
 * client sends — the scope is the only thing standing between one 업체 and
 * another's submissions.
 */
export function scopeOf(admin: ResolvedAdmin): ViewScope {
  if (admin.role === 'MASTER') {
    return { all: true, constructionTypes: [] };
  }
  if (admin.role === 'COMPANY') {
    return { all: false, constructionTypes: admin.constructionTypes };
  }
  return { all: false, constructionTypes: [], technicianId: admin.technicianId };
}

/**
 * The account directory.
 *
 * The master account lives in environment configuration rather than the record
 * store, so a lost or corrupted table can never lock everyone out — and the
 * master can always be recovered by changing an App Setting. Every other admin
 * is stored, and can be added, disabled, or removed by the master.
 */
export class AdminDirectory {
  /** Short-lived cache so a disabled account stops working promptly without
   *  costing a store read on every single admin request. */
  private cache = new Map<string, { user: StoredAdminUser | null; at: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly repo: AdminUserRepository) {}

  private isMaster(username: string): boolean {
    return username.toLowerCase() === config.admin.username.toLowerCase();
  }

  private masterProfile(): ResolvedAdmin {
    return {
      username: config.admin.username,
      displayName: config.admin.displayName,
      role: 'MASTER',
      constructionTypes: [],
    };
  }

  private async fetch(username: string): Promise<StoredAdminUser | null> {
    const cached = this.cache.get(username);
    if (cached && Date.now() - cached.at < AdminDirectory.CACHE_TTL_MS) {
      return cached.user;
    }

    const user = await this.repo.get(username);
    this.cache.set(username, { user, at: Date.now() });
    return user;
  }

  private invalidate(username?: string): void {
    if (username) this.cache.delete(username);
    else this.cache.clear();
  }

  /**
   * Verifies a login. Runs the password KDF in every branch so a wrong username
   * is not distinguishable from a wrong password by response time.
   */
  async authenticate(username: string, password: string): Promise<ResolvedAdmin | null> {
    const name = (username || '').trim();

    if (this.isMaster(name)) {
      const ok = config.admin.passwordHash
        ? verifyPassword(password || '', config.admin.passwordHash)
        : false;
      return ok ? this.masterProfile() : null;
    }

    const user = await this.fetch(name);
    if (!user) {
      // Burn comparable time against a throwaway hash.
      verifyPassword(password || '', config.admin.passwordHash || hashPassword('x'));
      return null;
    }

    const ok = verifyPassword(password || '', user.passwordHash);
    if (!ok || user.disabled) return null;

    // Best-effort; a failed timestamp write must not block the login.
    this.repo
      .save({ ...user, lastLoginAt: new Date().toISOString() })
      .then(() => this.invalidate(name))
      .catch((err) => console.error('[auth] lastLoginAt 기록 실패', err));

    return toResolved(user);
  }

  /** Re-checks that a session's account still exists and is still enabled. */
  async resolveActive(username: string): Promise<ResolvedAdmin | null> {
    if (this.isMaster(username)) return this.masterProfile();

    const user = await this.fetch(username);
    if (!user || user.disabled) return null;
    return toResolved(user);
  }

  /**
   * Every account, master first.
   *
   * `viewer` narrows the list for a 업체 관리자 so they only manage the 시공기사
   * accounts they created — they must not see, let alone edit, another
   * company's people.
   */
  async list(viewer?: ResolvedAdmin): Promise<AdminUser[]> {
    const stored = await this.repo.list();
    const rows = stored.map<AdminUser>((user) => ({
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      constructionTypes: user.constructionTypes,
      technicianId: user.technicianId,
      createdAt: user.createdAt,
      createdBy: user.createdBy,
      disabled: user.disabled,
      lastLoginAt: user.lastLoginAt,
    }));

    if (viewer && viewer.role !== 'MASTER') {
      return rows.filter((row) => row.createdBy === viewer.username);
    }

    const master: AdminUser = {
      ...this.masterProfile(),
      createdAt: '',
      createdBy: '환경설정',
      disabled: false,
    };
    return [master, ...rows];
  }

  async create(input: {
    username: string;
    displayName: string;
    password: string;
    role: AssignableRole;
    constructionTypes: string[];
    technicianId?: string;
    /** The account doing the creating — decides what it is allowed to hand out. */
    actor: ResolvedAdmin;
  }): Promise<AdminUser> {
    const username = input.username.trim();

    if (!USERNAME_PATTERN.test(username)) {
      throw new AdminError('아이디는 영문·숫자·(._-) 3~32자로 입력해 주세요.');
    }
    if (this.isMaster(username)) {
      throw new AdminError('마스터 계정과 같은 아이디는 사용할 수 없습니다.', 409);
    }
    if (await this.repo.get(username)) {
      throw new AdminError('이미 존재하는 아이디입니다.', 409);
    }
    if ((input.password || '').length < MIN_PASSWORD_LENGTH) {
      throw new AdminError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    }

    const role: AssignableRole = input.role === 'COMPANY' ? 'COMPANY' : 'TECH';

    // A 업체 관리자 may issue 시공기사 logins, but must not mint peers for
    // itself or widen anyone's reach beyond the types it already holds.
    if (input.actor.role !== 'MASTER') {
      if (role !== 'TECH') {
        throw new AdminError('업체 관리자는 시공기사 계정만 생성할 수 있습니다.', 403);
      }
    }

    const constructionTypes = role === 'COMPANY' ? dedupe(input.constructionTypes) : [];
    if (role === 'COMPANY' && constructionTypes.length === 0) {
      throw new AdminError('관리자 계정은 담당 시공종류를 1개 이상 지정해야 합니다.');
    }
    if (role === 'TECH' && !input.technicianId) {
      throw new AdminError('시공기사 계정은 명부에서 기사를 지정해야 합니다.');
    }

    const user: StoredAdminUser = {
      username,
      displayName: input.displayName.trim() || username,
      role,
      constructionTypes,
      technicianId: role === 'TECH' ? input.technicianId : undefined,
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
      createdBy: input.actor.username,
      disabled: false,
    };

    await this.repo.save(user);
    this.invalidate(username);

    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      constructionTypes: user.constructionTypes,
      technicianId: user.technicianId,
      createdAt: user.createdAt,
      createdBy: user.createdBy,
      disabled: false,
    };
  }

  private async requireStored(username: string, actor?: ResolvedAdmin): Promise<StoredAdminUser> {
    if (this.isMaster(username)) {
      throw new AdminError('마스터 계정은 화면에서 변경할 수 없습니다. 환경변수를 수정하세요.', 403);
    }
    const user = await this.repo.get(username);
    if (!user) throw new AdminError('계정을 찾을 수 없습니다.', 404);

    // A 업체 관리자 may only touch the accounts it issued itself.
    if (actor && actor.role !== 'MASTER' && user.createdBy !== actor.username) {
      throw new AdminError('이 계정을 변경할 권한이 없습니다.', 403);
    }
    return user;
  }

  /** Throws unless `actor` is allowed to modify `username`. */
  async assertCanManage(username: string, actor: ResolvedAdmin): Promise<void> {
    await this.requireStored(username, actor);
  }

  async setDisabled(username: string, disabled: boolean): Promise<void> {
    const user = await this.requireStored(username);
    await this.repo.save({ ...user, disabled });
    this.invalidate(username);
  }

  /** Switches an existing account between 관리자 and 시공기사. */
  async setRole(username: string, role: AssignableRole): Promise<void> {
    if (role !== 'COMPANY' && role !== 'TECH') {
      throw new AdminError('권한은 관리자 또는 시공기사 중에서 선택해 주세요.');
    }
    const user = await this.requireStored(username);

    // Clear the scope that no longer applies, so a demoted 관리자 cannot keep
    // reading a company's data through a leftover field.
    await this.repo.save({
      ...user,
      role,
      constructionTypes: role === 'COMPANY' ? user.constructionTypes : [],
      technicianId: role === 'TECH' ? user.technicianId : undefined,
    });
    this.invalidate(username);
  }

  /** Sets which 시공종류 a 업체 관리자 may read. */
  async setConstructionTypes(username: string, types: string[]): Promise<void> {
    const user = await this.requireStored(username);
    if (user.role !== 'COMPANY') {
      throw new AdminError('담당 시공종류는 관리자 권한 계정에만 지정할 수 있습니다.');
    }

    const constructionTypes = dedupe(types);
    if (constructionTypes.length === 0) {
      throw new AdminError('담당 시공종류를 1개 이상 지정해야 합니다.');
    }

    await this.repo.save({ ...user, constructionTypes });
    this.invalidate(username);
  }

  /** Links a 시공기사 account to its roster entry. */
  async setTechnicianId(username: string, technicianId: string): Promise<void> {
    const user = await this.requireStored(username);
    if (user.role !== 'TECH') {
      throw new AdminError('기사 연결은 시공기사 권한 계정에만 지정할 수 있습니다.');
    }
    if (!technicianId) {
      throw new AdminError('명부에서 기사를 선택해 주세요.');
    }

    await this.repo.save({ ...user, technicianId });
    this.invalidate(username);
  }

  /** True when any account is still linked to this roster entry. */
  async isTechnicianLinked(technicianId: string): Promise<boolean> {
    const users = await this.repo.list();
    return users.some((user) => user.technicianId === technicianId);
  }

  async resetPassword(username: string, password: string): Promise<void> {
    if ((password || '').length < MIN_PASSWORD_LENGTH) {
      throw new AdminError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
    }
    const user = await this.requireStored(username);
    await this.repo.save({ ...user, passwordHash: hashPassword(password) });
    this.invalidate(username);
  }

  async remove(username: string): Promise<void> {
    await this.requireStored(username);
    await this.repo.remove(username);
    this.invalidate(username);
  }
}

function toResolved(user: StoredAdminUser): ResolvedAdmin {
  return {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    constructionTypes: user.constructionTypes,
    technicianId: user.technicianId,
  };
}

function dedupe(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) seen.add(value.trim());
  }
  return [...seen];
}
