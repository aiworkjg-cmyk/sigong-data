import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load apps/sigong-upload/.env in local development. On Azure App Service the
// values arrive as App Settings, already present in process.env.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Writable root for staged uploads, the test-mode library mirror, and the JSON
 * fallback store. On App Service only /home survives a restart, so DATA_DIR is
 * set to /home/data there.
 */
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

export const config = {
  isProduction,
  port: int(process.env.PORT, 3000),
  dataDir,

  paths: {
    /** Attachments staged here until SharePoint confirms the upload. */
    staging: path.join(dataDir, 'staging'),
    /** Stand-in document library used when SharePoint is not configured yet. */
    testLibrary: path.join(dataDir, 'sharepoint_test_library'),
    /** JSON records, used only when Azure Table Storage is not configured. */
    jsonStore: path.join(dataDir, 'store'),
  },

  uploads: {
    maxFiles: int(process.env.MAX_FILES, 50),
    maxFileSizeBytes: int(process.env.MAX_FILE_SIZE_MB, 100) * 1024 * 1024,
  },

  sharePoint: {
    tenantId: process.env.SHAREPOINT_TENANT_ID?.trim() || '',
    clientId: process.env.SHAREPOINT_CLIENT_ID?.trim() || '',
    clientSecret: process.env.SHAREPOINT_CLIENT_SECRET?.trim() || '',
    siteId: process.env.SHAREPOINT_SITE_ID?.trim() || '',
    driveId: process.env.SHAREPOINT_DRIVE_ID?.trim() || '',
  },

  tables: {
    /** Full connection string. Simplest option; fine for a single admin app. */
    connectionString: process.env.AZURE_TABLES_CONNECTION_STRING?.trim() || '',
    /** Account name for managed-identity auth (preferred once deployed). */
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME?.trim() || '',
    prefix: process.env.AZURE_TABLES_PREFIX?.trim() || 'Sigong',
  },

  admin: {
    username: process.env.ADMIN_USERNAME?.trim() || 'admin',
    displayName: process.env.ADMIN_DISPLAY_NAME?.trim() || '관리자',
    /** scrypt$<saltBase64>$<hashBase64>, produced by `npm run hash-password`. */
    passwordHash: process.env.ADMIN_PASSWORD_HASH?.trim() || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET?.trim() || '',
    sessionHours: int(process.env.ADMIN_SESSION_HOURS, 12),
    /** Set false only when terminating TLS elsewhere in local testing. */
    secureCookie: bool(process.env.ADMIN_SECURE_COOKIE, isProduction),
  },
} as const;

export type AppConfig = typeof config;

/** Creates the writable directories the app assumes exist. */
export function ensureDataDirs(): void {
  for (const dir of [config.paths.staging, config.paths.testLibrary, config.paths.jsonStore]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Fatal-on-boot checks. Admin credentials are required in production because
 * the alternative — an unprotected admin console — is worse than not starting.
 */
export function validateConfig(): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.admin.passwordHash) {
    (isProduction ? errors : warnings).push(
      'ADMIN_PASSWORD_HASH 가 설정되지 않았습니다. `npm run hash-password -- <비밀번호>` 로 생성하세요.'
    );
  }
  if (!config.admin.sessionSecret) {
    (isProduction ? errors : warnings).push(
      'ADMIN_SESSION_SECRET 이 설정되지 않았습니다. 임의의 32바이트 이상 문자열이 필요합니다.'
    );
  } else if (config.admin.sessionSecret.length < 32) {
    warnings.push('ADMIN_SESSION_SECRET 이 32자 미만입니다. 더 긴 값을 권장합니다.');
  }

  const sp = config.sharePoint;
  const spPartial = [sp.tenantId, sp.clientId, sp.clientSecret].filter(Boolean).length;
  if (spPartial > 0 && spPartial < 3) {
    warnings.push('SHAREPOINT_* 설정이 일부만 채워져 있어 테스트 저장 모드로 동작합니다.');
  }

  if (!config.tables.connectionString && !config.tables.accountName) {
    warnings.push(
      'Azure Table Storage 설정이 없어 로컬 JSON 파일 저장소를 사용합니다. (운영 배포 전 설정 필요)'
    );
  }

  return { errors, warnings };
}
