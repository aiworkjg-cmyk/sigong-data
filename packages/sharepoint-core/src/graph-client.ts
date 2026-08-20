import fs from 'fs';
import type { DriveItem, SharePointCredentials } from './types';

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

export class GraphClient {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly credentials: SharePointCredentials) {}

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
      `${this.driveBase}/root:/${encodeGraphPath(remotePath)}:/content`,
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
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
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
    const url = folderPath
      ? `${this.driveBase}/root:/${encodeGraphPath(folderPath)}:/children`
      : `${this.driveBase}/root/children`;

    const res = await fetchWithRetry(url, { headers: await this.authHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw await toError(res, `폴더 조회 실패 (${folderPath})`);

    const data = (await res.json()) as { value: DriveItem[] };
    return data.value || [];
  }
}
