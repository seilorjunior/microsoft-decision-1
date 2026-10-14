# CI/CD and deployment from GitHub

Three workflows live in [.github/workflows](../.github/workflows).

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [ci.yml](../.github/workflows/ci.yml) `checks` | Push and pull request | `npm audit` (high severity), unit tests, syntax checks, package checks, browser tests, Bicep compilation |
| [ci.yml](../.github/workflows/ci.yml) `secret-scan` | Push and pull request | Scans the full Git history with Gitleaks |
| [ci.yml](../.github/workflows/ci.yml) `preview` | Pull request from this repository | Runs `azd provision --preview` against Azure. Skipped until `AZURE_CLIENT_ID` is set |
| [deploy.yml](../.github/workflows/deploy.yml) | Manual | Runs tests, then `azd up`, then the optional billable smoke test |

Dependabot ([dependabot.yml](../.github/dependabot.yml)) proposes weekly updates for npm packages, GitHub Actions, and the browser-test Python package. Actions are pinned to full commit SHAs, and Dependabot keeps those pins current.

## One-time Azure setup for OIDC

Workflows sign in with a federated credential, so no Azure secret is stored in GitHub for authentication.

1. Create or choose a Microsoft Entra app registration for the pipeline.
2. Add two federated credentials on that app:

| Name | Subject |
| --- | --- |
| `pull-request` | `repo:<owner>/<repo>:pull_request` |
| `production` | `repo:<owner>/<repo>:environment:production` |

3. Grant the app **Contributor** and **User Access Administrator** on the subscription, or on the target scope. The template creates a role assignment, so Contributor alone is not enough. Scope these as narrowly as your environment allows.
4. In GitHub, create an environment named `production` and add required reviewers.

## Repository variables and secrets

Variables (Settings, Secrets and variables, Actions, Variables):

| Name | Value |
| --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | From the app registration and subscription |
| `AZURE_ENV_NAME`, `AZURE_LOCATION` | Same as your azd environment |
| `FOUNDRY_LOCATION` | Region for a new Foundry account and model |
| `USE_EXISTING_FOUNDRY` | `true` to reuse a model |
| `EXISTING_FOUNDRY_RESOURCE_GROUP`, `EXISTING_FOUNDRY_ACCOUNT_NAME`, `EXISTING_DEPLOYMENT_NAME` | Used when reusing a model |
| `APP_AUTH_USERNAME` | The shared login username |

Secrets:

| Name | Value |
| --- | --- |
| `APP_AUTH_PASSWORD_HASH` | The SHA-256 hash that `npm run setup-auth` writes to the azd environment |
| `SMOKE_PASSWORD` | The original password, only if you run the post-deploy smoke test |

Do not publish the contents of `.azure/app-login.txt`.

## Smoke test

`scripts/smoke.js` runs after `azd deploy`. It signs in, sends one synthetic ticket, and prints the team, probabilities, policy action, and timings. It makes **one billable inference call**. Skip it with `SKIP_SMOKE_TEST=true`, or untick `run_smoke_test` when starting the deploy workflow.

The `tokenAndOverheadMs` value is total time minus inference HTTP time. Use it, together with `queueWaitMs` and `inferenceHttpMs`, to decide whether any application-side speedup is worth making before changing anything.

## Quota check

`scripts/check-quota.js` runs before provisioning when you create a new Foundry model. It compares the `modelCapacity` default in `infra/main.bicep` with the available regional quota and stops the deployment on a definite shortfall. It is skipped when reusing a model, and it warns instead of failing when the Azure CLI cannot read quota.
