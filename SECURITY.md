# Security policy

## Credentials

Never commit provider credentials, private keys, release packages, or
application-specific release metadata. Store local credentials under
`~/.config/shipup` with mode `0600`, or inject them through a CI secret store.

Credential values support literal strings, `${ENVIRONMENT_VARIABLE}`, and
`@path/to/file`. Environment variables and external files are preferred for
private keys and service-account JSON.

`--dry-run` does not send network requests, but it still resolves and validates
the selected credential file. Run it only in an environment allowed to access
those credentials.

## Logs

Do not upload raw debug logs without reviewing them. `shipup` redacts common
authorization tokens, private-key blocks, secret-like JSON fields, URL query
parameters, and long opaque values across both core and multi-market adapters,
but provider responses can change without notice.

## Reporting a vulnerability

Do not open a public issue containing credentials or private provider output.
Use GitHub's private vulnerability reporting form in the repository Security
tab. Do not include secrets in a public issue.

## Supported versions

Security fixes are provided for the latest released minor version only.
