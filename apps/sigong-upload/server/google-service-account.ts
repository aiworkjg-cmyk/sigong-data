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
 * 화면에서 등록한 키.
 *
 * 환경변수를 고칠 수 있는 사람과 이 앱을 쓰는 사람이 늘 같지는 않습니다. 관리
 * 화면에서 JSON 을 붙여넣으면 여기에 들어오고, 원본은 설정 저장소에 암호화해
 * 둡니다(GoogleAccountService). 환경변수가 있으면 그쪽이 우선입니다 — 배포로
 * 정한 값을 화면 입력이 조용히 덮어쓰면 추적할 수 없게 됩니다.
 */
let storedRaw = '';

/** 저장소에서 읽었거나 화면에서 새로 등록한 키를 적용합니다. */
export function setStoredServiceAccount(raw: string): void {
  storedRaw = (raw || '').trim();
  cachedToken = '';
  cachedExpiresAt = 0;
}

let envChecked = false;
let envUsable = '';

/**
 * 환경변수의 키 — 실제로 쓸 수 있는 형태일 때만 돌려줍니다.
 *
 * JSON 한 덩어리를 .env 한 줄이나 배포 도구의 변수에 넣다가 중괄호만 남는
 * 식으로 잘리는 일이 실제로 있습니다. 그 값이 "설정됨"으로 취급되면 화면에서
 * 키를 등록하려 할 때 "이미 환경변수가 있다"며 막혀, 어느 쪽으로도 연동할 수
 * 없는 상태가 됩니다. 읽을 수 없는 값은 없는 값으로 봅니다.
 */
function envRaw(): string {
  if (envChecked) return envUsable;
  envChecked = true;
  const raw = config.google.serviceAccount;
  if (!raw) return '';
  try {
    parseServiceAccount(raw);
    envUsable = raw;
  } catch (err) {
    console.error(
      '[google] GOOGLE_SERVICE_ACCOUNT_JSON 을 읽지 못해 무시합니다. ' +
        '관리 화면에서 키를 등록할 수 있습니다.',
      err
    );
  }
  return envUsable;
}

/** 지금 쓰는 키가 어디서 왔는지. 화면에서 해제 가능 여부를 가릅니다. */
export function serviceAccountSource(): 'env' | 'stored' | '' {
  if (envRaw()) return 'env';
  return storedRaw ? 'stored' : '';
}

/**
 * 설정된 서비스 계정 키. JSON 본문이든 파일 경로든 받습니다.
 *
 * 키 파일을 통째로 환경변수에 넣는 것이 어색해 보일 수 있지만, App Service 같은
 * 곳에서는 파일을 둘 자리가 마땅치 않아 이 형태가 가장 다루기 쉽습니다.
 */
export function loadServiceAccount(): ServiceAccountKey | null {
  const raw = envRaw() || storedRaw;
  if (!raw) return null;
  return parseServiceAccount(raw);
}

/** JSON 본문 또는 파일 경로를 키로 읽습니다. 형식이 틀리면 그 자리에서 말합니다. */
export function parseServiceAccount(raw: string): ServiceAccountKey {
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
      '올바른 서비스 계정 키가 아닙니다. Google Cloud Console 에서 내려받은 ' +
        'JSON 파일을 열어 내용 전체(" { " 부터 " } " 까지)를 그대로 붙여넣어 주세요. ' +
        'client_email 과 private_key 가 들어 있어야 합니다.',
      400
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
      const issued = await requestToken(key);
      cachedToken = issued.token;
      cachedExpiresAt = Date.now() + Math.max(issued.expiresIn - 120, 60) * 1000;
      return cachedToken;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * 키 하나로 토큰을 한 번 받아 봅니다.
 *
 * 등록 화면에서 이것을 먼저 부릅니다. 붙여넣은 키가 잘못됐다면 저장한 뒤
 * 10분 후 첫 동기화에서 실패하는 것이 아니라, 저장 버튼을 누른 그 자리에서
 * 알아야 합니다.
 */
async function requestToken(key: ServiceAccountKey): Promise<{ token: string; expiresIn: number }> {
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
    // 흔한 실패를 그대로 흘려보내지 않습니다. 구글이 주는 말만으로는
    // 무엇을 해야 하는지 알 수 없습니다.
    const reason = payload.error_description || payload.error || '';
    throw new ServiceAccountError(
      /disabled|has not been used|SERVICE_DISABLED/i.test(reason)
        ? '이 프로젝트에서 Google Sheets API 가 켜져 있지 않습니다. ' +
          'Google Cloud Console > [API 및 서비스] > [라이브러리] 에서 ' +
          'Google Sheets API 를 사용 설정한 뒤 다시 등록해 주세요.'
        : /invalid_grant|Invalid JWT|invalid_client/i.test(reason)
        ? '키가 유효하지 않습니다. 삭제된 키이거나 파일 내용이 잘린 경우입니다. ' +
          'JSON 파일을 다시 내려받아 전체를 붙여넣어 주세요.'
        : reason || '서비스 계정 인증에 실패했습니다.',
      502
    );
  }

  return { token: payload.access_token, expiresIn: payload.expires_in ?? 3600 };
}

/**
 * 붙여넣은 키를 검사하고, 쓸 수 있으면 그 계정 주소를 돌려줍니다.
 *
 * 실제로 토큰을 받아 보기까지 합니다 — 형식만 맞고 Sheets API 가 꺼져 있거나
 * 키가 이미 삭제된 경우가 실제로 가장 흔한 실패이고, 그것은 파싱으로는
 * 드러나지 않습니다.
 */
export async function verifyServiceAccount(raw: string): Promise<string> {
  const key = parseServiceAccount(raw);
  await requestToken(key);
  return key.client_email;
}

/** 화면에 보여 줄 서비스 계정 주소 — 시트를 이 주소로 공유해야 합니다. */
export function serviceAccountEmail(): string {
  try {
    return loadServiceAccount()?.client_email ?? '';
  } catch {
    return '';
  }
}
