param location string
param suffix string
param tags object
param appAuthUsername string
@secure()
param appAuthPasswordHash string
param foundryEndpoint string
param deploymentName string

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: 'plan-decision-${suffix}'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic', capacity: 1 }
  properties: { reserved: true }
}

resource web 'Microsoft.Web/sites@2024-11-01' = {
  name: 'app-decision-${suffix}'
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server.js'
      alwaysOn: true
      healthCheckPath: '/health'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      ipSecurityRestrictionsDefaultAction: 'Allow'
      ipSecurityRestrictions: []
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      scmIpSecurityRestrictions: []
      scmIpSecurityRestrictionsUseMain: false
      appSettings: [
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'AZURE_ENDPOINT', value: foundryEndpoint }
        { name: 'DEPLOYMENT_NAME', value: deploymentName }
        { name: 'REQUEST_INTERVAL_MS', value: '61000' }
        { name: 'APP_AUTH_USERNAME', value: appAuthUsername }
        { name: 'APP_AUTH_PASSWORD_HASH', value: appAuthPasswordHash }
      ]
    }
  }
}

output principalId string = web.identity.principalId
output webName string = web.name
output webEndpoint string = 'https://${web.properties.defaultHostName}'
