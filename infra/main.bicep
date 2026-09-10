/*
  azd 진입점.

  리소스 그룹을 만들고, 그 안의 실제 리소스는 resources.bicep 에 맡깁니다.
  azd 는 구독 단위에서 시작하기를 기대하므로 이 한 겹이 필요합니다.
*/

targetScope = 'subscription'

@minLength(1)
@description('환경 이름. azd 가 물어봅니다 — prod / dev.')
param environmentName string

@minLength(1)
@description('배포 지역. 기사들이 한국에서 접속하므로 가까울수록 업로드가 빠릅니다.')
param location string

@description('관리자 로그인 아이디.')
param adminUsername string

@secure()
@description('관리자 비밀번호 해시. npm run hash-password 로 만듭니다.')
param adminPasswordHash string

@secure()
@description('로그인 세션 서명 키. 32바이트 이상의 무작위 값.')
param adminSessionSecret string

@secure()
param sharePointTenantId string = ''
@secure()
param sharePointClientId string = ''
@secure()
param sharePointClientSecret string = ''
@secure()
param sharePointSiteId string = ''
@secure()
param sharePointDriveId string = ''
@secure()
param googleServiceAccountJson string = ''

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  // 포털에서 이미 만든 그룹과 같은 이름입니다. 이름이 같으면 새로 만들지
  // 않고 그 그룹을 그대로 씁니다.
  name: 'sigongdata-${environmentName}'
  location: location
  tags: {
    'azd-env-name': environmentName
  }
}

module resources 'resources.bicep' = {
  scope: rg
  name: 'resources'
  params: {
    environmentName: environmentName
    location: location
    adminUsername: adminUsername
    adminPasswordHash: adminPasswordHash
    adminSessionSecret: adminSessionSecret
    sharePoint: {
      tenantId: sharePointTenantId
      clientId: sharePointClientId
      clientSecret: sharePointClientSecret
      siteId: sharePointSiteId
      driveId: sharePointDriveId
    }
    googleServiceAccountJson: googleServiceAccountJson
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output WEB_APP_NAME string = resources.outputs.webAppName
output WEB_APP_URL string = resources.outputs.webAppUrl
output HEALTH_CHECK_URL string = resources.outputs.healthCheckUrl
