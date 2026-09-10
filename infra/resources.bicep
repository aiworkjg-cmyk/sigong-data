/*
  시공현장 자료 수집 시스템 — Azure 인프라 정의.

  포털에서 클릭으로 만들면 "무엇을 어떻게 설정했는지"가 사람의 기억에만
  남습니다. 반년 뒤 개발용 환경을 하나 더 만들 때 그 기억을 되짚어야 하고,
  Always On 을 켜는 것 같은 한 칸을 빠뜨리면 그 사실조차 드러나지 않습니다.
  이 파일이 곧 그 기억이고, 배포할 때마다 실제 상태가 여기에 맞춰집니다.

  같은 이름으로 다시 배포하면 새로 만들지 않고 이 정의대로 고칩니다.
  그래서 이미 손으로 만들어 둔 리소스가 있어도 버릴 필요가 없습니다 —
  이름만 맞추면 그대로 이 코드의 관리 아래로 들어옵니다.

  비밀값은 여기 없습니다. @secure() 로 받아 앱 설정에만 들어가고, 저장소에도
  배포 기록에도 남지 않습니다.
*/

@description('환경 이름. 리소스 이름의 꼬리가 됩니다 — prod / dev.')
param environmentName string = 'prod'

@description('앱 이름. 전 세계에서 유일해야 하며 https://<이름>.azurewebsites.net 이 됩니다.')
param webAppName string = 'sigongdata-${environmentName}'

@description('배포 지역. 기사들이 한국에서 접속하므로 가까울수록 업로드가 빠릅니다.')
param location string = resourceGroup().location

@description('저장소 계정 이름. 소문자와 숫자만, 24자 이내.')
@minLength(3)
@maxLength(24)
param storageAccountName string = 'stsigong${environmentName}'

@description('같은 리소스 그룹에 있는 기존 Linux App Service 요금제. Always On을 지원하는 B1 이상이어야 합니다. 새 요금제를 생성하지 않습니다.')
param appServicePlanName string = 'ASP-sigongdataprod-8702'

@description('관리자 로그인 아이디.')
param adminUsername string

@secure()
@description('관리자 비밀번호 해시. npm run hash-password 로 만듭니다.')
param adminPasswordHash string

@secure()
@description('로그인 세션 서명 키. 32바이트 이상의 무작위 값.')
param adminSessionSecret string

@secure()
@description('SharePoint 앱 등록 값 5개를 담은 객체.')
param sharePoint object = {
  tenantId: ''
  clientId: ''
  clientSecret: ''
  siteId: ''
  driveId: ''
}

@secure()
@description('구글 서비스 계정 키 JSON 전체. 비우면 구글시트 연동만 꺼집니다.')
param googleServiceAccountJson string = ''

@description('제출 화면에서 고를 수 있는 시공종류 초기값.')
param constructionTypes string = '백조,인덕션,한샘,이펙스,유로테크'

/* ------------------------------------------------------------------ */
/* 저장소 — 주문건·현장·로그가 사는 곳                                   */
/* ------------------------------------------------------------------ */

/*
  기록을 앱 폴더가 아니라 여기 두는 이유가 이 파일에서 가장 중요합니다.

  App Service 는 새 버전을 배포할 때마다 앱 폴더를 통째로 갈아엎습니다.
  주문건을 앱 안 파일에 두면 배포 한 번에 전부 사라집니다. Table Storage 는
  앱 바깥이라 배포와 무관하게 남습니다.
*/
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // 키가 아니라 신원(관리 ID)으로만 접근하게 합니다. 유출될 비밀값 자체가
    // 없어지므로, 키를 어디에 적어 두었는지 걱정할 일이 사라집니다.
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

/* ------------------------------------------------------------------ */
/* 앱이 사는 컴퓨터                                                     */
/* ------------------------------------------------------------------ */

// existing 참조만 사용하므로 요금제를 생성하거나 가격 등급을 변경하지 않습니다.
// 대상 요금제가 없으면 배포가 실패하며, 대체 요금제를 자동 생성하지 않습니다.
resource plan 'Microsoft.Web/serverfarms@2023-12-01' existing = {
  name: appServicePlanName
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  // azd 가 "이 앱에 sigong-upload 서비스를 배포하라"를 알아보는 표식입니다.
  tags: { 'azd-service-name': 'web' }
  // 시스템 할당 ID — 이 앱에게 Azure 안에서 통하는 신원을 줍니다.
  // 아래 역할 할당이 이 신원에게 저장소 권한을 붙입니다.
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'node server.cjs'
      // 켜 두지 않으면 접속이 없을 때 잠들고, 백그라운드 업로드가 멈춥니다.
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/api/health'
      appSettings: [
        // /home 아래만 재배포에도 살아남습니다. 업로드 중인 임시 파일이
        // 여기 머무르므로, 다른 경로면 배포 중 제출이 통째로 사라집니다.
        { name: 'DATA_DIR', value: '/home/data' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        // App Service 가 올라온 package.json 을 보고 라이브러리를 설치합니다.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }

        { name: 'APP_URL', value: 'https://${webAppName}.azurewebsites.net' }
        { name: 'ADMIN_SECURE_COOKIE', value: 'true' }
        { name: 'ADMIN_USERNAME', value: adminUsername }
        { name: 'ADMIN_PASSWORD_HASH', value: adminPasswordHash }
        { name: 'ADMIN_SESSION_SECRET', value: adminSessionSecret }

        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storage.name }
        { name: 'CONSTRUCTION_TYPES', value: constructionTypes }

        { name: 'SHAREPOINT_TENANT_ID', value: sharePoint.tenantId }
        { name: 'SHAREPOINT_CLIENT_ID', value: sharePoint.clientId }
        { name: 'SHAREPOINT_CLIENT_SECRET', value: sharePoint.clientSecret }
        { name: 'SHAREPOINT_SITE_ID', value: sharePoint.siteId }
        { name: 'SHAREPOINT_DRIVE_ID', value: sharePoint.driveId }

        { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', value: googleServiceAccountJson }
        { name: 'MICROSOFT_REDIRECT_URI', value: 'https://${webAppName}.azurewebsites.net/api/admin/settings/microsoft/callback' }
        { name: 'GOOGLE_REDIRECT_URI', value: 'https://${webAppName}.azurewebsites.net/api/admin/google/callback' }
      ]
    }
  }
}

/* ------------------------------------------------------------------ */
/* 앱 → 저장소 권한                                                     */
/* ------------------------------------------------------------------ */

/*
  Storage Table Data Contributor.

  연결 문자열을 앱 설정에 적어 두는 방법도 있지만, 그러면 그 비밀값이 포털
  화면과 배포 기록과 누군가의 메모장에 동시에 존재하게 됩니다. 관리 ID 는
  적어 둘 것이 없습니다 — Azure 가 "이 앱이 맞다"를 직접 보증합니다.
*/
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource storageAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  // 이름이 결정적이어야 다시 배포해도 중복 할당이 생기지 않습니다.
  name: guid(storage.id, web.id, tableContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      tableContributorRoleId
    )
    principalId: web.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output webAppName string = web.name
output webAppUrl string = 'https://${web.properties.defaultHostName}'
output storageAccountName string = storage.name
output healthCheckUrl string = 'https://${web.properties.defaultHostName}/api/health'
