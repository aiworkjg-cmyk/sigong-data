# 작업 공간 (Workspace)

여러 사이트를 한 저장소에서 관리하는 모노레포입니다.
각 사이트는 `apps/` 아래 독립 폴더로 들어가고, 사이트들이 함께 쓰는 코드는 `packages/` 에 둡니다.

```
C:\dev\webapps\
├─ START.cmd                    더블클릭하면 로컬 서버 실행
├─ apps/                        사이트(배포 단위)
│  └─ sigong-upload/            시공현장 자료 수집·관리 시스템
│     ├─ src/                   프론트엔드 (React + Vite)
│     ├─ server/                백엔드 (Express)
│     ├─ scripts/               운영 스크립트
│     └─ package.json
├─ packages/                    사이트 간 공용 코드
│  └─ sharepoint-core/          SharePoint 업로드 + 폴더 분류 규칙
├─ docs/                        설정·배포 문서
├─ .github/workflows/           사이트별 배포 파이프라인
├─ package.json                 npm workspaces 루트
└─ tsconfig.base.json           공통 TypeScript 설정
```

## 빠른 시작

### 가장 간단한 방법

`START.cmd` 를 더블클릭하세요. 최초 1회는 필요한 파일을 내려받느라 몇 분 걸리고,
그 다음부터는 바로 서버가 켜지며 브라우저가 자동으로 열립니다.
**그 검은 창을 닫으면 서버도 함께 종료됩니다.**

### 명령어로 실행하는 방법

```bash
npm install
```

```bash
cp apps/sigong-upload/.env.example apps/sigong-upload/.env
```

```bash
npm run hash-password --workspace @jg/sigong-upload -- "로컬용비밀번호"
```

출력된 `ADMIN_PASSWORD_HASH` 와 `ADMIN_SESSION_SECRET` 을 `.env` 에 붙여넣은 뒤:

```bash
npm run dev
```

http://localhost:3000 에서 현장 등록 화면이 열립니다.
우측 상단 **관리자** 버튼 → 위에서 정한 아이디/비밀번호로 로그인하면 관리자 화면으로 들어갑니다.

SharePoint 나 Azure 설정이 없어도 그대로 동작합니다. 이 경우 파일은
`apps/sigong-upload/data/sharepoint_test_library` 에 실제와 동일한 폴더 구조로 저장되고,
기록은 같은 폴더의 JSON 파일에 저장됩니다.

## 자주 쓰는 명령

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 실행 (프론트 HMR 포함). `START.cmd` 가 이것을 실행합니다 |
| `npm run build` | 프론트 + 서버 빌드 |
| `npm run start` | 빌드 결과 실행 (운영과 동일한 경로) |
| `npm run lint` | 전체 워크스페이스 타입 검사 |
| `npm run hash-password --workspace @jg/sigong-upload -- "비밀번호"` | 관리자 비밀번호 해시 생성 |

## 로컬 서버는 어떻게 동작하나

`npm run dev` 하나로 **API 서버와 프론트엔드가 같은 포트(3000)에서** 함께 뜹니다.
Express 가 요청을 받아 `/api/*` 는 직접 처리하고, 나머지는 Vite 에 넘겨 화면을 그립니다.

```
브라우저 ──> http://localhost:3000
                     │
                Express 서버 (server/index.ts)
                     ├── /api/*  → 업로드 접수, 관리자 기능
                     └── 그 외    → Vite 개발 서버 (React 화면)
                                     화면 코드를 고치면 새로고침 없이 즉시 반영
```

운영 배포 시에는 Vite 대신 미리 빌드해 둔 정적 파일(`dist/web`)을 내보냅니다.
같은 코드가 로컬과 배포 환경에서 동일하게 동작하고, 달라지는 것은 환경변수뿐입니다.

`localhost` 는 "이 컴퓨터"라는 뜻이라 다른 기기에서는 열리지 않습니다.
현장 담당자가 접속하려면 배포가 필요합니다 ([docs/azure-deployment.md](docs/azure-deployment.md)).

## 새 사이트 추가하기

1. `apps/<사이트이름>/` 폴더를 만들고 `package.json` 의 `name` 을 `@jg/<사이트이름>` 으로 지정합니다.
2. 루트에서 `npm install` 을 한 번 실행하면 워크스페이스에 자동으로 연결됩니다.
3. `.github/workflows/deploy-<사이트이름>.yml` 을 추가합니다.
   기존 워크플로를 복사한 뒤 `AZURE_WEBAPP_NAME` 과 `paths` 필터만 바꾸면 됩니다.
   `paths` 필터 덕분에 한 사이트를 고쳐도 다른 사이트는 배포되지 않습니다.
