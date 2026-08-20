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

### 폴더 분류 규칙 변경

기본 규칙은 `시공현장자료 / {yyyy}-{MM} / {date}_{address}_{manager} / 첨부파일` 입니다.
코드 수정 없이 환경변수로 바꿀 수 있습니다.

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings \
  SHAREPOINT_FOLDER_SEGMENTS='{yyyy},{quarter},{sigungu},{date}_{manager}'
```

사용 가능한 항목: `{yyyy} {MM} {dd} {date} {yyyy-MM} {quarter} {address} {sido} {sigungu} {manager} {siteId} {submittedDate}`

`첨부파일` 하위 폴더나 `현장정보.json` 을 끄려면 값을 `none` 으로 지정합니다.
빈 값은 "끄기" 가 아니라 "기본값 사용" 을 의미합니다.

변경한 규칙은 **이후 제출분부터** 적용되며, 이미 저장된 폴더는 이동하지 않습니다.

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
| 인스턴스 수 | 로그인 시도 제한이 프로세스 메모리에 있어, 스케일 아웃 시 인스턴스별로 따로 계산됩니다. 1개 인스턴스 유지를 권장합니다. |
| 업로드 임시 파일 | 저장 성공 시 자동 삭제됩니다. 실패분만 `/home/data/staging` 에 남아 재동기화에 사용됩니다. |
| 요청 타임아웃 | 서버는 30분으로 설정되어 있습니다. App Service 프런트엔드 자체 한도(약 230초)를 넘는 단일 요청은 실패할 수 있으므로, 100MB 초과 파일이 잦다면 파일 수를 나눠 제출하도록 안내하세요. |
| 백업 | 파일 원본은 SharePoint(=Microsoft 365 백업 정책 적용), 기록은 Table Storage 에 있습니다. Table Storage 는 별도 백업 설정이 없으므로 필요 시 주기적 내보내기를 검토하세요. |
| 비밀번호 변경 | `hash-password` 로 새 해시를 만들어 `ADMIN_PASSWORD_HASH` 를 교체하면 됩니다. `ADMIN_SESSION_SECRET` 을 함께 바꾸면 기존 로그인 세션이 모두 무효화됩니다. |
