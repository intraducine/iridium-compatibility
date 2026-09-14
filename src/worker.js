const RATING_LABELS = {
  1: "Doesn't Run",
  2: "Launches, Unplayable",
  3: "Playable with Issues",
  4: "Runs Well",
  5: "Runs Great",
};

const MAX_BODY_BYTES = 16_384;
const VOTER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const IRIDIUM_PROJECT_URL = "https://raw.githubusercontent.com/intraducine/iridium/main/iridium/apps/ios/project.yml";
const IRIDIUM_VERSION_FALLBACK = "0.1.0";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (!url.pathname.startsWith("/api/")) {
        const response = await env.ASSETS.fetch(request);
        return secureAssetResponse(response);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: apiHeaders() });
      }

      return await routeApi(request, env, ctx, url);
    } catch (error) {
      console.error("Unhandled application error", error instanceof Error ? error.message : "unknown");
      return jsonError("Unexpected server error.", 500, "internal_error");
    }
  },
};

async function routeApi(request, env, ctx, url) {
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/config") {
    return json({
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
      adminEnabled: adminConfigured(env),
      ratingLabels: RATING_LABELS,
      currentIridiumVersion: await getCurrentIridiumVersion(env),
    });
  }

  if (request.method === "GET" && path === "/api/health") {
    return json({
      ok: true,
      writeProtectionConfigured: writeProtectionConfigured(env),
      adminConfigured: adminConfigured(env),
    });
  }

  if (request.method === "GET" && path === "/api/games") return listGames(env, url);
  if (request.method === "GET" && path === "/api/me/votes") return listMyVotes(request, env);
  if (request.method === "GET" && path === "/api/me/ratings") return listMyRatings(request, env);
  if (request.method === "GET" && path === "/api/steam/search") return searchSteam(request, env, url);
  if (request.method === "POST" && path === "/api/games") return createOrRequestGame(request, env, ctx);

  const voteMatch = path.match(/^\/api\/games\/(\d+)\/vote$/);
  if (request.method === "POST" && voteMatch) {
    return changeVote(request, env, ctx, Number(voteMatch[1]));
  }

  const ratingMatch = path.match(/^\/api\/games\/(\d+)\/rating$/);
  if (request.method === "POST" && ratingMatch) {
    return changeRating(request, env, ctx, Number(ratingMatch[1]));
  }

  const reportsMatch = path.match(/^\/api\/games\/(\d+)\/reports$/);
  if (request.method === "GET" && reportsMatch) {
    return listGameReports(env, url, Number(reportsMatch[1]));
  }

  if (request.method === "GET" && path === "/api/admin/login") return adminLogin(request, env);
  if (request.method === "GET" && path === "/api/admin/callback") return adminCallback(request, env, url);
  if (request.method === "GET" && path === "/api/admin/session") return adminSession(request, env);

  if (request.method === "POST" && path === "/api/admin/logout") {
    if (!sameOrigin(request)) return jsonError("Invalid origin.", 403, "invalid_origin");
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie("ir_admin", "/") });
  }

  const adminGameMatch = path.match(/^\/api\/admin\/games\/(\d+)$/);
  if (adminGameMatch && request.method === "DELETE") {
    return adminDeleteGame(request, env, Number(adminGameMatch[1]));
  }

  return jsonError("Not found.", 404, "not_found");
}

