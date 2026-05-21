# OAuth Provider Setup

Readest authenticates via four social providers, mounted through
better-auth at `/api/auth/callback/<provider>`. Each provider requires
a developer account and an OAuth app registration. Use this checklist
when provisioning a new environment.

## Redirect URI templates

For every provider, register **all three** of these redirect URIs:

| Surface     | Redirect URI                                                |
| ----------- | ----------------------------------------------------------- |
| Web         | `${BETTER_AUTH_URL}/api/auth/callback/<provider>`           |
| Tauri (desktop) | `http://localhost:<port>/` (port assigned at runtime by the local listener; see `auth/utils/nativeAuth.ts`) |
| Mobile (iOS / Android) | `readest://auth-callback`                       |

`<provider>` is one of `google`, `github`, `discord`, `apple`.

Set `BETTER_AUTH_URL` to the deployed origin (e.g.
`https://readest.app`) — better-auth derives both the callback URL and
the cookie domain from it. For local development use
`http://localhost:3000`.

---

## Google

1. Open https://console.cloud.google.com/apis/credentials.
2. Create a new project (or pick an existing one).
3. **Configure OAuth consent screen** (External, scopes: `email`,
   `profile`, `openid`).
4. **Create credentials → OAuth client ID → Web application**.
5. Add the three Authorized redirect URIs above.
6. Copy `Client ID` and `Client secret` into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

## GitHub

1. Open https://github.com/settings/developers → **OAuth Apps → New OAuth App**.
2. Authorization callback URL: register the web URI; create one app per
   surface if you need distinct callback handling. (GitHub only allows
   one callback per app, so most teams maintain `web`, `desktop`, and
   `mobile` apps separately.)
3. Generate a new client secret.
4. Copy into `.env`:
   ```
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   ```

## Discord

1. Open https://discord.com/developers/applications → **New Application**.
2. **OAuth2 → General → Redirects**: add all three redirect URIs.
3. Save and copy **Client ID** + **Client Secret**:
   ```
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   ```
4. The default scopes (`identify`, `email`) are enough; better-auth
   requests them automatically.

## Apple

Apple Sign In is the fiddliest of the four — it uses a P8 private key,
not a static client secret. Allow days, not hours, for App Store
review.

1. Apple Developer → **Certificates, Identifiers & Profiles**.
2. **Identifiers → App IDs**: create an App ID with Sign In with Apple
   enabled.
3. **Identifiers → Services IDs**: create a Services ID — this is your
   `APPLE_CLIENT_ID`. Register the three redirect URIs under "Web
   Authentication Configuration".
4. **Keys → +**: create a Sign In with Apple key, download the `.p8`,
   note the Key ID and Team ID.
5. Either:
   - **(simple)** Generate a JWT client secret manually and set
     `APPLE_CLIENT_SECRET=<jwt>`. Re-issue every ≤6 months.
   - **(recommended)** Provide the key parts and let better-auth mint
     the JWT (check the better-auth Apple provider docs for the exact
     env-var names supported by the installed version).
6. iOS native flow uses `signIn.idToken({ provider: 'apple', token })`
   with the `identityToken` from `ASAuthorizationAppleIDCredential`;
   see `apps/readest-app/src/app/auth/utils/appleIdAuth.ts`.

---

## Verification checklist

For each provider, after configuring `.env`:

- [ ] Web sign-in succeeds at
      `${BETTER_AUTH_URL}/api/auth/sign-in/social/<provider>`.
- [ ] Tauri desktop sign-in opens the system browser, completes, and
      returns to the local listener.
- [ ] iOS / Android sign-in completes via the `readest://auth-callback`
      deep link.
- [ ] `session.user` carries the expected profile fields (`email`,
      `name`, `image`) after sign-in.
