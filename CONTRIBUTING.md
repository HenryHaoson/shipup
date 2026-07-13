# Contributing

Changes should preserve these invariants:

- stdout is machine-readable when `--output json` is selected;
- progress and diagnostics go to stderr;
- GET requests may retry, unsafe writes do not retry unless the provider
  explicitly defines an idempotent processing state;
- `--dry-run` performs no network requests;
- credentials and authorization headers never appear in tests or fixtures;
- provider behavior is covered with mocked transport or local package fixtures.
- package changes keep `npm audit` free of known production and development
  dependency vulnerabilities.

Before submitting a change, run:

```bash
npm run check
npm run security
npm test
npm run pack:check
npm audit
```