async function listGames(env, url) {
  const currentIridiumVersion = await getCurrentIridiumVersion(env);
  const sort = url.searchParams.get("sort") === "new" ? "new" : "popular";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 50);
  const offset = clampInt(url.searchParams.get("offset"), 0, 10_000, 0);
  const where = q ? "WHERE g.name LIKE ? ESCAPE '\\' COLLATE NOCASE" : "";
  const orderSql = sort === "new"
    ? "g.created_at DESC, g.id DESC"
    : "vote_count DESC, g.created_at DESC, g.id DESC";

  const query = `
    SELECT
      g.id,
      g.steam_app_id,
      g.name,
      g.image_url,
      g.created_at,
      g.updated_at,
      COALESCE(v.vote_count, 0) AS vote_count,
      COALESCE(r.rating_count, 0) AS rating_count,
      r.avg_rating,
      r.last_rating_at
    FROM games g
    LEFT JOIN (
      SELECT game_id, COUNT(*) AS vote_count
      FROM votes
      GROUP BY game_id
    ) v ON v.game_id = g.id
    LEFT JOIN (
      SELECT game_id,
             COUNT(*) AS rating_count,
             AVG(rating) AS avg_rating,
             MAX(updated_at) AS last_rating_at
      FROM compatibility_ratings
      WHERE iridium_version = ?
      GROUP BY game_id
    ) r ON r.game_id = g.id
    ${where}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `;

  const binds = [currentIridiumVersion];
  if (q) binds.push(`%${escapeLike(q)}%`);
  binds.push(limit + 1, offset);

  const result = await env.DB.prepare(query).bind(...binds).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  return json({
    currentIridiumVersion,
    games: rows.map(publicGame),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  });
}

async function listMyVotes(request, env) {
  const voterId = request.headers.get("X-Voter-ID") || "";
  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (!env.RATE_LIMIT_SECRET) return configError();

  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  const result = await env.DB.prepare(
    "SELECT game_id FROM votes WHERE voter_hash = ? ORDER BY game_id"
  ).bind(voterHash).all();

  return json({ gameIds: (result.results || []).map((row) => Number(row.game_id)) });
}

async function listMyRatings(request, env) {
  const voterId = request.headers.get("X-Voter-ID") || "";
  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (!env.RATE_LIMIT_SECRET) return configError();

  const currentIridiumVersion = await getCurrentIridiumVersion(env);
  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  const result = await env.DB.prepare(`
    SELECT game_id, rating, iridium_version, notes, updated_at
    FROM compatibility_ratings
    WHERE voter_hash = ? AND iridium_version = ?
    ORDER BY game_id
  `).bind(voterHash, currentIridiumVersion).all();

  return json({
    currentIridiumVersion,
    ratings: (result.results || []).map((row) => ({
      gameId: Number(row.game_id),
      rating: Number(row.rating),
      iridiumVersion: String(row.iridium_version || ""),
      notes: String(row.notes || ""),
      updatedAt: Number(row.updated_at || 0),
    })),
  });
}

async function searchSteam(request, env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2 || q.length > 60) {
    return jsonError("Search must be between 2 and 60 characters.", 400, "invalid_search");
  }

  const voterId = request.headers.get("X-Voter-ID") || "";
  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (!env.RATE_LIMIT_SECRET) return configError();

  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  const ipHash = await requestIpHash(request, env.RATE_LIMIT_SECRET);

  if (!(await env.SEARCH_RATE_LIMITER.limit({ key: voterHash })).success) {
    return rateLimited("Too many searches. Try again in a minute.");
  }
  if (!(await env.SEARCH_IP_RATE_LIMITER.limit({ key: ipHash })).success) {
    return rateLimited("This network is sending too many searches. Try again in a minute.");
  }

  const steamUrl = new URL("https://store.steampowered.com/api/storesearch/");
  steamUrl.searchParams.set("term", q);
  steamUrl.searchParams.set("l", "english");
  steamUrl.searchParams.set("cc", "US");

  const upstream = await fetch(steamUrl, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 900, cacheEverything: true },
  });

  if (!upstream.ok) return jsonError("Steam search is temporarily unavailable.", 502, "steam_unavailable");

  const data = await upstream.json();
  const games = Array.isArray(data.items)
    ? data.items.slice(0, 10).map((item) => ({
        steamAppId: Number(item.id),
        name: cleanText(item.name, 200),
        imageUrl: safeSteamImage(item.tiny_image),
      })).filter((item) => Number.isSafeInteger(item.steamAppId) && item.steamAppId > 0 && item.name)
    : [];

  return json({ games });
}

