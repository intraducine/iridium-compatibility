const state = {
  config: null,
  games: [],
  sort: "popular",
  query: "",
  offset: 0,
  hasMore: false,
  loading: false,
  voted: new Set(),
  ratings: new Map(),
  ratingGame: null,
  reportsGame: null,
  reportsOffset: 0,
  reportsLoading: false,
  reportsHasMore: false,
  reportsVersion: "",
  isAdmin: false,
  turnstileReady: false,
  turnstileWidgetId: null,
  turnstilePending: null,
  writeBusy: false,
  steamAbortController: null,
  clientCooldowns: new Map(),
  toastTimer: null,
};

const els = {};

window.onTurnstileLoad = () => {
  state.turnstileReady = true;
  renderTurnstileIfReady();
};

window.addEventListener("DOMContentLoaded", init);

async function init() {
  Object.assign(els, {
    gamesSection: document.querySelector("#gamesSection"),
    gamesGrid: document.querySelector("#gamesGrid"),
    emptyState: document.querySelector("#emptyState"),
    loadMoreButton: document.querySelector("#loadMoreButton"),
    gameSearch: document.querySelector("#gameSearch"),
    requestButton: document.querySelector("#requestButton"),
    requestDialog: document.querySelector("#requestDialog"),
    requestForm: document.querySelector("#requestForm"),
    closeRequestButton: document.querySelector("#closeRequestButton"),
    steamSearch: document.querySelector("#steamSearch"),
    steamSearchStatus: document.querySelector("#steamSearchStatus"),
    steamResults: document.querySelector("#steamResults"),
    reportsDialog: document.querySelector("#reportsDialog"),
    reportsTitle: document.querySelector("#reportsTitle"),
    reportsSubtitle: document.querySelector("#reportsSubtitle"),
    reportsScore: document.querySelector("#reportsScore"),
    reportsScoreMeta: document.querySelector("#reportsScoreMeta"),
    reportsDistribution: document.querySelector("#reportsDistribution"),
    reportsVersionWrap: document.querySelector("#reportsVersionWrap"),
    reportsVersionSelect: document.querySelector("#reportsVersionSelect"),
    reportsStatus: document.querySelector("#reportsStatus"),
    reportsList: document.querySelector("#reportsList"),
    reportsEmpty: document.querySelector("#reportsEmpty"),
    closeReportsButton: document.querySelector("#closeReportsButton"),
    rateGameButton: document.querySelector("#rateGameButton"),
    loadMoreReportsButton: document.querySelector("#loadMoreReportsButton"),
    ratingDialog: document.querySelector("#ratingDialog"),
    ratingForm: document.querySelector("#ratingForm"),
    ratingTitle: document.querySelector("#ratingTitle"),
    ratingOptions: document.querySelector("#ratingOptions"),
    ratingVersionNotice: document.querySelector("#ratingVersionNotice"),
    ratingNotes: document.querySelector("#ratingNotes"),
    closeRatingButton: document.querySelector("#closeRatingButton"),
    removeRatingButton: document.querySelector("#removeRatingButton"),
    saveRatingButton: document.querySelector("#saveRatingButton"),
    adminButton: document.querySelector("#adminButton"),
    toast: document.querySelector("#toast"),
  });

  bindUi();

  try {
    state.config = await api("/api/config");
    renderTurnstileIfReady();
    renderRatingOptions();
    await Promise.all([loadAdminSession(), loadMyVotes(), loadMyRatings()]);
    await loadGames(true);
  } catch (error) {
    showToast(error.message || "Could not load the compatibility board.");
  }
}

