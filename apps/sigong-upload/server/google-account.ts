import crypto from 'crypto';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import {
  serviceAccountEmail,
  serviceAccountSource,
  serviceAccountToken,
  setStoredServiceAccount,
  verifyServiceAccount,
} from './google-service-account';
import type { GoogleAccountView } from '../src/types';

const ACCOUNT_KEY = 'googleDelegatedAccount';
/** 화면에서 등록한 서비스 계정 키. 갱신 토큰과 같은 방식으로 암호화합니다. */
const SERVICE_ACCOUNT_KEY = 'googleServiceAccountKey';
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 시트를 읽기만 합니다.
 *
 * `.readonly` 를 쓰는 것은 안전 때문만이 아닙니다 — 동의 화면에 "보기" 만
 * 나오므로, 승인하는 사람이 이 앱이 시트를 고칠 수 없다는 것을 눈으로 확인할
 * 수 있습니다. 쓰기 권한을 요청하면 그 화면에서 대부분 멈춥니다.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export class GoogleAuthError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = '') {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

interface StoredGoogleAccount {
  email: string;
  /** 암호화해서 보관합니다 — seal()/unseal(). */
  refreshToken: string;
  connectedAt: string;
}

/**
 * 구글 계정 연결.
 *
 * 링크 공유나 웹에 게시로는 조직 정책에 막히는 시트가 있습니다. 사람이 자기
 * 계정으로 한 번 로그인해 두면 그 사람이 볼 수 있는 시트는 전부 읽을 수 있고,
 * 시트마다 공유 설정을 손댈 일이 사라집니다 — 관리자가 할 일은 주소를
 * 붙여넣는 것뿐입니다.
 *
 * Microsoft 연결과 같은 구조입니다. 한 번 해 본 절차라는 점이 그 자체로
 * 가치가 있어서, 화면 흐름도 일부러 똑같이 맞췄습니다.
 */
export class GoogleAccountService {
  private account: StoredGoogleAccount | null = null;
  private cachedToken = '';
  private cachedExpiresAt = 0;
  private pendingStates = new Map<string, number>();
  private refreshInFlight: Promise<string> | null = null;

  constructor(private readonly repo: SettingsRepository) {}

  async load(): Promise<void> {
    // 서비스 계정 키가 먼저입니다. 이것만 있으면 아래 OAuth 계정이 없어도
    // 시트를 읽을 수 있고, 만료가 없어 운영 중에 조용히 끊기지 않습니다.
    const sealed = await this.repo.get(SERVICE_ACCOUNT_KEY);
    if (sealed) {
      try {
        setStoredServiceAccount(unseal(sealed));
      } catch (err) {
        // 복호화 실패는 시작을 막을 이유가 아닙니다 — 키 없이 공개 경로로
        // 내려가고, 화면에서는 "등록 안 됨"으로 보여 다시 넣을 수 있습니다.
        console.error('[google] 저장된 서비스 계정 키를 읽지 못했습니다', err);
      }
    }

    const raw = await this.repo.get(ACCOUNT_KEY);
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as StoredGoogleAccount;
      this.account = value?.refreshToken && value?.email ? value : null;
    } catch {
      this.account = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 서비스 계정 키 — 한 번 등록하면 만료 없음                            */
  /* ---------------------------------------------------------------- */

  /**
   * 붙여넣은 JSON 키를 검사해서 저장합니다.
   *
   * 저장 전에 실제로 토큰을 받아 봅니다. 여기서 통과한 키는 이후 만료되지
   * 않으므로, 이 한 번이 사실상 연동 설정의 전부입니다.
   */
  async saveServiceAccount(raw: string): Promise<GoogleAccountView> {
    const text = (raw || '').trim();
    if (!text) throw new GoogleAuthError('서비스 계정 키(JSON)를 붙여넣어 주세요.');
    if (serviceAccountSource() === 'env') {
      throw new GoogleAuthError(
        '서버 환경변수 GOOGLE_SERVICE_ACCOUNT_JSON 이 이미 설정돼 있습니다. ' +
          '화면에서 등록한 값이 그것을 덮어쓰지 않도록, 바꾸려면 환경변수를 고쳐 주세요.',
        409
      );
    }

    await verifyServiceAccount(text);
    setStoredServiceAccount(text);
    await this.repo.set(SERVICE_ACCOUNT_KEY, seal(text));
    return this.view();
  }

  async clearServiceAccount(): Promise<GoogleAccountView> {
    setStoredServiceAccount('');
    await this.repo.set(SERVICE_ACCOUNT_KEY, '');
    return this.view();
  }

  get redirectUri(): string {
    return (
      config.google.redirectUri ||
      `${config.mail.appUrl || `http://localhost:${config.port}`}/api/admin/work-orders/google/callback`
    );
  }

  isConfigured(): boolean {
    return Boolean(config.google.clientId && config.google.clientSecret);
  }

  view(): GoogleAccountView {
    return {
      configured: this.isConfigured(),
      redirectUri: this.redirectUri,
      account: this.account
        ? { email: this.account.email, connectedAt: this.account.connectedAt }
        : null,
      serviceAccountEmail: serviceAccountEmail(),
      serviceAccountSource: serviceAccountSource(),
    };
  }

  connectedEmail(): string {
    return this.account?.email || '';
  }

  /* ---------------------------------------------------------------- */

  beginSignIn(): { url: string } {
    if (!this.isConfigured()) {
      throw new GoogleAuthError(
        'Google 앱 설정(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)이 없어 로그인을 시작할 수 없습니다.',
        400
      );
    }
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [state, at] of this.pendingStates) if (at < cutoff) this.pendingStates.delete(state);

    const state = crypto.randomBytes(24).toString('base64url');
    this.pendingStates.set(state, Date.now());

    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      // refresh token 은 첫 동의에서만 나옵니다. consent 를 강제하지 않으면
      // 두 번째 로그인부터는 받지 못하고, 그러면 "기억"이 되지 않습니다.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  }

  async completeSignIn(code: string, state: string): Promise<GoogleAccountView> {
    if (!state || !this.pendingStates.delete(state)) {
      throw new GoogleAuthError('로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.', 400);
    }

    const tokens = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
    if (!tokens.refresh_token) {
      throw new GoogleAuthError(
        'Google이 갱신 토큰을 주지 않았습니다. 계정 연결을 해제한 뒤 다시 로그인해 주세요.',
        502
      );
    }

    const email = await this.readEmail(tokens.access_token);
    this.account = {
      email,
      refreshToken: seal(tokens.refresh_token),
      connectedAt: new Date().toISOString(),
    };
    this.cachedToken = tokens.access_token;
    this.cachedExpiresAt = Date.now() + Math.max((tokens.expires_in ?? 3600) - 120, 60) * 1000;
    await this.repo.set(ACCOUNT_KEY, JSON.stringify(this.account));
    return this.view();
  }

  async signOut(): Promise<void> {
    this.account = null;
    this.cachedToken = '';
    this.cachedExpiresAt = 0;
    await this.repo.set(ACCOUNT_KEY, '');
  }

  /**
   * 시트를 읽을 토큰. 서비스 계정이 설정돼 있으면 그쪽이 먼저입니다 —
   * 만료도 재로그인도 없어서 운영 중에 조용히 끊길 일이 없습니다.
   */
  async accessToken(): Promise<string> {
    const fromServiceAccount = await serviceAccountToken().catch(() => '');
    if (fromServiceAccount) return fromServiceAccount;

    if (!this.account) return '';
    if (this.cachedToken && Date.now() < this.cachedExpiresAt) return this.cachedToken;
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const tokens = await this.token({
          grant_type: 'refresh_token',
          refresh_token: unseal(this.account!.refreshToken),
        });
        this.cachedToken = tokens.access_token;
        this.cachedExpiresAt = Date.now() + Math.max((tokens.expires_in ?? 3600) - 120, 60) * 1000;
        return this.cachedToken;
      } catch (err) {
        // 취소되었거나 만료된 연결은 붙들고 있어 봐야 매번 실패할 뿐입니다.
        if (err instanceof GoogleAuthError && err.code === 'invalid_grant') await this.signOut();
        throw err;
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  /* ---------------------------------------------------------------- */

  private async token(body: Record<string, string>) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        ...body,
      }).toString(),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !payload.access_token) {
      const code = payload.error || '';
      throw new GoogleAuthError(
        code === 'invalid_grant'
          ? '저장된 Google 로그인이 만료되었거나 취소되었습니다. 다시 로그인해 주세요.'
          : /redirect_uri/i.test(payload.error_description || '')
            ? '이 주소가 Google 앱에 등록된 리디렉션 URI와 다릅니다. 화면에 표시된 주소를 그대로 등록해 주세요.'
            : payload.error_description || code || 'Google 로그인에 실패했습니다.',
        res.status,
        code
      );
    }
    return payload as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  private async readEmail(accessToken: string): Promise<string> {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const user = (await res.json()) as { email?: string };
    return (user.email || '').trim();
  }
}

/* ------------------------------------------------------------------ */
/* 갱신 토큰 암호화 — microsoft-account.ts 와 같은 이유, 같은 방식        */
/* ------------------------------------------------------------------ */

const PREFIX = 'enc.v1:';

function key(): Buffer | null {
  const secret = config.admin.sessionSecret;
  return secret ? crypto.createHash('sha256').update(`google-refresh:${secret}`).digest() : null;
}

function seal(value: string): string {
  const secret = key();
  if (!secret) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${sealed.toString('base64url')}`;
}

function unseal(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const secret = key();
  if (!secret) throw new GoogleAuthError('저장된 Google 로그인을 복호화할 수 없습니다.', 400, 'invalid_grant');

  const [iv, tag, payload] = value.slice(PREFIX.length).split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(iv!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(payload!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new GoogleAuthError('저장된 Google 로그인을 복호화하지 못했습니다. 다시 로그인해 주세요.', 400, 'invalid_grant');
  }
}
