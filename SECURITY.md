# Security

## Secrets

No production credentials belong in this repository. Keep all private values in Cloudflare Worker secrets using `wrangler secret put`.

Required for protected public writes:

- `RATE_LIMIT_SECRET`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET`

Required for admin login:

- `SESSION_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `ADMIN_GITHUB_LOGINS`

Do not reuse `RATE_LIMIT_SECRET` and `SESSION_SECRET`.

## Data minimization

Public voting and compatibility reporting do not require an account. The database stores a keyed hash of a random browser identifier rather than the identifier itself. The application does not persist raw IP addresses, email addresses, Steam identities, OAuth access tokens, or GitHub identities with votes or compatibility ratings.

A compatibility report may contain an optional Iridium version and short notes. These are associated only with the anonymous keyed browser hash. Public game rows expose aggregate rating statistics, not the browser identity behind a report.

GitHub OAuth data is used only to decide whether the current login is included in the configured admin allowlist. After authorization, the application creates its own signed session that does not contain the GitHub username.

## Abuse controls

Public write endpoints require valid Cloudflare Turnstile tokens. Short-window limits are enforced with Cloudflare Worker rate-limit bindings, and longer write quotas are enforced in D1. Frontend throttles exist only to improve UX.

## Application controls

- Parameterized D1 queries
- Server-side Steam metadata verification
- Strict body-size limits
- UUID, App ID, and rating validation
- Same-origin checks on mutations
- OAuth state validation
- HMAC-signed admin sessions
- HttpOnly, Secure, SameSite admin cookies
- CSP and other browser security headers
- No permissive CORS policy

## Reporting a vulnerability

Do not publish exploit details in a public issue. Contact the project maintainers through a private channel available on the main Iridium project.
