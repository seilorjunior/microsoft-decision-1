# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's **Report a vulnerability** option on this repository's Security tab. Do not open a public issue for a security problem. Include the affected file or endpoint, the steps to reproduce, and the impact you observed.

## Scope and known limits

Decision-1 Lab is a single-instance learning PoC, not a production service.

- Authentication is one shared account with no MFA or per-user audit. Anyone with the password can incur inference charges.
- Sessions and rate limiting are held in process memory.
- Use synthetic data only. The app does not persist tickets, but inference requests are sent to Azure AI Foundry.

## Handling secrets

- Never commit `.env`, `.azure/`, passwords, or tokens. `.gitignore` excludes them.
- If a credential is exposed, rotate it with `npm run setup-auth` and apply it with `azd provision`.
- CI scans the full Git history for secrets. Removing a secret from the current files does not remove it from earlier commits.
