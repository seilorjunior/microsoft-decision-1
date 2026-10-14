# Contributing

Decision-1 Lab is a learning PoC. Small, focused changes are welcome.

## Setup

```powershell
npm ci
npm test
npm run check
```

Browser tests are optional locally and run in CI:

```powershell
pip install -r requirements-browser.txt
python -m playwright install chromium
npm run test-browser
```

## Before opening a pull request

- Run `npm test`, `npm run check`, `npm run build`, and `npm run check-package`.
- Run `az bicep build --file infra/main.bicep` when you change `infra/`.
- Add or update a test for any behavior you change. Tests use injected stubs and must not call Azure.
- Use synthetic data only. Never commit `.env`, `.azure/`, credentials, tickets, or real resource identifiers.
- Update the README or `docs/` when behavior or deployment steps change.

## Scope

The app is a single instance by design. Changes that add state across instances, or per-user accounts, need a design discussion first. See Scaling limits in the README.

Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
