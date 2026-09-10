/**
 * 배포용 폴더를 만듭니다.
 *
 * 왜 dist 를 그대로 올리지 않는가: 서버 번들은 express·multer 같은 라이브러리를
 * 안에 넣지 않고 밖에서 찾습니다(그래야 번들이 작고 빌드가 빠릅니다). dist 만
 * 올리면 그 라이브러리가 없어 서버가 시작조차 못 합니다.
 *
 * 그래서 여기서 dist 옆에 package.json 을 하나 놓아 줍니다. App Service 가
 * 그것을 보고 필요한 다섯 개만 설치합니다. node_modules 를 통째로 올리는
 * 방법도 있지만, 수만 개의 파일을 업로드하느라 배포가 몇 분씩 길어집니다.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(appRoot, 'dist');
const out = path.join(appRoot, 'deploy');

if (!fs.existsSync(path.join(dist, 'server.cjs'))) {
  console.error('dist/server.cjs 가 없습니다. 먼저 npm run build 를 실행해 주세요.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(dist, out, { recursive: true });

const source = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf-8'));

// 서버 번들이 밖에서 찾는 것만 남깁니다. @jg/sharepoint-core 는 번들 안에
// 이미 들어가 있고, vite 는 개발용이라 운영에서는 불러오지 않습니다.
const runtime = ['express', 'multer', 'dotenv', '@azure/data-tables', '@azure/identity'];

fs.writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'sigong-upload',
      version: source.version,
      private: true,
      // 시작 명령이 곧 이것입니다. 배포 폴더가 앱의 뿌리가 되므로 경로가 짧습니다.
      main: 'server.cjs',
      scripts: { start: 'node server.cjs' },
      engines: { node: '>=20 <23' },
      dependencies: Object.fromEntries(
        runtime.map((name) => [name, source.dependencies[name]])
      ),
    },
    null,
    2
  )}\n`
);

console.log(`배포 폴더 준비 완료 — ${path.relative(process.cwd(), out)}`);
