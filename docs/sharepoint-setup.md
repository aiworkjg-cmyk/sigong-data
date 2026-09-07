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

팀·채널을 찾는 방법은 두 가지입니다. **A안(로그인 방식)** 은 테넌트 관리자 동의 없이도 대부분
동작하므로 먼저 시도해 보세요. **B안(앱 권한 방식)** 은 관리자 동의가 반드시 필요합니다.

### A안 (권장) — 마스터관리자가 본인 계정으로 로그인

설정 화면의 **[Microsoft 로그인]** 버튼이 쓰는 방식입니다. 로그인한 사람의 권한으로 조회하므로
`Team.ReadBasic.All` 같은 *애플리케이션* 권한과 그 관리자 동의가 필요 없습니다.

1. 앱 등록 화면 왼쪽 메뉴 → **인증(Authentication)** → **플랫폼 추가** → **웹(Web)**
2. 리디렉션 URI 에 앱 주소 + `/api/admin/settings/microsoft/callback` 을 등록합니다.
   - 로컬: `http://localhost:3000/api/admin/settings/microsoft/callback`
   - 운영: `https://<배포주소>/api/admin/settings/microsoft/callback`
   - 두 환경을 함께 쓴다면 두 개 모두 등록해도 됩니다. **주소가 한 글자라도 다르면 AADSTS50011 이 납니다.**
