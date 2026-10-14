param location string
param suffix string
param tags object
param modelCapacity int

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: 'ai-decision-${suffix}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'ai-decision-${suffix}'
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: 'decision-1-poc'
  location: location
  // Account child operations must run sequentially to avoid RequestConflict.
  dependsOn: [deployment]
  identity: { type: 'SystemAssigned' }
  properties: { displayName: 'Decision-1 Lab', description: 'Support-ticket decision model PoC' }
}
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: foundry
  name: 'decision-1'
  sku: { name: 'DataZoneStandard', capacity: modelCapacity }
  properties: {
    model: { format: 'Microsoft', name: 'Microsoft-Decision-1', version: '1' }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}
output endpoint string = foundry.properties.endpoint
output accountName string = foundry.name
