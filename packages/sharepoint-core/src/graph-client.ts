import fs from 'fs';
import type { DriveItem, ResolvedTeamsStorageTarget, SharePointCredentials } from './types';

// Graph path-segment safe encoding: encodeURIComponent() alone would also
// escape '/', which breaks colon-style path addressing (root:/A/B/C:/content).
// Each segment must be encoded individually and rejoined with literal slashes.
export function encodeGraphPath(itemPath: string): string {
  return itemPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// Simple PUT upload only supports files up to 4MB; anything larger must use
// a resumable upload session in byte-range chunks.
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
// Must be a multiple of 320 KiB (327,680 bytes) per Graph API requirements.
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
// Graph throttles with 429 and fails transiently with 5xx; both are retryable.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Issues a request, retrying throttled and transient failures with exponential
 * backoff. Honors Retry-After when Graph supplies it.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network-level failure — retry on the same budget as a 5xx.
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(2 ** attempt * 1000);
    return fetchWithRetry(url, init, attempt + 1);
  }

  if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
    await sleep(delay);
    return fetchWithRetry(url, init, attempt + 1);
  }

  return res;
}

async function toError(res: Response, context: string): Promise<GraphApiError> {
  const body = await res.text().catch(() => '');
  return new GraphApiError(`${context}: ${res.status} ${body}`, res.status, body);
}

/**
 * Supplies a delegated access token on behalf of a signed-in administrator.
 * Returning a fresh token each call is fine — the implementation is expected to
 * cache and refresh; GraphClient does no caching of its own for this path.
 */
export type AccessTokenProvider = () => Promise<string>;

/** "contoso.sharepoint.com,<site guid>,<web guid>" — Graph's composite site id. */
const COMPOSITE_SITE_ID = /^[^,\s]+,[0-9a-fA-F-]{36},[0-9a-fA-F-]{36}$/;

/**
 * Builds the composite site id from a driveItem's sharepointIds.
 *
 * The hostname is not part of sharepointIds, so it is taken from whichever URL
 * is available — the item's own siteUrl first, then any webUrl on hand.
 */
function composeSiteId(item: DriveItem | null, fallback: DriveItem): string {
  const ids = item?.sharepointIds;
  if (!ids?.siteId || !ids?.webId) return '';

  let hostname = '';
  try {
    hostname = new URL(ids.siteUrl || item?.webUrl || fallback.webUrl || '').hostname;
  } catch {
    return '';
  }
  return hostname ? `${hostname},${ids.siteId},${ids.webId}` : '';
}

export class GraphClient {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * `accessTokenProvider` switches the client from app-only to delegated auth.
   * That choice also changes *which* Graph routes are correct — a delegated
   * token has an implicit user, so team membership is read from /me rather than
   * from an arbitrary /users/{upn} — which is why the flag is remembered here
   * rather than passed in per call.
   */
  constructor(
    private readonly credentials: SharePointCredentials,
    private readonly accessTokenProvider?: AccessTokenProvider
  ) {}

  /** True when this client acts as a signed-in person rather than as the app. */
  get isDelegated(): boolean {
    return Boolean(this.accessTokenProvider);
  }

