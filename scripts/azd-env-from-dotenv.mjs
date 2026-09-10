/**
 * .env 의 값을 azd 환경으로 옮깁니다.
 *
 * 손으로 타이핑하지 않는 것이 요점입니다. PowerShell 은 입력한 명령을
 * ConsoleHost_history.txt 에 평문으로 남기므로, 비밀번호 해시나 클라이언트
 * 비밀을 명령줄에 적으면 그 파일에 그대로 남습니다. 여기서는 값이 프로그램
 * 안에서만 오가고 화면에도 기록에도 찍히지 않습니다.
 *
 *   node scripts/azd-env-from-dotenv.mjs
 *
 * 구글 서비스 계정 키는 .env 에 경로로 적혀 있는데, Azure 에는 그 폴더가
 * 없습니다. 경로면 파일을 읽어 내용으로 바꿔 넣습니다.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ENV_FILE = 'apps/sigong-upload/.env';

/** Azure 로 넘겨야 하는 것만. 나머지는 인프라 정의가 직접 정합니다. */
const KEYS = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD_HASH',
  'ADMIN_SESSION_SECRET',
  'SHAREPOINT_TENANT_ID',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_CLIENT_SECRET',
  'SHAREPOINT_SITE_ID',
  'SHAREPOINT_DRIVE_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
];

if (!fs.existsSync(ENV_FILE)) {
  console.error(`${ENV_FILE} 이 없습니다.`);
  process.exit(1);
}

const values = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
}

let moved = 0;
const missing = [];

for (const key of KEYS) {
  let value = values[key];
  if (!value) {
    missing.push(key);
    continue;
  }

  // 파일 경로면 내용으로 바꿉니다 — Azure 에는 그 경로가 없습니다.
  if (key === 'GOOGLE_SERVICE_ACCOUNT_JSON' && !value.trimStart().startsWith('{')) {
    const keyPath = path.resolve(value);
    if (!fs.existsSync(keyPath)) {
      missing.push(`${key} (파일 없음: ${value})`);
      continue;
    }
    value = fs.readFileSync(keyPath, 'utf-8');
  }

  // 값은 인자로 넘어가되 셸을 거치지 않습니다(execFile). 셸 기록에 남지
  // 않고, 따옴표나 줄바꿈이 들어 있어도 깨지지 않습니다.
  execFileSync('azd', ['env', 'set', key, value], {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: process.platform === 'win32',
  });

  // 값 자체는 찍지 않습니다. 화면 캡처나 어깨너머로도 새지 않게.
  console.log(`  ${key} — 옮김 (${value.length}자)`);
  moved += 1;
}

console.log(`\n${moved}개를 azd 환경으로 옮겼습니다.`);
if (missing.length > 0) {
  console.log(`\n.env 에 없어서 건너뛴 값:`);
  for (const key of missing) console.log(`  - ${key}`);
  console.log(`\n필요하다면 azd env set <이름> <값> 으로 직접 넣으세요.`);
}
