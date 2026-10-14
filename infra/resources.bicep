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
  // Fixed single instance. Sessions and request pacing are process-local, so no autoscale setting exists.
  sku: { name: 'B1', tier: 'Basic', size: 'B1', family: 'B', capacity: 1 }
  properties: {
    reserved: true
    elasticScaleEnabled: false
    perSiteScaling: false
    zoneRedundant: false
  }
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
  }
}

resource webConfig 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: web
  name: 'web'
  properties: {
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
  }
}

resource webSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: web
  name: 'appsettings'
  properties: {
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'true'
    AZURE_ENDPOINT: foundryEndpoint
    DEPLOYMENT_NAME: deploymentName
    REQUEST_INTERVAL_MS: '2000'
    // Replaces an instance after repeated failed pings; it matters only if the app is ever scaled out.
    WEBSITE_HEALTHCHECK_MAXPINGFAILURES: '5'
    APP_AUTH_USERNAME: appAuthUsername
    APP_AUTH_PASSWORD_HASH: appAuthPasswordHash
  }
}

output principalId string = web.identity.principalId
output webName string = web.name
output webEndpoint string = 'https://${web.properties.defaultHostName}'
