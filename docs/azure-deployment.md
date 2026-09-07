# Azure 배포 가이드 — sigong-upload

이 문서는 `apps/sigong-upload` 를 Azure App Service(Linux, Node 20)에 올리고,
현장 기록·업로드 로그·이슈를 Azure Table Storage 에 저장하도록 구성하는 절차입니다.

파일 자체(사진·동영상)는 Azure 가 아니라 **SharePoint 문서 라이브러리**에 저장됩니다.
SharePoint 연동 설정은 [sharepoint-setup.md](./sharepoint-setup.md) 를 먼저 진행하세요.

전체 구성:

```
    현장 담당자 (로그인 없음)          관리자 (계정 1개)
            │                              │
            └──────────────┬───────────────┘
                           ▼
              Azure App Service (Linux, Node 20)
                           │
            ┌──────────────┴───────────────┐
            ▼                              ▼
   SharePoint 문서 라이브러리        Azure Table Storage
   (사진·동영상 원본 파일)      (현장 기록 / 업로드 로그 / 이슈)
```

---

## 0. 사전 준비

- Azure 구독 및 리소스를 만들 수 있는 권한
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 설치 후 로그인

```bash
az login
```

아래 값은 원하는 대로 바꿔 쓰고, 이후 명령에서 동일하게 사용하세요.

```bash
RG=rg-sigong
LOCATION=koreacentral
PLAN=plan-sigong
APP=sigong-upload
STORAGE=stsigong$RANDOM
```

> `APP` 값은 `.github/workflows/deploy-sigong-upload.yml` 의 `AZURE_WEBAPP_NAME` 과
> 반드시 일치해야 합니다. 또한 App Service 이름은 Azure 전체에서 고유해야 합니다.

---

## 1. 리소스 그룹과 App Service 만들기

```bash
az group create --name $RG --location $LOCATION
```

```bash
az appservice plan create --name $PLAN --resource-group $RG --location $LOCATION --is-linux --sku B1
```

```bash
az webapp create --name $APP --resource-group $RG --plan $PLAN --runtime "NODE:20-lts"
```

> **요금 참고**: B1 은 항상 켜져 있는 기본 플랜입니다. 트래픽이 적다면 F1(무료)로도
> 시작할 수 있지만, F1 은 하루 CPU 사용 제한과 Always On 미지원 때문에 대용량 업로드에
> 적합하지 않습니다. 실사용은 B1 이상을 권장합니다.

---

## 2. 시작 명령과 기본 설정

배포 패키지는 이미 빌드된 상태로 올라가므로, App Service 가 다시 빌드하지 않도록 합니다.

```bash
az webapp config set --name $APP --resource-group $RG \
  --startup-file "node apps/sigong-upload/dist/server.cjs"
```

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  NODE_ENV=production \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  DATA_DIR=/home/data \
  WEBSITES_CONTAINER_START_TIME_LIMIT=300
```

`DATA_DIR=/home/data` 가 중요합니다. App Service 에서 재시작 후에도 유지되는 경로는
`/home` 뿐이며, 업로드 임시 파일이 여기 저장되어야 저장 실패 시 관리자가 재동기화할 수
있습니다.

### 로컬의 .env 는 Azure 로 올라가지 않습니다

로컬에서는 `apps/sigong-upload/.env` 파일을 읽습니다. App Service 에는 그 파일이
없고, 대신 **구성 > 환경 변수(애플리케이션 설정)** 에 넣은 값이 `process.env` 로
들어옵니다. 앱 코드는 양쪽을 구분하지 않으므로 **키 이름은 그대로** 두고 값을 옮기면
됩니다.

`.env` 는 `.gitignore` 에 있어 저장소에 올라가지 않습니다. 배포 파이프라인이
`.env` 를 복사하는 일도 없습니다 — 의도된 동작입니다.

### 로컬과 달라지는 값

| 설정 | 로컬 | Azure |
| --- | --- | --- |
| `DATA_DIR` | 비움 (`apps/sigong-upload/data`) | `/home/data` |
| `APP_URL` | 비움 (`http://localhost:3000`) | `https://<앱이름>.azurewebsites.net` |
| `NODE_ENV` | 비움 | `production` |
| `ADMIN_SECURE_COOKIE` | 비움 (자동 false) | 비움 (자동 true) |