async function createOrRequestGame(request, env, ctx) {
  if (!sameOrigin(request)) return jsonError("Invalid origin.", 403, "invalid_origin");
  const body = await readJson(request);
  if (!body.ok) return body.response;

  const { steamAppId, voterId, turnstileToken } = body.value;
  if (!Number.isSafeInteger(steamAppId) || steamAppId <= 0 || steamAppId > 2_147_483_647) {
    return jsonError("Invalid Steam App ID.", 400, "invalid_steam_app_id");
  }
  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (!writeProtectionConfigured(env)) return configError();

  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  if (!(await env.REQUEST_RATE_LIMITER.limit({ key: voterHash })).success) {
    return rateLimited("Too many game requests. Try again in a minute.");
  }

  const turnstile = await verifyTurnstile(turnstileToken, env);
  if (!turnstile.ok) return turnstile.response;

  const quota = await consumeQuota(env, ctx, "game-request", voterHash, 10, 86_400);
  if (!quota.allowed) return rateLimited("Daily game-request limit reached.", quota.retryAfter);

  const now = unixNow();
  let game = await env.DB.prepare(
    "SELECT id, steam_app_id, name, image_url, created_at, updated_at FROM games WHERE steam_app_id = ?"
  ).bind(steamAppId).first();
  let existing = Boolean(game);

  if (!game) {
    const steamGame = await fetchSteamGame(steamAppId);
    if (!steamGame) return jsonError("Steam could not confirm that this App ID is a game.", 400, "invalid_steam_game");

    const insertResult = await env.DB.prepare(`
      INSERT OR IGNORE INTO games (steam_app_id, name, image_url, status, created_at, updated_at)
      VALUES (?, ?, ?, 'requested', ?, ?)
    `).bind(steamAppId, steamGame.name, steamGame.imageUrl, now, now).run();

    game = await env.DB.prepare(
      "SELECT id, steam_app_id, name, image_url, created_at, updated_at FROM games WHERE steam_app_id = ?"
    ).bind(steamAppId).first();
    existing = Number(insertResult.meta?.changes || 0) === 0;
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO votes (game_id, voter_hash, created_at) VALUES (?, ?, ?)"
  ).bind(game.id, voterHash, now).run();

  const voteCount = await countVotes(env, game.id);
  return json({
    game: publicGame({ ...game, vote_count: voteCount, rating_count: 0, avg_rating: null, last_rating_at: null }),
    voted: true,
    existing,
  }, existing ? 200 : 201);
}

async function changeVote(request, env, ctx, gameId) {
  if (!sameOrigin(request)) return jsonError("Invalid origin.", 403, "invalid_origin");
  if (!Number.isSafeInteger(gameId) || gameId <= 0) return jsonError("Invalid game.", 400, "invalid_game");

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const { voterId, turnstileToken, action } = body.value;

  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (action !== "add" && action !== "remove") return jsonError("Invalid vote action.", 400, "invalid_action");
  if (!writeProtectionConfigured(env)) return configError();

  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  if (!(await env.VOTE_RATE_LIMITER.limit({ key: `vote:${voterHash}` })).success) {
    return rateLimited("Too many vote changes. Try again in a minute.");
  }

  const turnstile = await verifyTurnstile(turnstileToken, env);
  if (!turnstile.ok) return turnstile.response;

  const quota = await consumeQuota(env, ctx, "vote-change", voterHash, 120, 3_600);
  if (!quota.allowed) return rateLimited("Hourly vote-change limit reached.", quota.retryAfter);

  const game = await env.DB.prepare("SELECT id FROM games WHERE id = ?").bind(gameId).first();
  if (!game) return jsonError("Game not found.", 404, "not_found");

  if (action === "add") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO votes (game_id, voter_hash, created_at) VALUES (?, ?, ?)"
    ).bind(gameId, voterHash, unixNow()).run();
  } else {
    await env.DB.prepare("DELETE FROM votes WHERE game_id = ? AND voter_hash = ?")
      .bind(gameId, voterHash).run();
  }

  return json({ gameId, voted: action === "add", voteCount: await countVotes(env, gameId) });
}

