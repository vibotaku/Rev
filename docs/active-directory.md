# Active Directory sign-in

Rev can let people sign in with their Active Directory account over LDAPS. Local email/password accounts keep working alongside it, for example as a break-glass admin.

## How it works

- **Sign-in.** People enter their username (`jdoe`), UPN (`jdoe@corp.example.com`), `CORP\jdoe`, or email, plus their AD password. Rev:
  1. finds the account with a read-only **service account**,
  2. verifies the password by binding as the user over TLS,
  3. checks that the account is enabled and a member of the **allowed group** (nested groups count).
- **First sign-in** creates the Rev account (role: member), keyed to the AD `objectGUID`, so renames keep working. Name, email, and username are refreshed from AD on every sign-in.
- **Existing local accounts** with the same email are linked to the AD account. Their local password keeps working.
- **Periodic re-check** (every `LDAP_SYNC_MINUTES`, default 15). Accounts that were deleted, disabled, or removed from the group are **suspended**: they are signed out and their agents stop working. A suspended account is restored automatically once AD allows it again.
  - A Rev admin's own "Disable" is never undone by AD.
  - If AD is unreachable, nothing changes.
  - If every AD account would be suspended at once (a misconfiguration, such as a wrong base DN), the run refuses and logs an error instead.
- **Admin role.** The admin role is managed in Rev (Admin page), not by AD groups.
- **AD-managed fields.** For AD accounts, the name and password can only be changed in AD, and admins cannot issue reset links for them.

## Configuration: Admin → Active Directory

Admins configure everything on the **Active Directory** tab of the Admin page. Saved settings apply immediately, with no restart:

| Setting | Notes |
| --- | --- |
| Allow sign-in | Turns directory sign-in on or off. Local accounts are never affected. |
| Domain controllers | One `ldaps://host` per line, tried in order. `ldap://` is refused unless StartTLS is on. |
| Base DN | Search base for people and the group, e.g. `DC=corp,DC=example,DC=com` |
| Bind account and password | Read-only service account (UPN or DN). The password is stored **encrypted** (AES-256-GCM) and never sent back to the browser. Leave the field empty to keep it. |
| Allowed group | Name or DN; nested groups count. Empty allows every enabled account. |
| Sign-in domain | Shown on the login page and accepted as `user@domain`. Derived from the base DN if empty. |
| CA certificate | PEM of the AD CS root. **Fetch from directory** reads it from AD (see below). |
| Verify TLS / StartTLS | Keep verification on. StartTLS is only for `ldap://` URLs. |
| Re-check every N minutes | Periodic re-check; `0` turns it off |

The tab also provides:

- **Test connection.** Runs against the unsaved form. For each DC it checks TLS and the service-account bind, the base DN, and the allowed group (with its member count). It can optionally try a real sign-in with a username and password, which are not stored.
- **Save.** Runs the same test first and refuses to save a configuration that fails; **Save anyway** overrides.
- **Sync now and last sync.** Shows when the last re-check ran and what it suspended or restored.
- **Directory accounts.** Lists everyone who has signed in (active, suspended by AD, or disabled in Rev) and the group members who haven't signed in yet.

### Environment variables (initial import only)

If the database has no AD settings yet, Rev imports `LDAP_URL`, `LDAP_BASE_DN`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` / `LDAP_BIND_PASSWORD_FILE`, `LDAP_ALLOWED_GROUP`, `LDAP_DOMAIN`, `LDAP_CA_FILE`, `LDAP_STARTTLS`, `LDAP_TLS_INSECURE`, and `LDAP_SYNC_MINUTES` once at startup. After that the database wins. If the variables are still set, the tab shows a warning; remove them from `.env`.

### Encryption key

Secrets stored in the database are encrypted with `REV_SECRET_KEY` (32 bytes, base64 or hex). If that isn't set, Rev uses a key file it creates in the data directory (`secret.key`, mode 600). `deploy/backup.sh` includes that file. Without it, a restored database can't decrypt the bind password, and you would need to re-enter it on the tab.

## Getting the AD CS root certificate

Domain controllers usually don't send the root in the TLS handshake. An enterprise CA publishes it in the directory. **Fetch from directory** on the Active Directory tab reads it with the bind account. That read can't verify TLS (the CA is what's missing), so the tab shows the SHA-256 fingerprint: compare it with `certutil -ca.cert` on the CA before clicking **Trust**. To do it by hand:

```bash
ldapsearch -LLL -x -H ldaps://dc01.corp.example.com -D svc-rev-bind@corp.example.com -W \
  -b "CN=<CA name>,CN=AIA,CN=Public Key Services,CN=Services,CN=Configuration,DC=corp,DC=example,DC=com" \
  -s base cACertificate
```

Base64-decode the value into a PEM. Check the fingerprint against the CA (`certutil -ca.cert` on the CA). Confirm that `openssl s_client -connect dc01.corp.example.com:636 -CAfile ldap-ca.pem` reports `Verify return code: 0`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Sign-in group "…" does not exist in the directory` | Create the group, or fix `LDAP_ALLOWED_GROUP`. It is looked up again on the next sign-in. |
| `Not a member of …` | Add the user (or one of their groups) to the allowed group. |
| `Active Directory is unreachable right now` (HTTP 503) | Rev cannot reach or verify any DC: DNS, firewall, or a CA mismatch. **Test connection** on the Active Directory tab says which. |
| `LDAP service account bind rejected` in the logs | Wrong `LDAP_BIND_DN` or `LDAP_BIND_PASSWORD`, or the service account is disabled or expired. |
