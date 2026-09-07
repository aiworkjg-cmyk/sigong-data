import crypto from 'crypto';
import { DelegatedAuth, DelegatedAuthError, GraphClient } from '@jg/sharepoint-core';
import type { DelegatedTokens, SharePointCredentials } from '@jg/sharepoint-core';
import { config } from './config';
import type { SettingsRepository } from './repositories';
import type { MicrosoftAccountView } from '../src/types';

const ACCOUNT_KEY = 'microsoftDelegatedAccount';

/** An unfinished sign-in is abandoned rather than left waiting indefinitely. */
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 20;

interface StoredAccount {
  upn: string;
  displayName: string;
  /** Encrypted at rest — see seal()/unseal(). */
  refreshToken: string;
  connectedAt: string;
  scope: string;
}

/**
 * The Microsoft work account the 마스터관리자 signed in with, remembered.
 *
 * Why this exists at all: resolving "팀 이름 + 채널 이름" to a real SharePoint
 * drive needs Teams read access, and as an *application* that access can only
 * be granted by a tenant administrator. Signing the admin in as themselves asks
 * for the delegated equivalent instead, which an ordinary work account can
 * normally consent to — and it scopes the lookup to the teams that person
 * actually belongs to, which is what they meant anyway.
 *
 * The refresh token is what makes it stick. After one sign-in, changing the
 * destination costs a team name and a channel name; no second sign-in.
 */
export class MicrosoftAccountService {
  private account: StoredAccount | null = null;
  private cachedAccessToken = '';
  private cachedExpiresAt = 0;
  /** In-memory by design: a half-finished sign-in should not survive a restart. */
  private pendingStates = new Map<string, number>();
  /** Collapses concurrent refreshes into one token request. */
  private refreshInFlight: Promise<string> | null = null;

  constructor(private readonly repo: SettingsRepository) {}

