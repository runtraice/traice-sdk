# Security Policy

Please report vulnerabilities privately to security@runtraice.com.

Do not open public issues for suspected vulnerabilities, leaked credentials, or customer data exposure.

## Supported Versions

Security fixes are published for the latest released major version of each `@traice/*` package.

## Data Handling

Collectors do not send prompts or model outputs by default. Any prompt/output capture must be explicitly enabled by the installing organization.

## Local collector credentials

The collector stores API keys in the native OS credential manager when available. Its config stores a reference, not
the bearer key. Headless systems may use a user-only protected-file fallback; this fallback is not encrypted at rest
and should live on an encrypted disk outside shared backups.

Use `--credential-store keyring` when policy requires native secure storage. Use `TRAICE_API_KEY` for ephemeral
container or managed-secret injection. Never pass API keys through command-line arguments because process listings and
shell history may expose them; prefer `--api-key-stdin`.
