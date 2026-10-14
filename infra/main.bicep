targetScope = 'subscription'

@minLength(1)
@maxLength(40)
param environmentName string

param location string

@description('Reuse an existing account in this subscription without deploying or resizing its models.')
param useExistingFoundry bool = false
param existingFoundryResourceGroup string = ''
param existingFoundryAccountName string = ''
param existingDeploymentName string = 'decision-1'

@description('Shared PoC login username. Generate credentials with npm run setup-auth.')
@minLength(1)
@maxLength(64)
param appAuthUsername string

@secure()
@description('SHA-256 hash of a cryptographically random app password. Never pass the plaintext password.')
@minLength(64)
@maxLength(64)
param appAuthPasswordHash string

@description('Must support Microsoft-Decision-1 DataZoneStandard and have available quota.')
param foundryLocation string = 'swedencentral'

@minValue(1)
@maxValue(60)
param modelCapacity int = 60

var tags = { 'azd-env-name': environmentName }
var suffix = uniqueString(subscription().id, environmentName, location)

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}-${suffix}'
  location: location
  tags: tags
}

resource existingFoundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = if (useExistingFoundry) {
  name: existingFoundryAccountName
  scope: resourceGroup(existingFoundryResourceGroup)
}

module foundry 'foundry.bicep' = if (!useExistingFoundry) {
  name: 'foundry'
  scope: rg
  params: {
    location: foundryLocation
    suffix: suffix
    tags: tags
    modelCapacity: modelCapacity
  }
}

var foundryEndpoint = useExistingFoundry ? existingFoundry!.properties.endpoint : foundry!.outputs.endpoint
var deploymentName = useExistingFoundry ? existingDeploymentName : 'decision-1'

module resources 'resources.bicep' = {
  name: 'decision-lab'
  scope: rg
  params: {
    location: location
    suffix: suffix
    tags: tags
    appAuthUsername: appAuthUsername
    appAuthPasswordHash: appAuthPasswordHash
    foundryEndpoint: foundryEndpoint
    deploymentName: deploymentName
  }
}

module inferenceRole 'inference-role.bicep' = {
  name: 'inference-access'
  scope: resourceGroup(useExistingFoundry ? existingFoundryResourceGroup : rg.name)
  params: {
    accountName: useExistingFoundry ? existingFoundryAccountName : foundry!.outputs.accountName
    principalId: resources.outputs.principalId
  }
}

output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_ENDPOINT string = foundryEndpoint
output DEPLOYMENT_NAME string = deploymentName
output AZURE_WEB_NAME string = resources.outputs.webName
output SERVICE_WEB_ENDPOINT string = resources.outputs.webEndpoint