`APP_URL` 은 단순한 표시용이 아닙니다. Microsoft·Google 로그인의 **리디렉션
주소가 여기서 만들어지므로**, 배포 후에는 각 콘솔에도 운영 주소를 한 번 더 등록해야
합니다.

- Azure 앱 등록 > 인증: `https://<앱이름>.azurewebsites.net/api/admin/settings/microsoft/callback`
- Google Cloud > 사용자 인증 정보: `https://<앱이름>.azurewebsites.net/api/admin/work-orders/google/callback`

로컬 주소를 지울 필요는 없습니다. 두 개를 함께 등록해 두면 로컬과 운영 양쪽에서
모두 동작합니다.

### 서비스 계정 키 (구글시트 연동)

로컬에서는 파일 경로를 적어도 되지만, App Service 에는 그 파일을 둘 자리가 마땅치
않습니다. **JSON 본문을 한 줄로** 넣으세요.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  GOOGLE_SERVICE_ACCOUNT_JSON="$(cat ./secrets/baekjosink-sheet-key.json | tr -d '\n')"
```

키 파일을 저장소에 커밋하지 마세요. `secrets/` 와 `*-key.json` 은 `.gitignore` 에
있지만, 다른 이름으로 두면 걸리지 않습니다. 운영에서는 아래 Key Vault 참조를 권합니다.

---

대용량 업로드를 위해 Always On 을 켭니다 (B1 이상에서 사용 가능).

```bash
az webapp config set --name $APP --resource-group $RG --always-on true
```

---

## 3. Azure Table Storage 만들기

```bash
az storage account create --name $STORAGE --resource-group $RG \
  --location $LOCATION --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false
```

테이블은 앱이 첫 실행 시 자동으로 만들기 때문에 직접 만들 필요는 없습니다
(`SigongSites`, `SigongUploadLogs`, `SigongIssues`).

### 3-1. 관리 ID로 연결 (권장 — 비밀값 없음)

App Service 에 시스템 할당 관리 ID를 켜고, 저장소에 쓰기 권한을 부여합니다.

```bash
az webapp identity assign --name $APP --resource-group $RG
```

```bash
PRINCIPAL_ID=$(az webapp identity show --name $APP --resource-group $RG --query principalId -o tsv)
STORAGE_ID=$(az storage account show --name $STORAGE --resource-group $RG --query id -o tsv)

az role assignment create \
  --assignee-object-id $PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Table Data Contributor" \
  --scope $STORAGE_ID
```

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  AZURE_STORAGE_ACCOUNT_NAME=$STORAGE \
  AZURE_TABLES_PREFIX=Sigong
```

> 역할 부여가 실제로 적용되기까지 몇 분 걸릴 수 있습니다. 그 전까지 앱은 자동으로
> 로컬 JSON 저장소로 대체 동작하며, 관리자 화면의 "저장소 상태" 에 `로컬 JSON` 으로 표시됩니다.

### 3-2. 연결 문자열로 연결 (간단하지만 비밀값 관리 필요)

관리 ID 대신 연결 문자열을 쓰려면:

```bash
CONN=$(az storage account show-connection-string --name $STORAGE --resource-group $RG --query connectionString -o tsv)
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  AZURE_TABLES_CONNECTION_STRING="$CONN"
```

둘 다 설정된 경우 연결 문자열이 우선합니다.

---

## 4. 관리자 계정 설정

로컬에서 비밀번호 해시와 세션 비밀키를 생성합니다. **평문 비밀번호는 Azure에 저장하지 않습니다.**

```bash
npm run hash-password --workspace @jg/sigong-upload -- "실제로사용할비밀번호"
```

출력된 두 값을 App Service 설정에 등록합니다.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  ADMIN_USERNAME=admin \
  ADMIN_DISPLAY_NAME=관리자 \
  ADMIN_PASSWORD_HASH='<출력된 해시 값>' \
  ADMIN_SESSION_SECRET='<출력된 세션 비밀키>' \
  ADMIN_SESSION_HOURS=12