3. **API 권한** → **위임된 권한(Delegated permissions)** 으로 다음을 추가합니다.
   `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `User.Read`
4. 설정 화면에서 **[Microsoft 로그인]** → 업무 계정으로 로그인 → 동의.
   - 로그인한 계정은 서버에 기억되므로, 다음부터는 **팀 이름과 채널 이름만** 입력하면 됩니다.
   - 개별 사용자 동의가 차단된 테넌트라면, 로그인 블록 안의 **관리자 동의 주소**를 조직 관리자가
     1회 열어 동의하면 이후 모든 사용자에게 적용됩니다.

> 파일 **업로드**는 제출자가 이미 떠난 뒤 백그라운드에서 진행되므로 여전히 앱 자격 증명
> (클라이언트 비밀)을 사용합니다. A안은 "저장 위치를 찾는" 단계의 권한 문제만 해결합니다.
> 따라서 업로드용 쓰기 권한은 아래 B안의 4번 항목이 그대로 필요합니다.

### B안 — 애플리케이션 권한 (테넌트 관리자 동의 필요)

1. 앱 등록 화면 왼쪽 메뉴 → **API 권한(API permissions)** → **권한 추가(Add a permission)**
2. **Microsoft Graph** → **애플리케이션 권한(Application permissions)** 선택
3. 설정 화면에서 **Microsoft 계정 이메일 + Teams 팀 이름 + 채널 이름**만으로 자동 연결하려면
   다음 **애플리케이션 권한**을 추가합니다.
   - **`Team.ReadBasic.All`** — 입력한 계정이 속한 팀 이름 조회
   - **`Channel.ReadBasic.All`** — 선택한 팀의 채널 이름 조회
4. 채널 저장 위치 조회와 파일 쓰기 권한은 다음 중 한 방식을 선택합니다.
   - **`Files.Read.All` + `Sites.Selected`** (권장) — 채널 저장 위치는 조회할 수 있고 쓰기는
     지정한 사이트로 제한합니다. 새 사이트를 처음 연결할 때 아래의 사이트별 `write` 승인을
     한 번 해야 합니다.
   - **`Files.ReadWrite.All`** — 관리자 동의 한 번으로 이후 팀/채널을 이름만 입력해 연결하고
     바로 업로드할 수 있지만, 앱이 조직 전체 파일을 읽고 쓸 수 있어 권한 범위가 큽니다.
5. 업로드 실패 알림 메일을 쓰려면 **`Mail.Send`** 도 함께 추가합니다 (애플리케이션 권한).
6. 추가 후 반드시 **"~에 대한 관리자 동의 부여(Grant admin consent)"** 버튼 클릭 (조직 관리자만 가능)
   - 이 버튼을 누르지 않으면 토큰은 발급되지만 실제 파일 업로드 시 403 오류가 발생합니다.

> **Mail.Send 주의**: 이 권한은 테넌트의 모든 사서함으로 발송이 가능해집니다. 발신 계정을
> 하나로 제한하려면 Exchange Online 에서 애플리케이션 액세스 정책(ApplicationAccessPolicy)을
> 설정해 `MAIL_SENDER` 사서함에만 접근하도록 묶어 두는 것을 권장합니다.

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

## 5. Teams 이름으로 저장 대상 자동 연결

관리자 화면 **설정 → Teams · SharePoint 저장 대상**에서 다음 세 값만 입력합니다.

1. 해당 팀에 실제로 소속된 Microsoft 업무 계정 이메일(UPN)
2. Teams에 표시되는 팀 이름
3. Teams에 표시되는 채널 이름

**[찾아서 연결 · 현재 사용]**을 누르면 서버가 `teamId`, `channelId`, `siteId`, `driveId`,
채널 폴더를 조회하여 목록에 저장하고 바로 활성화합니다. Microsoft 계정의 비밀번호나 개인 토큰은
입력하거나 저장하지 않습니다. 같은 이름의 팀 또는 채널이 여러 개면 잘못된 위치를 선택하지 않도록
연결을 중단하고 이름을 고유하게 바꾸라는 오류를 표시합니다.

연결 후 **[테스트 이미지 업로드]**를 누르면 실제 채널의 `_연결테스트` 폴더에 임의 PNG가
업로드되고, 성공 시 SharePoint 파일 링크가 표시됩니다.

## 5-1. Site ID 직접 조회 (고급/장애 대응용)

브라우저에서 https://developer.microsoft.com/graph/graph-explorer 접속 후 관리자 계정으로 로그인,
아래 요청을 실행합니다 (1번에서 기록한 사이트 경로 사용):

```
GET https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/시공현장팀
```

응답의 `id` 값 전체(예: `contoso.sharepoint.com,xxxxxxxx-xxxx-...,yyyyyyyy-yyyy-...`)를
`SHAREPOINT_SITE_ID`에 그대로 넣습니다. 자동 연결이 정상 동작하면 이 과정은 필요하지 않습니다.
(`SHAREPOINT_DRIVE_ID`는 비워둬도 됩니다 —
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

서버를 재시작한 뒤 아래 주소를 브라우저에 그대로 붙여넣어 `mode`가 `"LIVE"`로 바뀌었는지
확인합니다. (`"TEST_MODE"` 로 나오면 아직 연동 전입니다.)

```
http://localhost:3000/api/config
```

관리자로 로그인한 뒤 우측 상단 **저장소 상태** 버튼을 누르면 연결 여부, 현재 폴더 분류 규칙,
실제 저장 폴더 트리를 화면에서 바로 확인할 수 있습니다.

이후 앱에서 현장 자료를 하나 제출해 보면, Teams 채널의 SharePoint 문서 라이브러리에
아래 구조로 폴더가 자동 생성되고 첨부 파일(사진·동영상, 4MB 이상은 자동으로 분할 업로드)과
현장정보.json 이 저장됩니다.

```
시공현장자료 / {시공종류} / {연도} / {월}월 / {월일}_{주소}
예) 시공현장자료 / 백조 / 2026 / 08월 / 0811_경기광명시하안로60광명SK테크노파크
```

제출 즉시 담당자에게는 완료 화면이 표시되고, 실제 SharePoint 저장은 서버가 뒤에서 처리합니다.
따라서 대용량 동영상을 올려도 담당자가 오래 대기하지 않습니다.

이 폴더 규칙은 코드 수정 없이 `SHAREPOINT_FOLDER_SEGMENTS` 환경변수로 바꿀 수 있습니다.
자세한 내용은 [azure-deployment.md](./azure-deployment.md) 의 "폴더 분류 규칙 변경" 절을 참고하세요.

문제가 있다면 관리자 화면의 "SharePoint 재동기화" 버튼으로 개별 현장 건을 다시 시도할 수 있습니다
(`POST /api/admin/sites/:id/retry`). 저장에 실패한 파일은 서버의 임시 폴더에 보관되므로
재동기화 시 그대로 다시 업로드되며, 이미 저장된 파일은 중복 업로드되지 않습니다.
