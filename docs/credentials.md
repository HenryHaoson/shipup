# Credentials

The default credential file is `~/.config/shipup/credentials.yaml`. Override it
with `SHIPUP_CREDS` or `--creds <path>`. A single file may contain `android`,
`harmony`, `huawei`, and `ios` sections; a provider-only file without the outer
section is also accepted by Android and iOS commands.

Values can be literal strings, `${ENVIRONMENT_VARIABLE}` references, or
`@relative/file` references resolved from the credential file directory.

## Android multi-market

```yaml
android:
  package_name: com.example.app
  channels:
    huawei:
      app_id: "..."
      client_id: ${HW_ID}
      client_secret: ${HW_SECRET}
      # Optional legacy-app organizer data; both fields are required together.
      registered_id_type: "1" # 1 company, 2 individual, 3 organization
      registered_id_number: ${HUAWEI_REGISTERED_ID_NUMBER}
    honor:   { app_id: "...", client_id: ${HONOR_ID}, client_secret: ${HONOR_SECRET} }
    oppo:    { app_id: "...", client_id: ${OPPO_ID}, client_secret: ${OPPO_SECRET} }
    vivo:    { app_id: "...", access_key: ${VIVO_AK}, access_secret: ${VIVO_SK} }
    xiaomi:  { user_name: ${MI_USER}, password: ${MI_PASSWORD}, rsa_modulus: ${MI_RSA} }
    samsung: { app_id: "...", service_account: ${SS_ACCOUNT}, private_key: "@./samsung.pem" }
    qq:      { app_id: "...", user_id: "...", access_secret: ${QQ_SECRET} }
    meizu:   { access_key: ${MZ_AK}, access_secret: ${MZ_SK} }
```

Only channels selected by `--upload` or `--channel` are validated.

Huawei's `registered_id_type` and `registered_id_number` are optional and must
be configured together. They identify the application organizer, not the app's
filing number. The identifier is sent only in the provider request body and is
redacted from errors and diagnostics.

## HarmonyOS and Huawei compatibility commands

```yaml
harmony:
  app_id: "..."
  package_name: com.example.app
  service_account: "@./agc-service-account.json"

huawei:
  app_id: "..."
  package_name: com.example.app
  service_account: "@./agc-service-account.json"
```

These commands accept an AppGallery Connect service account or API client
credentials. The `shipup android ... huawei` adapter instead uses the Android
market credentials under `android.channels.huawei`.

## App Store Connect

```yaml
ios:
  app_id: "..."
  bundle_id: com.example.app
  issuer_id: ${ASC_ISSUER_ID}
  key_id: ${ASC_KEY_ID}
  private_key: "@./AuthKey_XXXXXXXXXX.p8"
  team_id: ${APPLE_TEAM_ID}
```

`app_id` is optional when commands receive `--bundle-id`. `team_id` is used by
upload workflows that require it.

## Storage rules

Keep credentials and referenced key files outside application repositories:

```bash
chmod 600 ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/*.pem ~/.config/shipup/*.p8
```

`shipup` warns about group/world-readable credential files on Unix systems.
Use the minimum provider role required for the selected command.