```

`ADMIN_PASSWORD_HASH` 와 `ADMIN_SESSION_SECRET` 이 없으면 운영 모드에서는 서버가
시작되지 않습니다. 관리자 화면이 무방비로 열려 있는 것보다 안전하기 때문입니다.

### 추가 관리자 계정

여기서 설정한 계정이 **마스터 계정**입니다. 추가 관리자는 배포 후 화면에서 만듭니다:
관리자 로그인 → **계정 관리** 탭 → 계정 추가.

추가 계정은 현장 자료·업로드 로그·이슈를 모두 볼 수 있지만 계정 관리는 할 수 없습니다.
마스터 계정만 환경변수로 관리되므로, 저장소에 문제가 생겨도 마스터는 항상 로그인할 수 있습니다.

### Key Vault 사용 (선택, 권장)

비밀값을 Key Vault 에 두고 참조 형식으로 연결할 수 있습니다.

```bash
az keyvault secret set --vault-name <금고이름> --name admin-password-hash --value '<해시 값>'
```

App Setting 값을 아래 형식으로 지정합니다.

```
@Microsoft.KeyVault(SecretUri=https://<금고이름>.vault.azure.net/secrets/admin-password-hash/)
```

App Service 관리 ID에 해당 금고의 **Key Vault Secrets User** 역할을 부여해야 합니다.

---

## 5. SharePoint 연동 값 등록

[sharepoint-setup.md](./sharepoint-setup.md) 에서 얻은 값을 등록합니다.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  SHAREPOINT_TENANT_ID='<테넌트 ID>' \
  SHAREPOINT_CLIENT_ID='<클라이언트 ID>' \
  SHAREPOINT_CLIENT_SECRET='<클라이언트 시크릿>' \
  SHAREPOINT_SITE_ID='<사이트 ID>'
```

이 값들이 비어 있으면 앱은 테스트 저장 모드로 동작합니다 (파일이 SharePoint 대신
`DATA_DIR` 아래 동일한 폴더 구조로 저장됨). 앱 자체는 정상 동작하므로 연동 전에도
사용해 볼 수 있습니다.

### 시공종류 목록

제출 화면의 선택 버튼 목록입니다. 담당자는 이 중에서만 고를 수 있고, 서버도 같은 목록으로
검증합니다 (선택값이 폴더 이름이 되므로 임의 입력을 허용하지 않습니다).

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings CONSTRUCTION_TYPES='백조,인덕션,한샘,이펙스,워너홈'
```

### 폴더 분류 규칙 변경

기본 규칙:

```
시공현장자료 / {type} / {yyyy} / {MM}월 / {MMdd}_{addressCompact}
예) 시공현장자료 / 백조 / 2026 / 08월 / 0811_경기광명시하안로60광명SK테크노파크
```

코드 수정 없이 환경변수로 바꿀 수 있습니다.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings SHAREPOINT_FOLDER_SEGMENTS='{type},{yyyy-MM},{MMdd}_{manager}'
```

사용 가능한 항목:

| 항목 | 결과 예시 |
|------|-----------|
| `{type}` | 백조 |
| `{yyyy}` `{MM}` `{dd}` `{MMdd}` | 2026 / 08 / 11 / 0811 |
| `{date}` `{yyyy-MM}` `{quarter}` | 2026-08-11 / 2026-08 / Q3 |
| `{address}` | 경기 광명시 하안로 60 |
| `{addressCompact}` | 경기광명시하안로60 |
| `{sido}` `{sigungu}` | 경기 / 광명시 |
| `{manager}` `{siteId}` `{submittedDate}` | 홍길동 / SITE-… / 2026-08-20 |

`현장정보.json` 을 만들지 않으려면 `SHAREPOINT_METADATA_FILENAME=none`,
첨부파일용 하위 폴더를 두려면 `SHAREPOINT_ATTACHMENTS_FOLDER=첨부파일` 로 지정합니다.
빈 값은 "끄기" 가 아니라 "기본값 사용" 을 의미합니다.

변경한 규칙은 **이후 제출분부터** 적용되며, 이미 저장된 폴더는 이동하지 않습니다.

---

## 5-1. 업로드 실패 알림 메일

자동 재시도까지 모두 실패하면 관리자에게 메일이 발송됩니다. SharePoint 연동에 쓰는 것과
같은 Azure AD 앱을 재사용하므로 별도 메일 서비스 가입이 필요 없습니다.