  /**
   * Resolves the Graph drive base URL. Prefers an explicit drive id; if only a
   * site id is configured (the common case for a Teams channel's SharePoint
   * site), addresses that site's default document library directly instead of
   * guessing a drive id.
   */
  private get driveBase(): string {
    const { driveId, siteId } = this.credentials;
    return driveId
      ? `https://graph.microsoft.com/v1.0/drives/${driveId}`
      : `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessTokenProvider) return this.accessTokenProvider();

    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }

    const { tenantId, clientId, clientSecret } = this.credentials;
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const res = await fetchWithRetry(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      }
    );

    if (!res.ok) throw await toError(res, 'Microsoft Graph 토큰 발급 실패');

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    // Refresh a minute early so a token never expires mid-request.
    this.tokenExpiresAt = Date.now() + Math.max(data.expires_in - 60, 60) * 1000;
    return this.cachedToken;
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getAccessToken()}`, ...extra };
  }

  /** Reads every page of a Graph collection and rejects non-Graph continuation URLs. */
  private async graphCollection<T>(initialUrl: string, context: string): Promise<T[]> {
    let url: string | null = initialUrl;
    const values: T[] = [];

    while (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'graph.microsoft.com') {
        throw new GraphApiError('Graph가 반환한 다음 페이지 주소가 올바르지 않습니다.', 0, '');
      }
      const res = await fetchWithRetry(url, { headers: await this.authHeaders() });
      if (!res.ok) throw await toError(res, context);
      const data = (await res.json()) as { value?: T[]; '@odata.nextLink'?: string };
      values.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
    return values;
  }

  /**
   * Teams the account belongs to.
   *
   * Exposed on its own so the 설정 화면 can offer the real list to pick from.
   * Typing a team name blind is the step that produced most "연결 실패" reports:
   * the name shown in the Teams sidebar is often not the team's stored
   * displayName, and nothing on screen said so.
   */
  async listJoinedTeams(accountEmail: string): Promise<Array<{ id: string; displayName: string }>> {
    return this.graphCollection<{ id: string; displayName: string }>(
      this.isDelegated
        ? 'https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id,displayName'
        : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(accountEmail.trim())}/joinedTeams?$select=id,displayName`,
      `Microsoft 계정의 Teams 목록 조회 실패 (${accountEmail})`
    );
  }

  /** Channels inside one team, for the same reason listJoinedTeams exists. */
  async listTeamChannels(
    teamId: string
  ): Promise<Array<{ id: string; displayName: string; membershipType?: string }>> {
    return this.graphCollection<{ id: string; displayName: string; membershipType?: string }>(
      `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,membershipType`,
      'Teams 채널 목록 조회 실패'
    );
  }

  /**
   * The composite Graph site id ("host,siteGuid,webGuid") behind a channel.
   *
   * Three sources are tried because the obvious one does not exist. A Graph
   * **drive** has no `sharepointIds` property at all — that field lives on
   * `driveItem`, `list` and `site` — so asking `/drives/{id}?$select=sharepointIds`
   * returns a drive with the field simply absent, and the id could never be
   * assembled. That is the "사이트 ID를 구성하지 못했습니다" failure.
   *
   * Order is by directness, not by preference:
   *   1. the team's own group site, whose `id` is already the composite value;
   *   2. the drive's root *item*, which really does carry sharepointIds;
   *   3. the channel folder item itself, for the same reason.
   *
   * Each is allowed to fail — a tenant may withhold one of these reads while
   * permitting another — so a refusal moves on rather than ending the connect.
   */
  private async resolveSiteId(
    teamId: string,
    driveId: string,
    folder: DriveItem
  ): Promise<{ siteId: string; attempts: string[] }> {
    const attempts: string[] = [];

    const read = async (url: string, label: string): Promise<any | null> => {
      try {
        const res = await fetchWithRetry(url, { headers: await this.authHeaders() });
        if (!res.ok) {
          attempts.push(`${label}: HTTP ${res.status}`);
          return null;
        }
        return await res.json();
      } catch (err: any) {
        attempts.push(`${label}: ${err?.message || err}`);
        return null;
      }
    };

    // A Team's id is its Microsoft 365 group id, and a group's root site
    // answers with the composite id already formed — no assembly needed.
    const site = await read(
      `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(teamId)}/sites/root?$select=id,webUrl`,
      '팀 사이트 조회'
    );
    const direct = String(site?.id || '').trim();
    if (COMPOSITE_SITE_ID.test(direct)) return { siteId: direct, attempts };
    if (site) attempts.push(`팀 사이트 조회: 사이트 ID 형식이 아님 (${direct || '값 없음'})`);

    const drive = encodeURIComponent(driveId);
    const itemSources: Array<[string, string]> = [
      [`https://graph.microsoft.com/v1.0/drives/${drive}/root?$select=id,webUrl,sharepointIds`,
        '드라이브 루트 항목 조회'],
    ];
    if (folder.id) {
      itemSources.push([
        `https://graph.microsoft.com/v1.0/drives/${drive}/items/${encodeURIComponent(folder.id)}?$select=id,webUrl,sharepointIds`,
        '채널 폴더 항목 조회',
      ]);
    }

    for (const [url, label] of itemSources) {
      const item = (await read(url, label)) as DriveItem | null;
      const assembled = composeSiteId(item, folder);
      if (assembled) return { siteId: assembled, attempts };
      if (item) attempts.push(`${label}: sharepointIds 없음`);
    }

    return { siteId: '', attempts };
  }
  /**
   * Finds a Teams channel from an account UPN and display names, then resolves
   * the channel's real SharePoint drive and folder. No Microsoft password is
   * accepted or stored: the server app authenticates with its own credentials.
   */
  async resolveTeamsStorageTarget(input: {
    accountEmail: string;
    teamName: string;
    channelName: string;
  }): Promise<ResolvedTeamsStorageTarget> {
    const accountEmail = input.accountEmail.trim();
    const teamName = input.teamName.trim();
    const channelName = input.channelName.trim();
    const sameName = (left?: string, right?: string) =>
      String(left || '').normalize('NFKC').toLocaleLowerCase() ===
      String(right || '').normalize('NFKC').toLocaleLowerCase();

    const teams = await this.listJoinedTeams(accountEmail);
    const matchingTeams = teams.filter((team) => sameName(team.displayName, teamName));
    if (matchingTeams.length === 0) {
      // Naming the alternatives turns a dead end into a correction: the answer
      // is almost always one of these strings, spelled slightly differently.
      throw new GraphApiError(
        `'${accountEmail}' 계정이 속한 팀에서 '${teamName}'을(를) 찾지 못했습니다.` +
          (teams.length
            ? ` 이 계정이 속한 팀: ${teams.map((team) => team.displayName).join(', ')}`
            : ' 이 계정은 어떤 팀에도 속해 있지 않습니다.'),
        404,
        ''
      );
    }
    if (matchingTeams.length > 1) {
      throw new GraphApiError(
        `'${teamName}' 이름의 팀이 ${matchingTeams.length}개입니다. 팀 이름을 고유하게 변경한 뒤 다시 연결해 주세요.`,
        409,
        ''
      );
    }

    const team = matchingTeams[0];
    const channels = await this.listTeamChannels(team.id);
    const matchingChannels = channels.filter((channel) => sameName(channel.displayName, channelName));
    if (matchingChannels.length === 0) {
      throw new GraphApiError(
        `'${team.displayName}' 팀에서 '${channelName}' 채널을 찾지 못했습니다.` +
          (channels.length
            ? ` 이 팀의 채널: ${channels.map((channel) => channel.displayName).join(', ')}`
            : ''),
        404,
        ''
      );
    }
    if (matchingChannels.length > 1) {
      throw new GraphApiError(
        `'${channelName}' 이름의 채널이 ${matchingChannels.length}개입니다. 채널 이름을 고유하게 변경한 뒤 다시 연결해 주세요.`,
        409,
        ''
      );
    }

    const channel = matchingChannels[0];
    const folderRes = await fetchWithRetry(
      `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(channel.id)}/filesFolder`,
      { headers: await this.authHeaders() }
    );
    if (!folderRes.ok) throw await toError(folderRes, `채널 파일 저장 위치 조회 실패 (${channelName})`);
    const folder = (await folderRes.json()) as DriveItem;
    const driveId = String(folder.parentReference?.driveId || '').trim();
    if (!driveId) {
      throw new GraphApiError('채널 응답에서 SharePoint 드라이브 ID를 찾지 못했습니다.', 502, '');
    }

    const { siteId, attempts } = await this.resolveSiteId(team.id, driveId, folder);
    if (!siteId) {
      // Listing what was tried and how each answered is the difference between
      // a dead end and a fixable one: a row of 403s means a missing permission,
      // while a successful read with no ids means an unexpected drive shape.
      throw new GraphApiError(
        `'${channel.displayName}' 채널의 SharePoint 사이트 ID를 확인하지 못했습니다.` +
          (attempts.length ? ` 시도한 경로 — ${attempts.join(' / ')}` : ''),
        502,
        ''
      );
    }

    return {
      accountEmail,
      teamName: team.displayName,
      channelName: channel.displayName,
      teamId: team.id,
      channelId: channel.id,
      siteId,
      driveId,
      channelFolder: folder.root ? '' : String(folder.name || channel.displayName).trim(),
      webUrl: folder.webUrl,
    };
  }

  /** Verifies credentials and target reachability without writing anything. */
  async probe(): Promise<{ ok: boolean; driveName?: string; webUrl?: string; error?: string }> {
    try {
      const res = await fetchWithRetry(this.driveBase, { headers: await this.authHeaders() });
      if (!res.ok) {
        const err = await toError(res, 'SharePoint 드라이브 조회 실패');
        return { ok: false, error: err.message };
      }
      const drive = (await res.json()) as { name?: string; webUrl?: string };
      return { ok: true, driveName: drive.name, webUrl: drive.webUrl };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Creates every missing folder along folderPath. Idempotent: an existing
   * folder is a success, not an error. Returns the deepest folder's driveItem
   * so callers can surface its webUrl.
   */
  async ensureFolderPath(folderPath: string): Promise<DriveItem | null> {
    const segments = folderPath.split('/').filter(Boolean);
    let currentPath = '';
    let lastItem: DriveItem | null = null;

    for (const segment of segments) {
      const childrenUrl = currentPath
        ? `${this.driveBase}/root:/${encodeGraphPath(currentPath)}:/children`
        : `${this.driveBase}/root/children`;

      const res = await fetchWithRetry(childrenUrl, {
        method: 'POST',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: segment,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }),
      });

      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (res.ok) {
        lastItem = (await res.json()) as DriveItem;
      } else if (res.status === 409) {
        // Already there — fetch it so the webUrl is still available.
        const existing = await fetchWithRetry(
          `${this.driveBase}/root:/${encodeGraphPath(currentPath)}`,
          { headers: await this.authHeaders() }
        );
        lastItem = existing.ok ? ((await existing.json()) as DriveItem) : null;
      } else {
        throw await toError(res, `SharePoint 폴더 생성 실패 (${segment})`);
      }
    }

    return lastItem;
  }

  /** Uploads in-memory content (metadata sidecars and other small files). */
  async uploadContent(
    remotePath: string,
    content: Buffer | string,
    contentType: string
  ): Promise<DriveItem> {
    const res = await fetchWithRetry(
      `${this.driveBase}/root:/${encodeGraphPath(remotePath)}:/content?@microsoft.graph.conflictBehavior=fail`,
      {
        method: 'PUT',
        headers: await this.authHeaders({ 'Content-Type': contentType }),
        body: content as any,
      }
    );

    if (!res.ok) throw await toError(res, `파일 업로드 실패 (${remotePath})`);
    return (await res.json()) as DriveItem;
  }

  /**
   * Uploads a staged file from disk, choosing simple or resumable upload by
   * size. Chunks are read straight from the file handle so a 100MB video never
   * has to be held in memory in full.
   */
  async uploadFile(remotePath: string, filePath: string): Promise<DriveItem> {
    const { size } = fs.statSync(filePath);

    if (size < SIMPLE_UPLOAD_MAX_BYTES) {
      return this.uploadContent(remotePath, fs.readFileSync(filePath), 'application/octet-stream');
    }

    const sessionRes = await fetchWithRetry(
      `${this.driveBase}/root:/${encodeGraphPath(remotePath)}:/createUploadSession`,
      {
        method: 'POST',
        headers: await this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
      }
    );

    if (!sessionRes.ok) throw await toError(sessionRes, `업로드 세션 생성 실패 (${remotePath})`);

    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };
    const handle = await fs.promises.open(filePath, 'r');

    try {
      const chunk = Buffer.allocUnsafe(UPLOAD_CHUNK_SIZE);
      let completed: DriveItem | null = null;

      for (let start = 0; start < size; start += UPLOAD_CHUNK_SIZE) {
        const length = Math.min(UPLOAD_CHUNK_SIZE, size - start);
        const { bytesRead } = await handle.read(chunk, 0, length, start);
        const end = start + bytesRead - 1;

        // The upload session URL is pre-authenticated; sending an Authorization
        // header on chunk requests makes Graph reject them.
        const chunkRes = await fetchWithRetry(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(bytesRead),
            'Content-Range': `bytes ${start}-${end}/${size}`,
          },
          body: chunk.subarray(0, bytesRead),
        });

        if (!chunkRes.ok) {
          throw await toError(chunkRes, `대용량 파일 업로드 실패 (${remotePath}, byte ${start})`);
        }

        // Graph answers 202 for accepted chunks and 200/201 on the final one.
        if (chunkRes.status === 200 || chunkRes.status === 201) {
          completed = (await chunkRes.json()) as DriveItem;
        }
      }

      if (!completed) {
        throw new GraphApiError(`업로드가 완료되지 않았습니다 (${remotePath})`, 0, '');
      }
      return completed;
    } finally {
      await handle.close();
    }
  }

  /** Renames one item in place, preserving its content, metadata and versions. */
  async renameItem(itemId: string, name: string, eTag?: string): Promise<DriveItem> {
    const res = await fetchWithRetry(
      `${this.driveBase}/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        headers: await this.authHeaders({
          'Content-Type': 'application/json',
          ...(eTag ? { 'If-Match': eTag } : {}),
        }),
        body: JSON.stringify({ name }),
      }
    );

    if (!res.ok) throw await toError(res, `파일 이름 변경 실패 (${name})`);
    return (await res.json()) as DriveItem;
  }

  /** Gets the current item state; delta responses can omit the parent path. */
  async getItem(itemId: string): Promise<DriveItem | null> {
    const res = await fetchWithRetry(
      `${this.driveBase}/items/${encodeURIComponent(itemId)}`,
      { headers: await this.authHeaders() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res, `파일 정보 조회 실패 (${itemId})`);
    return (await res.json()) as DriveItem;
  }

  /**
   * Reads only changes since a prior drive delta cursor. With no cursor, Graph
   * returns an empty page and the latest token, establishing a safe baseline
   * without treating every historical file as a new manual upload.
   */
  async driveDelta(cursor?: string): Promise<{ items: DriveItem[]; cursor: string }> {
    let url: string | null = cursor || `${this.driveBase}/root/delta?token=latest`;
    const items: DriveItem[] = [];
    let deltaLink = '';

    while (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'graph.microsoft.com') {
        throw new GraphApiError('저장된 Graph 변경 추적 주소가 올바르지 않습니다.', 0, '');
      }

      const res = await fetchWithRetry(url, {
        headers: await this.authHeaders({ deltaExcludeParent: 'true' }),
      });
      if (!res.ok) throw await toError(res, 'SharePoint 변경 내역 조회 실패');

      const data = (await res.json()) as {
        value?: DriveItem[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      items.push(...(data.value || []));
      deltaLink = data['@odata.deltaLink'] || deltaLink;
      url = data['@odata.nextLink'] || null;
    }

    if (!deltaLink) {
      throw new GraphApiError('Graph 변경 추적 토큰을 받지 못했습니다.', 0, '');
    }
    return { items, cursor: deltaLink };
  }

  /** SharePoint supports an ISO timestamp as the initial delta token. */
  deltaCursorFrom(at: Date): string {
    return `${this.driveBase}/root/delta?token=${encodeURIComponent(at.toISOString())}`;
  }

  /**
   * Opens a stored file for reading. Graph answers the content endpoint with a
   * redirect to a short-lived pre-authenticated URL, which fetch follows.
   */
  async downloadFile(remotePath: string): Promise<Response> {
    const res = await fetchWithRetry(
      `${this.driveBase}/root:/${encodeGraphPath(remotePath)}:/content`,
      { headers: await this.authHeaders(), redirect: 'follow' }
    );

    if (!res.ok) throw await toError(res, `파일 다운로드 실패 (${remotePath})`);
    return res;
  }

  /** Lists a folder's children; used by the admin folder browser. */
  async listChildren(folderPath: string): Promise<DriveItem[]> {
    let url: string | null = folderPath
      ? `${this.driveBase}/root:/${encodeGraphPath(folderPath)}:/children`
      : `${this.driveBase}/root/children`;
    const items: DriveItem[] = [];

    // Graph paginates large folders. Reading only the first page can make a
    // later upload reuse an existing sequence number and replace a file.
    while (url) {
      const res = await fetchWithRetry(url, { headers: await this.authHeaders() });
      if (res.status === 404) return [];
      if (!res.ok) throw await toError(res, `폴더 조회 실패 (${folderPath})`);

      const data = (await res.json()) as {
        value?: DriveItem[];
        '@odata.nextLink'?: string;
      };
      items.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }

    return items;
  }
}
