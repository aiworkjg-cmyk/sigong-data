/**
 * Delegated (사용자 위임) Microsoft sign-in.
 *
 * The app already authenticates as itself with a client secret, and for writing
 * files that is the right shape: uploads happen in a background worker long
 * after the submitter has closed the page, so there is no user session to
 * borrow. But *finding* the destination is a different problem. App-only access
 * to `/users/{upn}/joinedTeams` needs Team.ReadBasic.All as an **application**
 * permission, which no one but a tenant administrator can grant — and that is
 * exactly the wall the 설정 화면 kept hitting.
 *
 * Signing the administrator in as themselves removes the wall. The same lookup
 * against `/me/joinedTeams` needs only delegated permissions, which an ordinary
 * work account can usually consent to for itself, and it answers with the teams
 * that account actually belongs to — which is what the person filling in the
 * form meant in the first place.
 *
 * The refresh token this yields is what makes the account "remembered": once it
 * is stored, a later change of destination costs a team name and a channel name
 * and no sign-in at all.
 */

/**
 * Scopes requested at sign-in.
 *
 * offline_access is what produces the refresh token, and therefore the whole
 * "remember the account" behaviour. The two Teams scopes cover the team and
 * channel lookup; the file scopes cover reading back the channel's real drive
 * so the resolved target is verified rather than guessed.
 */
export const DELEGATED_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'User.Read',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'Files.ReadWrite.All',
  'Sites.ReadWrite.All',
] as const;

export interface DelegatedAuthOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered on the Azure app, character for character. */
  redirectUri: string;
}

export interface DelegatedTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Already shortened by a safety margin. */
  expiresAt: number;
  scope: string;
}

export interface DelegatedAccount {
  /** userPrincipalName — the address the admin signs in with. */
  upn: string;
  displayName: string;
}

export class DelegatedAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Azure's own error code, e.g. invalid_grant / consent_required. */
    public readonly code = ''
  ) {
    super(message);
    this.name = 'DelegatedAuthError';
  }
}

/**
 * Turns Azure's error payload into something a Korean-speaking admin can act
 * on. The raw body is machine-readable but says nothing about what to click.
 */
function describe(code: string, description: string): string {
  if (code === 'invalid_grant') {
    return '저장된 Microsoft 로그인이 만료되었거나 취소되었습니다. 다시 로그인해 주세요.';
  }
  if (code === 'consent_required' || code === 'interaction_required') {
    return '이 계정에 필요한 권한 동의가 아직 없습니다. 로그인 화면에서 동의를 완료해 주세요.';
  }
  if (code === 'invalid_client') {
    return 'Azure 앱의 클라이언트 ID 또는 클라이언트 암호가 올바르지 않습니다.';
  }
  if (/AADSTS50011|redirect_uri/i.test(description)) {
    return (
      '이 주소가 Azure 앱에 등록된 리디렉션 URI와 다릅니다. ' +
      'Azure 포털 > 앱 등록 > 인증 에서 아래 안내된 주소를 그대로 등록해 주세요.'
    );
  }
  return description || code || 'Microsoft 로그인에 실패했습니다.';
}

export class DelegatedAuth {
  constructor(private readonly options: DelegatedAuthOptions) {}

  /**
   * `organizations` rather than `common` when no tenant is configured: this is
   * a work-account application, and letting a personal Microsoft account reach
   * the sign-in screen only produces a confusing failure two steps later.
   */
  private get authority(): string {
    const tenant = this.options.tenantId.trim() || 'organizations';
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
  }

  isConfigured(): boolean {
    const { clientId, clientSecret, redirectUri } = this.options;
    return Boolean(clientId && clientSecret && redirectUri);
  }

  /** Where to send the administrator's browser to sign in. */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: this.options.redirectUri,
      response_mode: 'query',
      scope: DELEGATED_SCOPES.join(' '),
      state,
      // Always show the account picker. The admin connecting a Teams channel is
      // often not signed in as the account that belongs to that team, and a
      // silent sign-in as the wrong account looks like a missing-permission
      // error rather than the wrong-account error it actually is.
      prompt: 'select_account',
    });
    return `${this.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * The URL a tenant administrator opens to consent once for everybody, for
   * tenants where individual users are not allowed to consent for themselves.
   */
  adminConsentUrl(): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: DELEGATED_SCOPES.join(' '),
    });
    return `${this.authority}/v2.0/adminconsent?${params.toString()}`;
  }

  private async token(body: Record<string, string>): Promise<DelegatedTokens> {
    const res = await fetch(`${this.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        ...body,
      }).toString(),
    });

    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !payload.access_token) {
      throw new DelegatedAuthError(
        describe(payload.error || '', payload.error_description || ''),
        res.status,
        payload.error || ''
      );
    }

    return {
      accessToken: payload.access_token,
      // A refresh response may omit the refresh token, meaning "keep the one
      // you have". Returning '' here and letting the caller keep the previous
      // value is what stops a routine refresh from erasing the saved sign-in.
      refreshToken: payload.refresh_token || '',
      expiresAt: Date.now() + Math.max((payload.expires_in ?? 3600) - 120, 60) * 1000,
      scope: payload.scope || '',
    };
  }

  async exchangeCode(code: string): Promise<DelegatedTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.options.redirectUri,
      scope: DELEGATED_SCOPES.join(' '),
    });
  }

  async refresh(refreshToken: string): Promise<DelegatedTokens> {
    return this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: DELEGATED_SCOPES.join(' '),
    });
  }

  /** Reads the signed-in identity so the 설정 화면 can name the saved account. */
  async me(accessToken: string): Promise<DelegatedAccount> {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,displayName,mail',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      throw new DelegatedAuthError(
        '로그인한 Microsoft 계정 정보를 읽지 못했습니다.',
        res.status
      );
    }
    const user = (await res.json()) as {
      userPrincipalName?: string;
      displayName?: string;
      mail?: string;
    };
    return {
      upn: (user.userPrincipalName || user.mail || '').trim(),
      displayName: (user.displayName || '').trim(),
    };
  }
}
