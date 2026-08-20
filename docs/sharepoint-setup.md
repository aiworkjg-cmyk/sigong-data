# SharePoint / Teams 클라우드 연동 설정 가이드

이 문서는 `apps/sigong-upload/.env`(배포 환경에서는 App Service 애플리케이션 설정)의 `SHAREPOINT_*` 값을 채워서 실제 Microsoft SharePoint(Teams 채널의 클라우드 저장소)에
자동으로 폴더가 생성되고 파일이 저장되도록 만드는 절차입니다. 이 작업은 Microsoft 365 관리자 권한(또는
Azure AD에서 앱 등록 및 관리자 동의를 할 수 있는 권한)이 있는 사람이 진행해야 합니다.

연동이 완료되기 전까지 서버는 자동으로 "테스트 저장 모드"로 동작하며, 앱 자체는 정상적으로 동작합니다
(`DATA_DIR/sharepoint_test_library` 폴더에 SharePoint와 동일한 폴더 구조로 저장됨).

## 1. 대상 Teams 채널의 SharePoint 사이트 확인

각 Teams 팀은 자동으로 연결된 SharePoint 사이트(문서 라이브러리)를 가지고 있습니다.
파일을 저장할 Teams 팀에서:

1. 해당 채널 상단의 `파일` 탭 클릭
2. `...` (더보기) → `SharePoint에서 열기` 클릭
3. 브라우저 주소창의 URL을 기록해 둡니다. 예:
   `https://contoso.sharepoint.com/sites/시공현장팀/Shared Documents/...`
   → 사이트 경로는 `contoso.sharepoint.com:/sites/시공현장팀`

## 2. Azure AD 앱 등록 (Azure Portal)

1. https://portal.azure.com 접속 → **Azure Active Directory** (또는 **Microsoft Entra ID**) → **앱 등록(App registrations)** → **새 등록(New registration)**
2. 이름 입력 (예: `시공현장자료-SharePoint연동`), 계정 유형은 "이 조직 디렉터리만" 선택 → 등록
3. 등록 완료 후 개요(Overview) 화면에서 다음 두 값을 복사해 환경변수에 저장:
   - **애플리케이션(클라이언트) ID** → `SHAREPOINT_CLIENT_ID`
   - **디렉터리(테넌트) ID** → `SHAREPOINT_TENANT_ID`

## 3. 클라이언트 시크릿 생성

1. 앱 등록 화면 왼쪽 메뉴 → **인증서 및 비밀(Certificates & secrets)** → **새 클라이언트 비밀(New client secret)**
2. 설명 입력, 만료 기간 선택(예: 24개월) → 추가
3. 생성 직후 표시되는 **값(Value)**을 즉시 복사 (페이지를 벗어나면 다시 볼 수 없음) → `SHAREPOINT_CLIENT_SECRET`

## 4. Microsoft Graph API 권한 부여

1. 앱 등록 화면 왼쪽 메뉴 → **API 권한(API permissions)** → **권한 추가(Add a permission)**
2. **Microsoft Graph** → **애플리케이션 권한(Application permissions)** 선택
3. 다음 중 하나를 추가:
   - **`Sites.Selected`** (권장 — 지정한 사이트에만 접근 가능, 더 안전) 또는
   - **`Sites.ReadWrite.All`** (모든 SharePoint 사이트에 읽기/쓰기 가능, 설정은 간단하지만 권한 범위가 넓음)
4. 추가 후 반드시 **"~에 대한 관리자 동의 부여(Grant admin consent)"** 버튼 클릭 (조직 관리자만 가능)
   - 이 버튼을 누르지 않으면 토큰은 발급되지만 실제 파일 업로드 시 403 오류가 발생합니다.

`Sites.Selected`를 선택한 경우, 4단계에서 만든 앱에 **해당 사이트에 대한 쓰기 권한**을 별도로 한 번 더
부여해야 합니다 (Graph Explorer 또는 아래 curl 예시로 1회 실행):

```
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": { "id": "{client-id}", "displayName": "시공현장자료-SharePoint연동" }
  }]
}
```

## 5. Site ID 조회

브라우저에서 https://developer.microsoft.com/graph/graph-explorer 접속 후 관리자 계정으로 로그인,
아래 요청을 실행합니다 (1번에서 기록한 사이트 경로 사용):

```
GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/시공현장팀
```

응답의 `id` 값 전체(예: `contoso.sharepoint.com,xxxxxxxx-xxxx-...,yyyyyyyy-yyyy-...`)를
`SHAREPOINT_SITE_ID`에 그대로 넣습니다. (`SHAREPOINT_DRIVE_ID`는 비워둬도 됩니다 —
Site ID만으로 해당 사이트의 기본 문서 라이브러리를 자동으로 찾습니다.)

## 6. 최종 설정 예시

로컬 개발은 `apps/sigong-upload/.env`, Azure 배포는 App Service 애플리케이션 설정에 등록합니다.

```
SHAREPOINT_TENANT_ID="11111111-2222-3333-4444-555555555555"
SHAREPOINT_CLIENT_ID="66666666-7777-8888-9999-000000000000"
SHAREPOINT_CLIENT_SECRET="여기에_클라이언트_시크릿_값"
SHAREPOINT_SITE_ID="contoso.sharepoint.com,xxxxxxxx-...,yyyyyyyy-..."
SHAREPOINT_DRIVE_ID=""
```

## 7. 연동 확인

서버를 재시작한 뒤 아래 주소로 접속해 `mode`가 `"LIVE"`로 바뀌었는지 확인합니다.

```
GET http://localhost:3000/api/status
```

관리자로 로그인한 뒤 우측 상단 **저장소 상태** 버튼을 누르면 연결 여부, 현재 폴더 분류 규칙,
실제 저장 폴더 트리를 화면에서 바로 확인할 수 있습니다.

이후 앱에서 현장 자료를 하나 제출해 보면, Teams 채널의 SharePoint 문서 라이브러리에
`시공현장자료 / YYYY-MM / YYYY-MM-DD_주소_담당자 / 첨부파일` 구조로 폴더가 자동 생성되고
현장정보.json과 첨부 파일(사진·동영상, 4MB 이상은 자동으로 분할 업로드)이 저장됩니다.

이 폴더 규칙은 코드 수정 없이 `SHAREPOINT_FOLDER_SEGMENTS` 환경변수로 바꿀 수 있습니다.
자세한 내용은 [azure-deployment.md](./azure-deployment.md) 의 "폴더 분류 규칙 변경" 절을 참고하세요.

문제가 있다면 관리자 화면의 "SharePoint 재동기화" 버튼으로 개별 현장 건을 다시 시도할 수 있습니다
(`POST /api/admin/sites/:id/retry`). 저장에 실패한 파일은 서버의 임시 폴더에 보관되므로
재동기화 시 그대로 다시 업로드되며, 이미 저장된 파일은 중복 업로드되지 않습니다.