async function listGameReports(env, url, gameId) {
  if (!Number.isSafeInteger(gameId) || gameId <= 0) {
    return jsonError("Invalid game.", 400, "invalid_game");
  }

  const game = await env.DB.prepare("SELECT id FROM games WHERE id = ?").bind(gameId).first();
  if (!game) return jsonError("Game not found.", 404, "not_found");

  const currentIridiumVersion = await getCurrentIridiumVersion(env);
  const selectedVersion = cleanVersion(url.searchParams.get("version")) || currentIridiumVersion;
  const limit = clampInt(url.searchParams.get("limit"), 1, 10, 3);
  const offset = clampInt(url.searchParams.get("offset"), 0, 10_000, 0);

  const summaryRow = await env.DB.prepare(`
    SELECT
      COUNT(*) AS rating_count,
      AVG(rating) AS avg_rating,
      MAX(updated_at) AS last_rating_at,
      SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS rating_1,
      SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS rating_2,
      SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS rating_3,
      SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS rating_4,
      SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS rating_5
    FROM compatibility_ratings
    WHERE game_id = ? AND iridium_version = ?
  `).bind(gameId, selectedVersion).first();

  const result = await env.DB.prepare(`
    SELECT rating, iridium_version, notes, updated_at
    FROM compatibility_ratings
    WHERE game_id = ? AND iridium_version = ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(gameId, selectedVersion, limit + 1, offset).all();

  const versionsResult = await env.DB.prepare(`
    SELECT iridium_version, MAX(updated_at) AS last_updated
    FROM compatibility_ratings
    WHERE game_id = ?
    GROUP BY iridium_version
    ORDER BY CASE WHEN iridium_version = ? THEN 0 ELSE 1 END, last_updated DESC
    LIMIT 20
  `).bind(gameId, currentIridiumVersion).all();

  const rows = result.results || [];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();

  const availableVersions = (versionsResult.results || [])
    .map((row) => String(row.iridium_version || ""))
    .filter(Boolean);
  if (!availableVersions.includes(currentIridiumVersion)) availableVersions.unshift(currentIridiumVersion);

  const ratingCount = Number(summaryRow?.rating_count || 0);
  return json({
    currentIridiumVersion,
    selectedVersion,
    availableVersions,
    summary: {
      ratingCount,
      avgRating: summaryRow?.avg_rating == null ? null : roundRating(summaryRow.avg_rating),
      lastRatedAt: summaryRow?.last_rating_at == null ? null : Number(summaryRow.last_rating_at),
      distribution: {
        1: Number(summaryRow?.rating_1 || 0),
        2: Number(summaryRow?.rating_2 || 0),
        3: Number(summaryRow?.rating_3 || 0),
        4: Number(summaryRow?.rating_4 || 0),
        5: Number(summaryRow?.rating_5 || 0),
      },
    },
    reports: rows.map((row) => ({
      rating: Number(row.rating),
      iridiumVersion: String(row.iridium_version || ""),
      notes: String(row.notes || ""),
      updatedAt: Number(row.updated_at || 0),
    })),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  });
}

async function changeRating(request, env, ctx, gameId) {
  if (!sameOrigin(request)) return jsonError("Invalid origin.", 403, "invalid_origin");
  if (!Number.isSafeInteger(gameId) || gameId <= 0) return jsonError("Invalid game.", 400, "invalid_game");

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const { voterId, turnstileToken, action } = body.value;

  if (!validVoterId(voterId)) return jsonError("Invalid voter identifier.", 400, "invalid_voter");
  if (action !== "set" && action !== "remove") return jsonError("Invalid rating action.", 400, "invalid_action");
  if (!writeProtectionConfigured(env)) return configError();

  const currentIridiumVersion = await getCurrentIridiumVersion(env);
  const voterHash = await hmacHex(env.RATE_LIMIT_SECRET, `voter:${voterId}`);
  if (!(await env.VOTE_RATE_LIMITER.limit({ key: `rating:${voterHash}` })).success) {
    return rateLimited("Too many rating changes. Try again in a minute.");
  }

  const turnstile = await verifyTurnstile(turnstileToken, env);
  if (!turnstile.ok) return turnstile.response;

  const quota = await consumeQuota(env, ctx, "rating-change", voterHash, 30, 3_600);
  if (!quota.allowed) return rateLimited("Hourly rating-change limit reached.", quota.retryAfter);

  const game = await env.DB.prepare("SELECT id FROM games WHERE id = ?").bind(gameId).first();
  if (!game) return jsonError("Game not found.", 404, "not_found");

  const now = unixNow();
  let myRating = null;

  if (action === "remove") {
    await env.DB.prepare(
      "DELETE FROM compatibility_ratings WHERE game_id = ? AND voter_hash = ? AND iridium_version = ?"
    ).bind(gameId, voterHash, currentIridiumVersion).run();
  } else {
    const rating = Number(body.value.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonError("Rating must be between 1 and 5.", 400, "invalid_rating");
    }

    const notes = cleanText(body.value.notes, 600);

    await env.DB.prepare(`
      INSERT INTO compatibility_ratings
        (game_id, voter_hash, rating, iridium_version, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, voter_hash, iridium_version) DO UPDATE SET
        rating = excluded.rating,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).bind(gameId, voterHash, rating, currentIridiumVersion, notes, now, now).run();

    myRating = {
      gameId,
      rating,
      iridiumVersion: currentIridiumVersion,
      notes,
      updatedAt: now,
    };
  }

  const summary = await getRatingSummary(env, gameId, currentIridiumVersion);
  return json({ gameId, currentIridiumVersion, ...summary, myRating });
}

