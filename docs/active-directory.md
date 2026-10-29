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

## Configuration

| Variable | Example | Notes |
| --- | --- | --- |
| `LDAP_URL` | `ldaps://dc01.corp.example.com,ldaps://dc02.corp.example.com` | Tried in order. `ldap://` is refused unless `LDAP_STARTTLS=true`. |
| `LDAP_BASE_DN` | `DC=corp,DC=example,DC=com` | Search base for users and the group |
| `LDAP_BIND_DN` | `svc-rev-bind@corp.example.com` | Read-only service account (UPN or DN) |
| `LDAP_BIND_PASSWORD` / `LDAP_BIND_PASSWORD_FILE` | | Service account password, or a file containing it |
| `LDAP_ALLOWED_GROUP` | `Rev-Users` | Group name or DN; empty allows any enabled account |
| `LDAP_DOMAIN` | `corp.example.com` | Shown on the login page; derived from the base DN if unset |
| `LDAP_CA_FILE` | `/config/ldap-ca.pem` | PEM of the AD CS root. Without it, the system trust store is used. |
| `LDAP_TLS_INSECURE` | `false` | Skip certificate verification (testing only) |
| `LDAP_SYNC_MINUTES` | `15` | `0` disables the periodic re-check |

With Docker Compose, put these in `.env`. Put the CA certificate in `./config/ldap-ca.pem` (mounted read-only at `/config`), then run `docker compose up -d`.

## Getting the AD CS root certificate

Domain controllers usually don't send the root in the TLS handshake. An enterprise CA publishes it in the directory, and the service account can read it there:

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
| `Active Directory is unreachable right now` (HTTP 503) | Rev cannot reach or verify any DC: DNS, firewall, or a CA mismatch. See the `LDAP server unreachable` lines in `docker compose logs rev`. |
| `LDAP service account bind rejected` in the logs | Wrong `LDAP_BIND_DN` or `LDAP_BIND_PASSWORD`, or the service account is disabled or expired. |
