import { config } from './config';
import { hashPassword, verifyPassword } from './auth';
import type { AdminUserRepository, StoredAdminUser } from './repositories';
import type { AdminRole, AdminUser, AssignableRole } from '../src/types';

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

    return { username: user.username, displayName: user.displayName, role: user.role };
  }

  /** Re-checks that a session's account still exists and is still enabled. */
  async resolveActive(username: string): Promise<ResolvedAdmin | null> {
    if (this.isMaster(username)) return this.masterProfile();

    const user = await this.fetch(username);
    if (!user || user.disabled) return null;
    return { username: user.username, displayName: user.displayName, role: user.role };
  }

  async list(): Promise<AdminUser[]> {
    const stored = await this.repo.list();
    const master: AdminUser = {
      ...this.masterProfile(),
      createdAt: '',
      createdBy: '환경설정',
      disabled: false,
    };

    return [
      master,
      ...stored.map<AdminUser>((user) => ({
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt,
        createdBy: user.createdBy,
        disabled: user.disabled,
        lastLoginAt: user.lastLoginAt,
      })),
    ];
  }

  async create(input: {
    username: string;
    displayName: string;
    password: string;
    role: AssignableRole;
    createdBy: string;
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

    const user: StoredAdminUser = {
      username,
      displayName: input.displayName.trim() || username,
      role: input.role === 'STAFF' ? 'STAFF' : 'ADMIN',
      passwordHash: hashPassword(input.password),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      disabled: false,
    };

    await this.repo.save(user);
    this.invalidate(username);

    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      createdBy: user.createdBy,
      disabled: false,
    };
  }

  private async requireStored(username: string): Promise<StoredAdminUser> {
    if (this.isMaster(username)) {
      throw new AdminError('마스터 계정은 화면에서 변경할 수 없습니다. 환경변수를 수정하세요.', 403);
    }
    const user = await this.repo.get(username);
    if (!user) throw new AdminError('계정을 찾을 수 없습니다.', 404);
    return user;
  }

  async setDisabled(username: string, disabled: boolean): Promise<void> {
    const user = await this.requireStored(username);
    await this.repo.save({ ...user, disabled });
    this.invalidate(username);
  }

  /** Switches an existing account between 관리자 and 일반. */
  async setRole(username: string, role: AssignableRole): Promise<void> {
    if (role !== 'ADMIN' && role !== 'STAFF') {
      throw new AdminError('권한은 관리자 또는 일반 중에서 선택해 주세요.');
    }
    const user = await this.requireStored(username);
    await this.repo.save({ ...user, role });
    this.invalidate(username);
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
