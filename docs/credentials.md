# Credentials

The credentials file contains one section per provider:

```yaml
harmony:
  app_id: "1234567890"
  package_name: com.example.app
  service_account: ${AGC_SERVICE_ACCOUNT_JSON}

huawei:
  app_id: "123456789"
  package_name: com.example.app
  service_account: @./agc-service-account.json

ios:
  app_id: "1234567890"
  bundle_id: com.example.app
  issuer_id: ${ASC_ISSUER_ID}
  key_id: ${ASC_KEY_ID}
  private_key: ${ASC_PRIVATE_KEY}
```

Values can be:

- literal strings;
- `${NAME}` references to environment variables;
- `@relative/path` references resolved relative to the credentials file.

The lookup order is:

1. `--creds <path>`;
2. `SHIPUP_CREDS`;
3. `~/.config/shipup/credentials.yaml`.

Keep the file outside application repositories and set restrictive permissions:

```bash
chmod 600 ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/keys/*
```

AGC HarmonyOS and Huawei Android commands can share one developer-level Service
Account when that account has access to both apps. iOS uses an App Store Connect
API key with the minimum role required for the selected commands.
