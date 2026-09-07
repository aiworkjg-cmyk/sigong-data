import crypto from 'crypto';
import fs from 'fs';
import { config } from './config';

/**
 * 서비스 계정으로 구글 API 토큰을 받습니다.
 *
 * OAuth 대신 이것을 권하는 이유가 있습니다. OAuth 로 가려면 동의 화면을 만들어야
 * 하는데, 개인 Gmail 계정에는 "내부(Internal)" 선택지가 없어 "외부"로 만들 수밖에
 * 없고, 외부 앱을 테스트 모드로 두면 **갱신 토큰이 7일마다 만료**됩니다. 즉 매주
 * 다시 로그인해야 합니다. 서비스 계정에는 동의 화면도, 만료도, 검증 절차도
 * 없습니다.
 *
 * 대신 시트마다 그 계정 주소로 "공유"를 한 번 해야 합니다. 조직이 "링크가 있는
 * 모든 사용자" 공유를 막아 두었더라도 특정 주소로의 공유는 대개 허용되므로,
 * 실무에서는 이쪽이 유일하게 끝까지 동작하는 경로이기도 합니다.
 *
 * 서명은 Node 의 crypto 로 직접 합니다 — RS256 JWT 하나를 만들려고 라이브러리를
 * 들일 이유가 없고, 이 파일이 그 전부입니다.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export class ServiceAccountError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'ServiceAccountError';
  }
}

const base64url = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

/**
 * 설정된 서비스 계정 키. JSON 본문이든 파일 경로든 받습니다.
 *
 * 키 파일을 통째로 환경변수에 넣는 것이 어색해 보일 수 있지만, App Service 같은
 * 곳에서는 파일을 둘 자리가 마땅치 않아 이 형태가 가장 다루기 쉽습니다.
 */
export function loadServiceAccount(): ServiceAccountKey | null {
  const raw = config.google.serviceAccount;
  if (!raw) return null;

  let text = raw;
  // 경로처럼 보이면 파일에서 읽습니다.
  if (!raw.trimStart().startsWith('{')) {
    try {
      text = fs.readFileSync(raw, 'utf-8');
    } catch {
      throw new ServiceAccountError(
        `서비스 계정 키 파일을 읽지 못했습니다: ${raw}`,
        500
      );
    }
  }

  try {
    const parsed = JSON.parse(text) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('client_email / private_key 없음');
    }
    return {
      client_email: parsed.client_email,
      // .env 한 줄에 넣으면 줄바꿈이 \n 문자열로 들어옵니다.
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
    };
  } catch (err) {
    throw new ServiceAccountError(
      'GOOGLE_SERVICE_ACCOUNT_JSON 이 올바른 서비스 계정 키가 아닙니다. ' +
        '콘솔에서 내려받은 JSON 파일 내용을 그대로 넣어 주세요.',
      500
    );
  }
}

let cachedToken = '';
let cachedExpiresAt = 0;
let inFlight: Promise<string> | null = null;

/** 서비스 계정 액세스 토큰. 설정이 없으면 빈 문자열. */
export async function serviceAccountToken(): Promise<string> {
  const key = loadServiceAccount();
  if (!key) return '';
  if (cachedToken && Date.now() < cachedExpiresAt) return cachedToken;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claim = base64url(
        JSON.stringify({
          iss: key.client_email,
          scope: SCOPE,
          aud: TOKEN_URL,
          iat: now,
          exp: now + 3600,
        })
      );

      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${header}.${claim}`);
      const signature = base64url(signer.sign(key.private_key));
      const assertion = `${header}.${claim}.${signature}`;

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });

      const payload = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!res.ok || !payload.access_token) {
        throw new ServiceAccountError(
          payload.error_description || payload.error || '서비스 계정 인증에 실패했습니다.',
          502
        );
      }

      cachedToken = payload.access_token;
      cachedExpiresAt = Date.now() + Math.max((payload.expires_in ?? 3600) - 120, 60) * 1000;
      return cachedToken;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 화면에 보여 줄 서비스 계정 주소 — 시트를 이 주소로 공유해야 합니다. */
export function serviceAccountEmail(): string {
  try {
    return loadServiceAccount()?.client_email ?? '';
  } catch {
    return '';
  }
}