function bindUi() {
  let gameSearchTimer;
  els.gameSearch.addEventListener("input", () => {
    clearTimeout(gameSearchTimer);
    gameSearchTimer = setTimeout(() => {
      state.query = els.gameSearch.value.trim();
      loadGames(true);
    }, 280);
  });

  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sort = button.dataset.sort;
      document.querySelectorAll("[data-sort]").forEach((item) => item.classList.toggle("is-active", item === button));
      loadGames(true);
    });
  });

  els.loadMoreButton.addEventListener("click", () => loadGames(false));
  els.requestButton.addEventListener("click", openRequestDialog);
  els.closeRequestButton.addEventListener("click", closeRequestDialog);
  els.requestForm.addEventListener("submit", (event) => event.preventDefault());

  let steamTimer;
  els.steamSearch.addEventListener("input", () => {
    clearTimeout(steamTimer);
    const query = els.steamSearch.value.trim();
    if (query.length < 2) {
      if (state.steamAbortController) state.steamAbortController.abort();
      els.steamResults.replaceChildren();
      els.steamSearchStatus.textContent = query ? "Type at least 2 characters." : "";
      return;
    }
    steamTimer = setTimeout(() => searchSteam(query), 400);
  });

  els.closeReportsButton.addEventListener("click", closeReportsDialog);
  els.reportsDialog.addEventListener("close", () => {
    state.reportsGame = null;
    state.reportsLoading = false;
  });
  els.rateGameButton.addEventListener("click", () => {
    const game = state.reportsGame;
    if (!game) return;
    els.reportsDialog.close();
    openRatingDialog(game);
  });
  els.loadMoreReportsButton.addEventListener("click", () => loadReports(false));
  els.reportsVersionSelect.addEventListener("change", () => {
    state.reportsVersion = els.reportsVersionSelect.value;
    loadReports(true);
  });

  els.closeRatingButton.addEventListener("click", closeRatingDialog);
  els.ratingForm.addEventListener("submit", saveRating);
  els.removeRatingButton.addEventListener("click", removeRating);

  els.adminButton.addEventListener("click", async () => {
    if (state.isAdmin) {
      try {
        await api("/api/admin/logout", { method: "POST" });
        state.isAdmin = false;
        els.adminButton.textContent = "Admin";
        renderGames();
        showToast("Admin session ended.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }

    if (!state.config?.adminEnabled) {
      showToast("Admin login has not been configured yet.");
      return;
    }
    window.location.assign("/api/admin/login");
  });
}

async function loadGames(reset) {
  if (state.loading) return;
  state.loading = true;
  els.gamesSection.setAttribute("aria-busy", "true");

  if (reset) {
    state.offset = 0;
    state.games = [];
  }

  const params = new URLSearchParams({
    sort: state.sort,
    limit: "50",
    offset: String(state.offset),
  });
  if (state.query) params.set("q", state.query);

  try {
    const data = await api(`/api/games?${params}`);
    if (data.currentIridiumVersion) state.config.currentIridiumVersion = data.currentIridiumVersion;
    state.games.push(...data.games);
    state.hasMore = Boolean(data.hasMore);
    state.offset = data.nextOffset ?? state.offset;
    renderGames();
  } catch (error) {
    showToast(error.message);
  } finally {
    state.loading = false;
    els.gamesSection.setAttribute("aria-busy", "false");
  }
}

function renderGames() {
  const fragment = document.createDocumentFragment();

  for (const game of state.games) {
    const card = document.createElement("article");
    card.className = "game-card";
    card.dataset.gameId = String(game.id);

    card.append(makeSteamImage(game, "game-image"));

    const main = document.createElement("div");
    main.className = "game-main";

    const title = document.createElement("a");
    title.className = "game-title";
    title.href = game.steamUrl;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = game.name;
    main.append(title);

    const compatibility = document.createElement("button");
    compatibility.className = "compatibility-summary";
    compatibility.type = "button";
    compatibility.addEventListener("click", () => openReportsDialog(game));

    const ratingText = document.createElement("span");
    ratingText.className = "rating-text";
    if (game.ratingCount > 0 && game.avgRating != null) {
      const rounded = Math.max(1, Math.min(5, Math.round(game.avgRating)));
      ratingText.textContent = `${stars(rounded)} ${ratingLabel(rounded)}`;
    } else {
      ratingText.textContent = "Untested";
    }

    const ratingMeta = document.createElement("span");
    ratingMeta.className = "rating-meta";
    const currentVersion = state.config?.currentIridiumVersion || "";
    if (game.ratingCount > 0) {
      const reportWord = game.ratingCount === 1 ? "rating" : "ratings";
      ratingMeta.textContent = `${game.ratingCount} ${reportWord}${currentVersion ? ` · v${currentVersion}` : ""}`;
    } else {
      ratingMeta.textContent = currentVersion ? `Rate v${currentVersion}` : "Rate compatibility";
    }

    compatibility.append(ratingText, ratingMeta);
    main.append(compatibility);

    if (state.isAdmin) main.append(buildAdminRow(game));
    card.append(main);

    const voted = state.voted.has(game.id);
    const voteButton = document.createElement("button");
    voteButton.className = `vote-button${voted ? " is-voted" : ""}`;
    voteButton.type = "button";
    voteButton.setAttribute("aria-pressed", String(voted));
    voteButton.setAttribute("aria-label", `${voted ? "Remove vote from" : "Vote for"} ${game.name}`);

    const arrow = document.createElement("span");
    arrow.className = "vote-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "▲";
    const count = document.createElement("span");
    count.textContent = String(game.voteCount);
    voteButton.append(arrow, count);
    voteButton.addEventListener("click", () => toggleVote(game, voteButton));
    card.append(voteButton);

    fragment.append(card);
  }

  els.gamesGrid.replaceChildren(fragment);
  els.emptyState.hidden = state.games.length !== 0;
  els.loadMoreButton.hidden = !state.hasMore;
}

function buildAdminRow(game) {
  const row = document.createElement("div");
  row.className = "admin-row";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button button-danger admin-delete";
  remove.textContent = "Delete game";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${game.name}, its votes, and its ratings?`)) return;
    remove.disabled = true;
    try {
      await api(`/api/admin/games/${game.id}`, { method: "DELETE" });
      state.games = state.games.filter((item) => item.id !== game.id);
      state.voted.delete(game.id);
      state.ratings.delete(game.id);
      renderGames();
      showToast("Game deleted.");
    } catch (error) {
      remove.disabled = false;
      showToast(error.message);
    }
  });

  row.append(remove);
  return row;
}

function renderRatingOptions() {
  const labels = state.config?.ratingLabels || {};
  const fragment = document.createDocumentFragment();

  for (let rating = 5; rating >= 1; rating -= 1) {
    const label = document.createElement("label");
    label.className = "rating-option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "compatibilityRating";
    input.value = String(rating);

    const starsEl = document.createElement("span");
    starsEl.className = "rating-option-stars";
    starsEl.textContent = stars(rating);

    const text = document.createElement("span");
    text.textContent = labels[rating] || ratingLabel(rating);

    label.append(input, starsEl, text);
    fragment.append(label);
  }

  els.ratingOptions.replaceChildren(fragment);
}

async function loadMyVotes() {
  try {
    const data = await api("/api/me/votes", { headers: { "X-Voter-ID": voterId() } });
    state.voted = new Set(data.gameIds.map(Number));
  } catch (error) {
    if (error.status !== 503) showToast(error.message);
  }
}

async function loadMyRatings() {
  try {
    const data = await api("/api/me/ratings", { headers: { "X-Voter-ID": voterId() } });
    state.ratings = new Map(data.ratings.map((item) => [Number(item.gameId), item]));
  } catch (error) {
    if (error.status !== 503 && error.status !== 500) showToast(error.message);
  }
}

async function loadAdminSession() {
  try {
    const data = await api("/api/admin/session");
    state.isAdmin = Boolean(data.authenticated);
    els.adminButton.textContent = state.isAdmin ? "Log out" : "Admin";
    if (new URL(location.href).searchParams.has("admin")) {
      history.replaceState({}, "", location.pathname + location.hash);
    }
  } catch {
    state.isAdmin = false;
  }
}

function openRequestDialog() {
  if (!state.config?.turnstileSiteKey) {
    showToast("Voting protection has not been configured yet.");
    return;
  }
  els.steamSearch.value = "";
  els.steamResults.replaceChildren();
  els.steamSearchStatus.textContent = "";
  els.requestDialog.showModal();
  setTimeout(() => els.steamSearch.focus(), 0);
}

function closeRequestDialog() {
  if (state.steamAbortController) state.steamAbortController.abort();
  els.requestDialog.close();
}

function openReportsDialog(game) {
  state.reportsGame = game;
  state.reportsOffset = 0;
  state.reportsHasMore = false;
  state.reportsVersion = state.config?.currentIridiumVersion || "";
  els.reportsTitle.textContent = game.name;
  els.reportsList.replaceChildren();
  els.reportsEmpty.hidden = true;
  els.loadMoreReportsButton.hidden = true;
  els.reportsVersionWrap.hidden = true;
  els.reportsStatus.textContent = "";
  updateRateGameButton();
  renderReportSummary(game, null, state.reportsVersion);
  els.reportsDialog.showModal();
  loadReports(true);
}

function closeReportsDialog() {
  els.reportsDialog.close();
}

async function loadReports(reset) {
  const game = state.reportsGame;
  if (!game || state.reportsLoading) return;

  state.reportsLoading = true;
  const offset = reset ? 0 : state.reportsOffset;
  const limit = reset ? 3 : 5;
  const version = state.reportsVersion || state.config?.currentIridiumVersion || "";

  if (reset) {
    state.reportsOffset = 0;
    els.reportsList.replaceChildren();
    els.reportsEmpty.hidden = true;
    els.reportsStatus.textContent = "Loading…";
  }
  els.loadMoreReportsButton.disabled = true;

  try {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (version) params.set("version", version);
    const data = await api(`/api/games/${game.id}/reports?${params}`);
    if (state.reportsGame?.id !== game.id) return;

    if (data.currentIridiumVersion) state.config.currentIridiumVersion = data.currentIridiumVersion;
    state.reportsVersion = data.selectedVersion || state.config.currentIridiumVersion || version;
    renderVersionChoices(data.availableVersions || [], state.reportsVersion, data.currentIridiumVersion);
    renderReportSummary(game, data.summary, state.reportsVersion);
    appendReports(data.reports || []);
    state.reportsHasMore = Boolean(data.hasMore);
    state.reportsOffset = data.nextOffset ?? (offset + (data.reports?.length || 0));
    els.loadMoreReportsButton.hidden = !state.reportsHasMore;
    els.reportsEmpty.hidden = els.reportsList.children.length !== 0;
    els.reportsStatus.textContent = "";
    updateRateGameButton();
  } catch (error) {
    if (state.reportsGame?.id === game.id) {
      els.reportsStatus.textContent = "Could not load reports";
      showToast(error.message);
    }
  } finally {
    state.reportsLoading = false;
    els.loadMoreReportsButton.disabled = false;
  }
}

function renderVersionChoices(versions, selectedVersion, currentVersion) {
  const unique = [...new Set([currentVersion, ...versions].filter(Boolean))];
  const fragment = document.createDocumentFragment();
  for (const version of unique) {
    const option = document.createElement("option");
    option.value = version;
    option.textContent = version === "legacy"
      ? "Legacy reports"
      : `Iridium ${version}${version === currentVersion ? " (current)" : ""}`;
    option.selected = version === selectedVersion;
    fragment.append(option);
  }
  els.reportsVersionSelect.replaceChildren(fragment);
  els.reportsVersionWrap.hidden = unique.length <= 1;
}

function updateRateGameButton() {
  const game = state.reportsGame;
  if (!game) return;
  const currentVersion = state.config?.currentIridiumVersion || "";
  const viewingCurrent = !state.reportsVersion || state.reportsVersion === currentVersion;
  if (viewingCurrent) {
    els.rateGameButton.textContent = state.ratings.has(game.id) ? "Edit your rating" : "Rate this game";
  } else {
    els.rateGameButton.textContent = currentVersion ? `Rate current v${currentVersion}` : "Rate current version";
  }
}

function renderReportSummary(game, summary, selectedVersion) {
  const currentVersion = state.config?.currentIridiumVersion || "";
  const viewingCurrent = !selectedVersion || selectedVersion === currentVersion;
  const count = summary ? Number(summary.ratingCount || 0) : (viewingCurrent ? Number(game.ratingCount || 0) : 0);
  const average = summary?.avgRating == null ? (viewingCurrent ? game.avgRating : null) : Number(summary.avgRating);
  if (summary && viewingCurrent) applyRatingSummary(game, summary);

  if (count > 0 && average != null) {
    const rounded = Math.max(1, Math.min(5, Math.round(average)));
    els.reportsScore.textContent = `${stars(rounded)} ${average.toFixed(1)}`;
    els.reportsScoreMeta.textContent = ratingLabel(rounded);
  } else {
    els.reportsScore.textContent = "Untested";
    els.reportsScoreMeta.textContent = "";
  }

  const versionLabel = selectedVersion === "legacy"
    ? "legacy reports"
    : selectedVersion ? `Iridium ${selectedVersion}` : "this version";
  els.reportsSubtitle.textContent = count > 0
    ? `${count} ${count === 1 ? "rating" : "ratings"} · ${versionLabel}`
    : `No ratings for ${versionLabel}`;

  if (!summary?.distribution || count === 0) {
    els.reportsDistribution.hidden = true;
    els.reportsDistribution.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let rating = 5; rating >= 1; rating -= 1) {
    const value = Number(summary.distribution[rating] || 0);
    const row = document.createElement("div");
    row.className = "distribution-row";
    const label = document.createElement("span");
    label.textContent = `${rating}★`;
    const progress = document.createElement("progress");
    progress.max = count;
    progress.value = value;
    progress.setAttribute("aria-label", `${rating} star ratings: ${value}`);
    const total = document.createElement("span");
    total.textContent = String(value);
    row.append(label, progress, total);
    fragment.append(row);
  }
  els.reportsDistribution.replaceChildren(fragment);
  els.reportsDistribution.hidden = false;
}

function appendReports(reports) {
  const fragment = document.createDocumentFragment();
  for (const report of reports) {
    const item = document.createElement("article");
    item.className = "report-item";
    const heading = document.createElement("div");
    heading.className = "report-heading";
    const score = document.createElement("span");
    score.className = "report-score";
    score.textContent = `${stars(report.rating)} ${ratingLabel(report.rating)}`;
    const date = document.createElement("span");
    date.className = "report-date";
    date.textContent = report.updatedAt ? formatShortDate(report.updatedAt) : "";
    heading.append(score, date);
    item.append(heading);
    if (report.notes) {
      const notes = document.createElement("p");
      notes.className = "report-notes";
      notes.textContent = report.notes;
      item.append(notes);
    }
    fragment.append(item);
  }
  els.reportsList.append(fragment);
}

function openRatingDialog(game) {
  if (!state.config?.turnstileSiteKey) {
    showToast("Rating protection has not been configured yet.");
    return;
  }

  state.ratingGame = game;
  els.ratingTitle.textContent = game.name;
  els.ratingForm.reset();
  const currentVersion = state.config?.currentIridiumVersion || "";
  els.ratingVersionNotice.textContent = currentVersion
    ? `This rating applies to Iridium ${currentVersion}.`
    : "This rating applies to the current Iridium version.";

  const existing = state.ratings.get(game.id);
  if (existing) {
    const input = els.ratingForm.querySelector(`input[name="compatibilityRating"][value="${existing.rating}"]`);
    if (input) input.checked = true;
    els.ratingNotes.value = existing.notes || "";
    els.removeRatingButton.hidden = false;
    els.saveRatingButton.textContent = "Update rating";
  } else {
    els.removeRatingButton.hidden = true;
    els.saveRatingButton.textContent = "Submit rating";
  }

  els.ratingDialog.showModal();
}

function closeRatingDialog() {
  state.ratingGame = null;
  els.ratingDialog.close();
}

async function saveRating(event) {
  event.preventDefault();
  const game = state.ratingGame;
  if (!game) return;

  const selected = els.ratingForm.querySelector('input[name="compatibilityRating"]:checked');
  if (!selected) {
    showToast("Choose a compatibility rating.");
    return;
  }

  if (!clientGate(`rating-${game.id}`, 2_000)) {
    showToast("Please wait before changing this rating again.");
    return;
  }

  els.saveRatingButton.disabled = true;
  try {
    const data = await protectedWrite((turnstileToken) => api(`/api/games/${game.id}/rating`, {
      method: "POST",
      body: JSON.stringify({
        voterId: voterId(),
        turnstileToken,
        action: "set",
        rating: Number(selected.value),
        notes: els.ratingNotes.value.trim(),
      }),
    }));

    if (data.myRating) state.ratings.set(game.id, data.myRating);
    applyRatingSummary(game, data);
    closeRatingDialog();
    renderGames();
    showToast("Compatibility rating saved.");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.saveRatingButton.disabled = false;
  }
}

async function removeRating() {
  const game = state.ratingGame;
  if (!game || !state.ratings.has(game.id)) return;
  if (!clientGate(`rating-${game.id}`, 2_000)) {
    showToast("Please wait before changing this rating again.");
    return;
  }

  els.removeRatingButton.disabled = true;
  try {
    const data = await protectedWrite((turnstileToken) => api(`/api/games/${game.id}/rating`, {
      method: "POST",
      body: JSON.stringify({
        voterId: voterId(),
        turnstileToken,
        action: "remove",
      }),
    }));

    state.ratings.delete(game.id);
    applyRatingSummary(game, data);
    closeRatingDialog();
    renderGames();
    showToast("Compatibility rating removed.");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.removeRatingButton.disabled = false;
  }
}

function applyRatingSummary(game, data) {
  game.ratingCount = Number(data.ratingCount || 0);
  game.avgRating = data.avgRating == null ? null : Number(data.avgRating);
  game.lastRatedAt = data.lastRatedAt == null ? null : Number(data.lastRatedAt);
}

async function searchSteam(query) {
  if (!clientGate("steam-search", 350)) return;
  if (state.steamAbortController) state.steamAbortController.abort();
  state.steamAbortController = new AbortController();
  els.steamSearchStatus.textContent = "Searching Steam…";
  els.steamResults.replaceChildren();

  try {
    const data = await api(`/api/steam/search?q=${encodeURIComponent(query)}`, {
      headers: { "X-Voter-ID": voterId() },
      signal: state.steamAbortController.signal,
    });
    renderSteamResults(data.games);
    els.steamSearchStatus.textContent = data.games.length ? `${data.games.length} result${data.games.length === 1 ? "" : "s"}` : "No Steam games found.";
  } catch (error) {
    if (error.name === "AbortError") return;
    els.steamSearchStatus.textContent = error.message;
  }
}

function renderSteamResults(games) {
  const fragment = document.createDocumentFragment();
  for (const game of games) {
    const row = document.createElement("div");
    row.className = "steam-result";
    row.append(makeSteamImage(game, "steam-result-image"));

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "steam-result-name";
    name.textContent = game.name;
    const id = document.createElement("div");
    id.className = "steam-result-id";
    id.textContent = `App ${game.steamAppId}`;
    info.append(name, id);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-primary";
    button.textContent = "Vote";
    button.addEventListener("click", () => requestSteamGame(game, button));

    row.append(info, button);
    fragment.append(row);
  }
  els.steamResults.replaceChildren(fragment);
}

function makeSteamImage(game, className) {
  const image = document.createElement("img");
  image.className = className;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";

  const urls = [
    game.imageUrl || "",
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`,
    `https://steamcdn-a.akamaihd.net/steam/apps/${game.steamAppId}/header.jpg`,
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  let index = 0;
  image.src = urls[0] || "";
  image.addEventListener("error", () => {
    index += 1;
    if (index < urls.length) image.src = urls[index];
    else image.hidden = true;
  });
  return image;
}

async function requestSteamGame(game, button) {
  if (!clientGate("game-request", 4_000)) {
    showToast("Please wait a few seconds before another request.");
    return;
  }

  button.disabled = true;
  try {
    const data = await protectedWrite((turnstileToken) => api("/api/games", {
      method: "POST",
      body: JSON.stringify({ steamAppId: game.steamAppId, voterId: voterId(), turnstileToken }),
    }));

    state.voted.add(data.game.id);
    closeRequestDialog();
    showToast(data.existing ? "Vote added to the existing request." : "Game requested and vote added.");
    await loadGames(true);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function toggleVote(game, button) {
  const key = `vote-${game.id}`;
  if (!clientGate(key, 1_500)) {
    showToast("Please wait before changing this vote again.");
    return;
  }

  const currentlyVoted = state.voted.has(game.id);
  button.disabled = true;
  try {
    const data = await protectedWrite((turnstileToken) => api(`/api/games/${game.id}/vote`, {
      method: "POST",
      body: JSON.stringify({
        voterId: voterId(),
        turnstileToken,
        action: currentlyVoted ? "remove" : "add",
      }),
    }));

    if (data.voted) state.voted.add(game.id);
    else state.voted.delete(game.id);
    game.voteCount = data.voteCount;
    renderGames();
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
}

async function protectedWrite(callback) {
  if (state.writeBusy) throw new AppError("Another action is still being processed.", 429, "client_busy");
  state.writeBusy = true;
  try {
    const token = await getTurnstileToken();
    return await callback(token);
  } finally {
    resetTurnstile();
    state.writeBusy = false;
  }
}

function renderTurnstileIfReady() {
  if (!state.turnstileReady || !state.config?.turnstileSiteKey || state.turnstileWidgetId !== null) return;
  state.turnstileWidgetId = window.turnstile.render("#turnstile-container", {
    sitekey: state.config.turnstileSiteKey,
    action: "write",
    execution: "execute",
    appearance: "interaction-only",
    theme: "dark",
    callback: (token) => settleTurnstile(null, token),
    "error-callback": () => settleTurnstile(new Error("Human verification failed to load.")),
    "expired-callback": () => settleTurnstile(new Error("Human verification expired. Try again.")),
    "timeout-callback": () => settleTurnstile(new Error("Human verification timed out. Try again.")),
  });
}

async function getTurnstileToken() {
  await waitForTurnstile();
  if (state.turnstileWidgetId === null) throw new AppError("Human verification is not configured.", 503, "turnstile_not_ready");
  if (state.turnstilePending) throw new AppError("Human verification is already running.", 429, "turnstile_busy");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => settleTurnstile(new Error("Human verification timed out. Try again.")), 30_000);
    state.turnstilePending = { resolve, reject, timeout };
    window.turnstile.execute(state.turnstileWidgetId);
  });
}

function settleTurnstile(error, token) {
  const pending = state.turnstilePending;
  if (!pending) return;
  clearTimeout(pending.timeout);
  state.turnstilePending = null;
  if (error) pending.reject(error);
  else pending.resolve(token);
}

function resetTurnstile() {
  if (state.turnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.reset(state.turnstileWidgetId); } catch { /* no-op */ }
  }
}

async function waitForTurnstile() {
  renderTurnstileIfReady();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (state.turnstileReady) {
      renderTurnstileIfReady();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new AppError("Human verification did not load. Refresh and try again.", 503, "turnstile_not_ready");
}

function stars(rating) {
  const value = Math.max(1, Math.min(5, Number(rating) || 1));
  return `${"★".repeat(value)}${"☆".repeat(5 - value)}`;
}

function ratingLabel(rating) {
  return state.config?.ratingLabels?.[rating] || ({
    1: "Doesn't Run",
    2: "Launches, Unplayable",
    3: "Playable with Issues",
    4: "Runs Well",
    5: "Runs Great",
  })[rating] || "Untested";
}

function formatShortDate(unixSeconds) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(unixSeconds * 1000));
}

function clientGate(key, cooldownMs) {
  const now = Date.now();
  const availableAt = state.clientCooldowns.get(key) || 0;
  if (now < availableAt) return false;
  state.clientCooldowns.set(key, now + cooldownMs);
  return true;
}

function voterId() {
  const key = "iridium_voter_id";
  let value = localStorage.getItem(key);
  if (!isUuidV4(value)) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}

function isUuidV4(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  let data = {};
  try { data = await response.json(); } catch { /* empty response */ }

  if (!response.ok) {
    const error = new AppError(data.error || `Request failed (${response.status}).`, response.status, data.code || "request_failed");
    error.retryAfter = Number(response.headers.get("Retry-After") || 0);
    throw error;
  }
  return data;
}

class AppError extends Error {
  constructor(message, status = 0, code = "error") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = String(message || "Something went wrong.");
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4_000);
}
