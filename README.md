# Iridium Compatibility

A small anonymous Steam game request and compatibility board for Iridium.

Users can:

- search Steam and request games
- upvote games they want Iridium support for
- submit one compatibility rating per game for each Iridium version
- update or remove their rating for the current version

Compatibility is community-reported instead of maintainer-managed. Votes measure demand; ratings measure how well a game currently runs.

## Compatibility scale

| Rating | Meaning |
| --- | --- |
| Untested | No compatibility reports yet |
| 1 star | Doesn't Run |
| 2 stars | Launches, Unplayable |
| 3 stars | Playable with Issues |
| 4 stars | Runs Well |
| 5 stars | Runs Great |

Ratings are scoped to the exact Iridium version. The Worker reads `MARKETING_VERSION` from the Iridium iOS `project.yml`, and the main game list aggregates only ratings for that current version. When Iridium updates, the displayed compatibility score starts fresh automatically. Older version reports remain available from the report viewer but never influence the current score. A report can also include short notes.

## Stack

- Cloudflare Workers + Static Assets
- Cloudflare D1
- Cloudflare Turnstile
- Cloudflare Worker rate-limit bindings
- Steam Store APIs/CDN
- GitHub OAuth for admin cleanup controls

No personal server is required.

## Initial setup

```bash
npm install
npx wrangler login
npx wrangler d1 create iridium-compatibility --location=enam
```

Put the returned D1 database ID into the `DB` binding in `wrangler.jsonc`, then apply migrations:

```bash
npx wrangler d1 migrations apply DB --remote
```

Create secrets:

```bash
openssl rand -hex 32 | npx wrangler secret put RATE_LIMIT_SECRET
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET
```

Optional GitHub admin login:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ADMIN_GITHUB_LOGINS
```

Deploy:

```bash
npx wrangler deploy
```

## Updating an existing deployment

Pull the changed source while preserving a locally configured `wrangler.jsonc`, then apply any new D1 migrations before deployment:

```bash
git fetch origin
git restore --source=origin/main public/ src/ migrations/ README.md
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

## Abuse protection

Server-side controls are authoritative. The browser also uses debounce/cooldowns for UX.

- Steam search: 30/min per anonymous browser plus a 120/min hashed-network ceiling
- Votes: 30/min burst plus 120/hour
- Ratings: 30/min burst plus 30/hour
- New game requests: 5/min burst plus 10/day
- Admin actions: 60/min plus GitHub OAuth and signed session
- Public writes require Turnstile

The application stores keyed hashes rather than raw browser IDs or raw IP addresses.

## Data model

`games` stores canonical Steam metadata. `votes` stores one lifetime demand vote per anonymous browser identity per game. `compatibility_ratings` stores one compatibility report per anonymous browser identity, game, and Iridium version.

The original `games.status` column remains in the first migration for backwards compatibility with existing D1 databases, but the application no longer exposes or uses maintainer-managed compatibility states.