async function adminLogin(request, env) {
  if (!adminConfigured(env)) return jsonError("Admin authentication is not configured.", 503, "admin_not_configured");
  if (!env.RATE_LIMIT_SECRET) return configError();

  const key = await requestIpHash(request, env.RATE_LIMIT_SECRET);
  if (!(await env.ADMIN_RATE_LIMITER.limit({ key: `login:${key}` })).success) {
    return rateLimited("Too many login attempts. Try again in a minute.");
  }

  const state = randomToken(24);
  const callback = new URL("/api/admin/callback", request.url).toString();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": cookie("ir_oauth_state", state, 600, "/api/admin/"),
      "Cache-Control": "no-store",
    },
  });
}

async function adminCallback(request, env, url) {
  if (!adminConfigured(env)) return jsonError("Admin authentication is not configured.", 503, "admin_not_configured");

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const cookieState = readCookie(request, "ir_oauth_state");
  if (!code || !state || !cookieState || !constantTimeEqual(state, cookieState)) {
    return jsonError("OAuth state validation failed.", 400, "oauth_state_failed");
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/api/admin/callback", request.url).toString(),
    }),
  });

  if (!tokenResponse.ok) return jsonError("GitHub authentication failed.", 502, "github_oauth_failed");
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) return jsonError("GitHub authentication failed.", 401, "github_oauth_failed");

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "iridium-compatibility",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userResponse.ok) return jsonError("Could not validate GitHub identity.", 401, "github_identity_failed");

  const user = await userResponse.json();
  const login = String(user.login || "").toLowerCase();
  const allowed = String(env.ADMIN_GITHUB_LOGINS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!login || !allowed.includes(login)) {
    return jsonError("This GitHub account is not authorized.", 403, "not_admin");
  }

  const session = await createAdminSession(env.SESSION_SECRET);
  const headers = new Headers({ Location: "/?admin=1", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie("ir_admin", session, 28_800, "/"));
  headers.append("Set-Cookie", clearCookie("ir_oauth_state", "/api/admin/"));
  return new Response(null, { status: 302, headers });
}

