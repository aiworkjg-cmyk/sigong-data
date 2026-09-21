/**
 * 시공기사 등록 양식(.xlsx)을 다시 만듭니다.
 *
 *   npm run build:technician-template --workspace @jg/sigong-upload
 *
 * 직책을 손으로 치게 두면 "팀장", "팀 장", "팀장님" 이 섞여 들어오고 그 셋이
 * 서로 다른 직책이 됩니다. 목록에서 고르게 하면 그 일이 없습니다.
 *
 * 직책 목록은 src/types.ts 의 TECHNICIAN_TITLES 하나만 봅니다. 양식과 화면이
 * 각자 목록을 들고 있으면 직책을 하나 추가할 때 한쪽만 고치게 되고, 그러면
 * 양식으로 올린 기사만 조용히 거부됩니다. 직책을 바꾼 뒤에는 이 명령을 다시
 * 실행해 주세요.
 *
 * 시공종류는 목록으로 만들지 않습니다 — 설정에서 언제든 바뀌는 값이라,
 * 양식에 박아 두면 양식이 낡는 순간 실제 시공종류를 거부하게 됩니다.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'public', 'templates', '시공기사_등록양식.xlsx');

// TypeScript 모듈을 그대로 불러오기 위해 tsx 로 한 번 감쌉니다. 값을 여기에
// 다시 적으면 그 순간 두 벌이 되고, 언젠가 서로 달라집니다.
const script = `
import { buildWorkbook } from './server/xlsx-writer';
import { TECHNICIAN_HEADERS } from './server/technician-import';
import { TECHNICIAN_TITLES } from './src/types';
import fs from 'fs';

const columns = TECHNICIAN_HEADERS.map((header) => ({
  header,
  value: () => '',
  width: header === '시공종류' ? 24 : header === '연락처' ? 18 : 14,
}));

fs.writeFileSync(
  process.argv[2],
  buildWorkbook({
    sheetName: '시공기사',
    columns,
    rows: [],
    caption:
      '이름과 직책은 필수입니다. 직책은 칸을 누르면 나오는 목록에서 고르세요. ' +
      '시공종류가 여럿이면 쉼표로 구분합니다(예: 백조,한샘).',
    choices: [{ header: '직책', options: [...TECHNICIAN_TITLES] }],
  })
);
`;

const temp = path.join(appRoot, '.template-build.mts');
fs.writeFileSync(temp, script);
try {
  execFileSync('npx', ['tsx', temp, out], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log(`양식을 다시 만들었습니다 — ${path.relative(process.cwd(), out)}`);
  console.log(`직책 목록: ${'대표 / 실장 / 팀장 / 사수 / 부사수'}`);
} finally {
  fs.rmSync(temp, { force: true });
}