4. Azure 리소스는 사이트마다 따로 만듭니다. 절차는 [docs/azure-deployment.md](docs/azure-deployment.md) 와 동일합니다.

### 공용 코드는 언제 `packages/` 로 옮기나

**두 번째 사이트가 실제로 같은 코드를 필요로 할 때** 옮기세요.
"나중에 쓸 것 같아서" 미리 공용화하면, 사이트마다 요구사항이 갈릴 때
공용 패키지가 분기 처리로 뒤덮여 오히려 유지보수가 어려워집니다.

현재 `packages/sharepoint-core` 는 SharePoint 업로드와 폴더 분류라는 뚜렷한 경계를 갖고 있어
분리되어 있습니다. 폴더 규칙이 데이터(템플릿 문자열)로 표현되어 있어서,
다른 사이트가 다른 분류 체계를 쓰더라도 코드를 고칠 필요가 없습니다.

## 주의사항

- **`.env` 파일은 절대 커밋하지 마세요.** `.gitignore` 에 등록되어 있으며,
  필요한 키 목록은 `.env.example` 에 정리되어 있습니다.
- **경로를 짧게 유지하세요.** Windows 의 260자 경로 제한 때문에
  `node_modules` 가 깊은 경로에 있으면 설치가 실패할 수 있습니다.
  작업 폴더를 `C:\dev\webapps` 같은 짧은 경로에 두는 이유입니다.
- **OneDrive 동기화 폴더 안에 두지 마세요.** `node_modules` 동기화 때문에
  빌드가 느려지고 파일 잠금 오류가 발생합니다.

## 앱별 문서

### sigong-upload — 시공현장 자료 수집·관리 시스템

현장 담당자가 **로그인 없이** 사진·동영상을 제출하면, 서버가 SharePoint 문서 라이브러리에
분류 폴더를 자동 생성하고 파일을 저장합니다. 관리자 계정(1개)으로 제출 내역, 업로드 로그,
이슈를 관리합니다.

| 대상 | 접근 방식 |
|------|-----------|
| 현장 담당자 | 링크만 있으면 됨. 계정·로그인 불필요 |
| 관리자 | 아이디/비밀번호 로그인 (계정 1개, 환경변수로 설정) |

폴더 구조 (환경변수로 변경 가능):

```
시공현장자료 / {시공종류} / {연도} / {월}월 / {월일}_{주소}
예) 시공현장자료 / 백조 / 2026 / 08월 / 0811_경기광명시하안로60광명SK테크노파크
```

주요 동작:

- **제출 즉시 응답합니다.** 담당자는 자기 파일 전송이 끝나는 순간 완료 화면을 보고,
  저장소 반영은 서버가 뒤에서 처리합니다. 완료 화면에서 보관 진행률을 실시간으로 보여 줍니다.
- 시공종류는 정해진 목록에서 선택만 가능합니다 (폴더 이름이 되므로 임의 입력 불가).
- 제출된 파일은 메모리에 담지 않고 디스크에 임시 저장한 뒤 순차 업로드합니다
  (100MB 동영상 50개를 받아도 메모리가 터지지 않습니다).
- 4MB 초과 파일은 Microsoft Graph 의 분할 업로드 세션으로 전송합니다.
- 저장 실패 시 자동으로 재시도하고, 그래도 실패하면 **관리자에게 메일로 알립니다.**
  실패한 파일은 임시 폴더에 남아 관리자 화면에서 다시 시도할 수 있습니다.
- 서버가 재시작되어도 처리 중이던 제출은 부팅 시 자동으로 이어서 처리됩니다.
- 모든 제출 시도는 업로드 로그에 기록됩니다 (성공/실패, 파일 수, 용량, 소요 시간, 접속 IP).
- 관리자 계정은 마스터 1개 + 화면에서 추가 생성. 추가 계정은 계정 관리만 불가능합니다.

설정 문서:

- [SharePoint 연동 설정](docs/sharepoint-setup.md) — Azure AD 앱 등록부터 Site ID 확인까지
- [Azure 배포 가이드](docs/azure-deployment.md) — App Service, Table Storage, 배포 파이프라인