사전 작업 ([sharepoint-setup.md](./sharepoint-setup.md) 4단계):
Azure AD 앱에 **Mail.Send** 애플리케이션 권한 추가 + 관리자 동의.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings MAIL_SENDER='noreply@회사도메인.com' ADMIN_ALERT_EMAIL='관리자@회사도메인.com' APP_URL="https://$APP.azurewebsites.net"
```

`MAIL_SENDER` 는 실제 사서함이 있는 계정이어야 합니다. `ADMIN_ALERT_EMAIL` 은 쉼표로 여러 명을
지정할 수 있습니다. 설정하지 않으면 메일만 생략되고, 실패 기록은 관리자 화면에 그대로 남습니다.

### 백그라운드 저장 처리

제출 즉시 응답하고 저장은 뒤에서 진행됩니다. 실패 시 자동 재시도 횟수와 간격입니다.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings WORKER_CONCURRENCY=1 WORKER_MAX_ATTEMPTS=3 WORKER_RETRY_DELAY_MS=30000 MANUAL_RENAME_ENABLED=true MANUAL_RENAME_INTERVAL_SECONDS=60
```

`MANUAL_RENAME_INTERVAL_SECONDS=60` 은 SharePoint 전체를 매번 읽는 주기가 아닙니다. Graph
`delta` 토큰 이후의 변경분만 확인하므로, 변경이 없을 때는 분당 조회 1회 수준입니다.
앞 단계의 B1 **Always On** 설정이 켜져 있어야 사용자가 사이트를 열지 않은 시간에도 이
주기 작업이 계속 실행됩니다.

---

## 6. GitHub Actions 배포 연결

### 방법 A — 게시 프로필 (간단)

```bash
az webapp deployment list-publishing-profiles --name $APP --resource-group $RG --xml
```

출력된 XML 전체를 GitHub 저장소의
**Settings → Secrets and variables → Actions → New repository secret** 에
`AZURE_WEBAPP_PUBLISH_PROFILE` 이름으로 등록합니다.

`main` 브랜치에 푸시하면 `.github/workflows/deploy-sigong-upload.yml` 이 자동 실행됩니다.

### 방법 B — OIDC 페더레이션 (권장, 장기 자격 증명 없음)

게시 프로필은 만료되지 않는 자격 증명이라 유출 시 위험합니다. OIDC 를 쓰면
GitHub Actions 가 매 실행마다 단기 토큰을 발급받습니다. 설정 절차는
[Azure 로그인 액션 문서](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended)
를 참고하고, 워크플로의 `publish-profile` 줄을 `azure/login@v2` 단계로 대체하세요.

---

## 7. 배포 확인

```bash
curl https://$APP.azurewebsites.net/api/health
```

```bash
curl https://$APP.azurewebsites.net/api/status
```

`"mode":"LIVE"` 로 표시되면 SharePoint 연동이 활성화된 상태입니다.

관리자 화면에 로그인한 뒤 우측 상단 **저장소 상태** 버튼을 누르면
연결 상태, 현재 분류 규칙, 실제 저장 폴더를 한 화면에서 확인할 수 있습니다.

로그 확인:

```bash
az webapp log tail --name $APP --resource-group $RG
```

---

## 8. 운영 시 주의사항

| 항목 | 내용 |
|------|------|
| 로그인 제한 | 시도 횟수 제한이 프로세스 메모리에 있어, 스케일 아웃 시 인스턴스별로 따로 계산됩니다. |
| 업로드 임시 파일 | 저장 성공 시 자동 삭제됩니다. 실패분만 `/home/data/staging` 에 남아 재동기화에 사용됩니다. |
| 요청 타임아웃 | App Service 프런트엔드의 230초 제한은 **데이터가 흐르지 않는 유휴 시간** 기준입니다. 업로드는 계속 전송 중이므로 총 시간이 230초를 넘어도 정상 동작합니다. 다만 현장 네트워크가 불안정해 전송이 멈추면 끊길 수 있으니, 담당자에게는 신호가 약한 곳에서 대용량 동영상을 한 번에 올리지 않도록 안내하세요. |
| 인스턴스 수 유지 | 저장 처리 대기열이 서버 프로세스 안에 있습니다. 인스턴스를 2개 이상으로 늘리면 같은 제출을 두 번 처리할 수 있으므로, 스케일 아웃이 필요해지면 대기열을 Azure Storage Queue 로 옮겨야 합니다. |
| 백업 | 파일 원본은 SharePoint(=Microsoft 365 백업 정책 적용), 기록은 Table Storage 에 있습니다. Table Storage 는 별도 백업 설정이 없으므로 필요 시 주기적 내보내기를 검토하세요. |
| 비밀번호 변경 | `hash-password` 로 새 해시를 만들어 `ADMIN_PASSWORD_HASH` 를 교체하면 됩니다. `ADMIN_SESSION_SECRET` 을 함께 바꾸면 기존 로그인 세션이 모두 무효화됩니다. |
