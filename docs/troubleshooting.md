# Troubleshooting

Problems seen while running or deploying Decision-1 Lab, with the action that resolves each one.

## Application

| Symptom | Action |
| --- | --- |
| App login fails | Read your private `.azure/app-login.txt`; it is not your Azure login. The form needs the original password, never the `APP_AUTH_PASSWORD_HASH` value. Rotate with `npm run setup-auth`, then apply with `azd provision`. |
| Session expires | Sign in again; restarts clear in-memory sessions. |
| Login is throttled | Wait for the one-minute window to end. Proxy users may share a window. |
| Azure authentication fails | Run `az login` locally; verify the subscription and inference role. Hosted apps use managed identity. |
| Foundry HTTP 403 | Check inference RBAC/network access and allow role-assignment propagation. |
| Foundry HTTP 404 | Check the resource root endpoint and actual deployment name. |
| HTTP 429 | Inspect queue status and upstream rate-limit metadata; wait and retry manually. If it recurs, raise `REQUEST_INTERVAL_MS`. |
| Network failure/timeout | Check connectivity; the inference HTTP timeout is 60 seconds. |
| Port already in use | Change `PORT` in local `.env`. |

## Provisioning and deployment

| Symptom | Action |
| --- | --- |
| No model quota, or the pre-provision check reports insufficient quota | Request quota, set `FOUNDRY_LOCATION` to a supported region with available quota, or reuse an existing deployment (`USE_EXISTING_FOUNDRY=true`). |
| `InsufficientQuota` with used equal to the limit | Another deployment already holds the regional quota. Quota is per subscription, region, and SKU. Reuse that deployment or free it. |
| Foundry project provisioning returns `RequestConflict` | The Foundry template serializes model and project operations on the account. Wait for any other account operation to finish, then rerun `azd up` in the same environment. Do not delete a successful model deployment or create a new environment just to retry. |
| Foundry provisioning returns `FlagMustBeSetForRestore` | The account is soft-deleted even if its resource group no longer exists. Recreate the original group and recover the account with `az cognitiveservices account recover`. Verify recovered deployments before retrying. Purge only after explicitly deciding to discard recoverable resources. |
| Recovered Foundry account updates report a soft-deleted backing workspace | If the recovered model is healthy, Option A can deploy the app without modifying the account or creating a project. This does not recover the backing workspace. If the account shares the app's resource group, deleting that group also deletes the recovered account, even in reuse mode. |
| `azd up` fails after deployment with a smoke test error | The app deployed, but the live inference call failed. Read the message: a login error means `.azure/app-login.txt` does not match the deployed hash; an HTTP 403 means the managed-identity role has not propagated yet. Rerun `node scripts/smoke.js` after fixing. Set `SKIP_SMOKE_TEST=true` to skip the billable call. |
| The quota check prints "could not run and was skipped" | The Azure CLI failed to run, often because of a broken CLI extension. Provisioning continues and Azure validates quota itself. Fix the CLI to restore the early check. |
| Azure CLI reports access denied on a `cliextensions` folder | A locked extension folder prevents the CLI from loading. Close other processes using it, or reinstall the extension. |

## Provisioning previews

`azd provision --preview` can list changes that do not exist. Two lines are expected for the web app and can be ignored:

```text
+ properties.siteConfig.localMySqlEnabled: false
+ properties.siteConfig.netFrameworkVersion: "v4.6"
```

Azure returns these defaults on its own and the preview compares them against nothing. Declaring them in Bicep does not remove them. Any other change in the preview is real.