async function adminSession(request, env) {
  return json({ authenticated: await isAdmin(request, env), enabled: adminConfigured(env) });
}

async function adminDeleteGame(request, env, gameId) {
  if (!sameOrigin(request)) return jsonError("Invalid origin.", 403, "invalid_origin");
  if (!(await isAdmin(request, env))) return jsonError("Unauthorized.", 401, "unauthorized");

  const limiterKey = await adminLimiterKey(request, env);
  if (!(await env.ADMIN_RATE_LIMITER.limit({ key: limiterKey })).success) {
    return rateLimited("Too many admin actions.");
  }

  const result = await env.DB.prepare("DELETE FROM games WHERE id = ?").bind(gameId).run();
  if (!result.meta?.changes) return jsonError("Game not found.", 404, "not_found");
  return json({ ok: true, gameId });
}

async function fetchSteamGame(steamAppId) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(steamAppId));
  url.searchParams.set("cc", "US");
  url.searchParams.set("l", "english");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const data = await response.json();
  const entry = data[String(steamAppId)];
  if (!entry?.success || !entry.data || entry.data.type !== "game") return null;

  const name = cleanText(entry.data.name, 200);
  if (!name) return null;
  return { name, imageUrl: safeSteamImage(entry.data.header_image) };
}

async function verifyTurnstile(token, env) {
  if (typeof token !== "string" || token.length < 10 || token.length > 4096) {
    return { ok: false, response: jsonError("Human verification is required.", 400, "turnstile_required") };
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token }),
  });

  if (!response.ok) {
    return { ok: false, response: jsonError("Human verification is unavailable.", 502, "turnstile_unavailable") };
  }

  const result = await response.json();
  if (!result.success || (result.action && result.action !== "write")) {
    return { ok: false, response: jsonError("Human verification failed.", 403, "turnstile_failed") };
  }

  return { ok: true };
}

async function consumeQuota(env, ctx, scope, actorHash, limit, windowSeconds) {
  const now = unixNow();
  const bucket = Math.floor(now / windowSeconds);
  const key = `${scope}:${bucket}:${actorHash}`;

  await env.DB.prepare(`
    INSERT INTO quota_counters (key, count, created_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1
  `).bind(key, now).run();

  const row = await env.DB.prepare("SELECT count FROM quota_counters WHERE key = ?").bind(key).first();
  const count = Number(row?.count || 0);
  const retryAfter = Math.max(1, (bucket + 1) * windowSeconds - now);

  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM quota_counters WHERE created_at < ?").bind(now - 172_800).run());
  }

  return { allowed: count <= limit, retryAfter };
}

async function countVotes(env, gameId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM votes WHERE game_id = ?").bind(gameId).first();
  return Number(row?.count || 0);
}

async function getRatingSummary(env, gameId, iridiumVersion) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS rating_count,
           AVG(rating) AS avg_rating,
           MAX(updated_at) AS last_rating_at
    FROM compatibility_ratings
    WHERE game_id = ? AND iridium_version = ?
  `).bind(gameId, iridiumVersion).first();

  return {
    ratingCount: Number(row?.rating_count || 0),
    avgRating: row?.avg_rating == null ? null : roundRating(row.avg_rating),
    lastRatedAt: row?.last_rating_at == null ? null : Number(row.last_rating_at),
  };
}

function publicGame(row) {
  return {
    id: Number(row.id),
    steamAppId: Number(row.steam_app_id),
    name: String(row.name),
    imageUrl: safeSteamImage(row.image_url),
    voteCount: Number(row.vote_count || 0),
    ratingCount: Number(row.rating_count || 0),
    avgRating: row.avg_rating == null ? null : roundRating(row.avg_rating),
    lastRatedAt: row.last_rating_at == null ? null : Number(row.last_rating_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    steamUrl: `https://store.steampowered.com/app/${Number(row.steam_app_id)}/`,
  };
}