  async load(): Promise<void> {
    const raw = await this.repo.get(ACCOUNT_KEY);
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as StoredAccount;
      // An account row with no usable refresh token cannot produce a token, so
      // treating it as signed-out is more honest than showing a connected
      // account that fails on first use.
      this.account = value?.refreshToken && value?.upn ? value : null;
    } catch {
      this.account = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 설정값                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * The redirect URI, which must match the Azure app registration exactly.
   *
   * Derived from APP_URL so a deployment does not need a second address
   * setting, with an explicit override for the case where the app sits behind a
   * different public hostname than it believes it has.
   */
  get redirectUri(): string {
    const base =
      config.microsoft.redirectUri ||
      `${config.mail.appUrl || `http://localhost:${config.port}`}/api/admin/settings/microsoft/callback`;
    return base;
  }

  private get auth(): DelegatedAuth {
    return new DelegatedAuth({
      tenantId: config.sharePoint.tenantId,
      clientId: config.sharePoint.clientId,
      clientSecret: config.sharePoint.clientSecret,
      redirectUri: this.redirectUri,
    });
  }

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  /** Everything the 설정 화면 needs to render this section, minus the secret. */
  view(): MicrosoftAccountView {
    return {
      configured: this.isConfigured(),
      redirectUri: this.redirectUri,
      account: this.account
        ? {
            upn: this.account.upn,
            displayName: this.account.displayName,
            connectedAt: this.account.connectedAt,
          }
        : null,
      adminConsentUrl: this.isConfigured() ? this.auth.adminConsentUrl() : '',
      // Straight to the blade where the redirect URI is registered. Finding it
      // by hand is six clicks deep, and AADSTS500113 — no reply address at all —
      // is the single most likely first-run failure, so the fix should be one
      // click from the error rather than a paragraph of navigation directions.
      azureAuthBladeUrl: config.sharePoint.clientId
        ? 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Authentication/appId/' +
          encodeURIComponent(config.sharePoint.clientId)
        : '',
    };
  }

  signedInUpn(): string {
    return this.account?.upn || '';
  }

  /* ---------------------------------------------------------------- */
  /* 로그인                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Starts a sign-in and returns where to send the browser.
   *
   * The state value is generated here and checked on the way back, which is
   * what stops an attacker-supplied authorization code from being redeemed into
   * this application's saved account.
   */
  beginSignIn(): { url: string; state: string } {
    if (!this.isConfigured()) {
      throw new DelegatedAuthError(
        'Azure 앱 설정(SHAREPOINT_TENANT_ID / CLIENT_ID / CLIENT_SECRET)이 없어 Microsoft 로그인을 시작할 수 없습니다.',
        400
      );
    }
    this.prunePendingStates();
    if (this.pendingStates.size >= MAX_PENDING_STATES) {
      throw new DelegatedAuthError('진행 중인 로그인이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    }

    const state = crypto.randomBytes(24).toString('base64url');
    this.pendingStates.set(state, Date.now());
    return { url: this.auth.authorizeUrl(state), state };
  }

  private prunePendingStates(): void {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [state, startedAt] of this.pendingStates) {
      if (startedAt < cutoff) this.pendingStates.delete(state);
    }
  }

  /** Redeems the authorization code and remembers the account. */
  async completeSignIn(code: string, state: string): Promise<MicrosoftAccountView> {
    this.prunePendingStates();
    // Single-use: deleting before the exchange means a replayed callback cannot
    // reach the token endpoint a second time even if the first one is still
    // in flight.
    if (!state || !this.pendingStates.delete(state)) {
      throw new DelegatedAuthError(
        '로그인 요청이 만료되었거나 올바르지 않습니다. 설정 화면에서 다시 로그인해 주세요.',
        400
      );
    }

    const tokens = await this.auth.exchangeCode(code);
    if (!tokens.refreshToken) {
      throw new DelegatedAuthError(
        'Microsoft가 갱신 토큰을 발급하지 않았습니다. Azure 앱 권한에 offline_access가 포함되어 있는지 확인해 주세요.',
        502
      );
    }
    const identity = await this.auth.me(tokens.accessToken);
    if (!identity.upn) {
      throw new DelegatedAuthError('로그인한 계정의 주소를 확인하지 못했습니다.', 502);
    }

    this.account = {
      upn: identity.upn,
      displayName: identity.displayName || identity.upn,
      refreshToken: seal(tokens.refreshToken),
      connectedAt: new Date().toISOString(),
      scope: tokens.scope,
    };
    this.cacheToken(tokens);
    await this.repo.set(ACCOUNT_KEY, JSON.stringify(this.account));
    return this.view();
  }

  async signOut(): Promise<void> {
    this.account = null;
    this.cachedAccessToken = '';
    this.cachedExpiresAt = 0;
    await this.repo.set(ACCOUNT_KEY, '');
  }

  /* ---------------------------------------------------------------- */
  /* 토큰                                                               */
  /* ---------------------------------------------------------------- */

  private cacheToken(tokens: DelegatedTokens): void {
    this.cachedAccessToken = tokens.accessToken;
    this.cachedExpiresAt = tokens.expiresAt;
  }

  /**
   * A valid delegated access token, refreshing when the cached one is spent.
   *
   * A refresh that fails with invalid_grant means the saved sign-in is gone for
   * good — revoked, expired, or password-changed — so the stored account is
   * cleared rather than left on screen claiming to be connected.
   */
  async accessToken(): Promise<string> {
    if (!this.account) {
      throw new DelegatedAuthError('Microsoft 업무 계정으로 로그인되어 있지 않습니다.', 401);
    }
    if (this.cachedAccessToken && Date.now() < this.cachedExpiresAt) {
      return this.cachedAccessToken;
    }
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const current = this.account!;
      try {
        const tokens = await this.auth.refresh(unseal(current.refreshToken));
        this.cacheToken(tokens);
        if (tokens.refreshToken) {
          this.account = { ...current, refreshToken: seal(tokens.refreshToken) };
          await this.repo.set(ACCOUNT_KEY, JSON.stringify(this.account));
        }
        return tokens.accessToken;
      } catch (err) {
        if (err instanceof DelegatedAuthError && err.code === 'invalid_grant') {
          await this.signOut();
        }
        throw err;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  /**
   * A Graph client acting as the signed-in administrator, or null when nobody
   * is signed in — the caller then falls back to app-only credentials.
   */
  graphClient(credentials: SharePointCredentials): GraphClient | null {
    if (!this.account) return null;
    return new GraphClient(credentials, () => this.accessToken());
  }
}

/* ------------------------------------------------------------------ */
/* Refresh-token encryption at rest                                    */
/* ------------------------------------------------------------------ */

/**
 * The refresh token is a long-lived credential for a real person's work
 * account, and the default record store is a JSON file on disk. Encrypting it
 * under the admin session secret means a copied data directory is not, by
 * itself, a working Microsoft credential.
 *
 * With no session secret configured (local development only — the value is
 * required in production) the token is stored as-is rather than under a key
 * everyone already knows, which would only look like protection.
 */
const PREFIX = 'enc.v1:';

function key(): Buffer | null {
  const secret = config.admin.sessionSecret;
  if (!secret) return null;
  return crypto.createHash('sha256').update(`microsoft-refresh:${secret}`).digest();
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
  if (!secret) {
    throw new DelegatedAuthError(
      'ADMIN_SESSION_SECRET 이 바뀌어 저장된 Microsoft 로그인을 복호화할 수 없습니다. 다시 로그인해 주세요.',
      400,
      'invalid_grant'
    );
  }

  const [iv, tag, payload] = value.slice(PREFIX.length).split('.');
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      secret,
      Buffer.from(iv, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A changed secret fails authentication here. Reported as invalid_grant so
    // the caller clears the account and asks for a fresh sign-in.
    throw new DelegatedAuthError(
      '저장된 Microsoft 로그인을 복호화하지 못했습니다. 다시 로그인해 주세요.',
      400,
      'invalid_grant'
    );
  }
}