function roundRating(value) {
  return Math.round(Number(value) * 10) / 10;
}

async function getCurrentIridiumVersion(env) {
  const configured = cleanVersion(env.CURRENT_IRIDIUM_VERSION);
  if (configured) return configured;

  try {
    const response = await fetch(IRIDIUM_PROJECT_URL, {
      headers: { Accept: "text/plain" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (response.ok) {
      const text = await response.text();
      const match = text.match(/MARKETING_VERSION:\s*["']?([^"'\s#]+)["']?/m);
      const parsed = cleanVersion(match?.[1]);
      if (parsed) return parsed;
    }
  } catch {
    // Transient GitHub failure: use the known project fallback.
  }

  return IRIDIUM_VERSION_FALLBACK;
}

function cleanVersion(value) {
  const version = String(value || "").trim().slice(0, 40);
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(version) ? version : "";
}

async function createAdminSession(secret) {
  const payload = { admin: true, exp: unixNow() + 28_800, nonce: randomToken(16) };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacBase64Url(secret, encoded);
  return `${encoded}.${signature}`;
}

async function isAdmin(request, env) {
  if (!adminConfigured(env)) return false;
  const token = readCookie(request, "ir_admin");
  if (!token) return false;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return false;

  const expected = await hmacBase64Url(env.SESSION_SECRET, encoded);
  if (!constantTimeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    return payload.admin === true && Number(payload.exp) > unixNow();
  } catch {
    return false;
  }
}

async function adminLimiterKey(request, env) {
  const token = readCookie(request, "ir_admin") || "missing";
  return hmacHex(env.RATE_LIMIT_SECRET || env.SESSION_SECRET, `admin:${token}`);
}

function adminConfigured(env) {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.ADMIN_GITHUB_LOGINS && env.SESSION_SECRET);
}

function writeProtectionConfigured(env) {
  return Boolean(env.RATE_LIMIT_SECRET && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

function configError() {
  return jsonError("Server protection is not fully configured yet.", 503, "server_not_configured");
}

async function requestIpHash(request, secret) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return hmacHex(secret, `network:${ip}`);
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function randomToken(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncode(text) {
  return bytesToBase64Url(encoder.encode(text));
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError("Request body is too large.", 413, "body_too_large") };
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: jsonError("Request body is too large.", 413, "body_too_large") };
  }

  try {
    const value = JSON.parse(text || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid");
    return { ok: true, value };
  } catch {
    return { ok: false, response: jsonError("Invalid JSON body.", 400, "invalid_json") };
  }
}

function validVoterId(value) {
  return typeof value === "string" && VOTER_ID_RE.test(value);
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeSteamImage(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    const allowed = url.hostname === "steamstatic.com"
      || url.hostname.endsWith(".steamstatic.com")
      || url.hostname === "steamcdn-a.akamaihd.net";
    return url.protocol === "https:" && allowed ? url.toString() : "";
  } catch {
    return "";
  }
}

function sameOrigin(request) {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function cookie(name, value, maxAge, path) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name, path) {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

function escapeLike(value) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function rateLimited(message, retryAfter = 60) {
  return jsonError(message, 429, "rate_limited", { "Retry-After": String(Math.max(1, Math.ceil(retryAfter))) });
}

function jsonError(message, status, code, extraHeaders = {}) {
  return json({ error: message, code }, status, extraHeaders);
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = apiHeaders();
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function apiHeaders() {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
}

function secureAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: https://*.steamstatic.com https://steamcdn-a.akamaihd.net; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com"
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
