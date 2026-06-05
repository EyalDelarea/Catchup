/**
 * app.js — Glacier UI · WhatsApp Sum
 *
 * View state machine: feed ↔ detail{group}
 * Routing: history.pushState + popstate (phone Back works)
 * Teardown: EventSource is closed when leaving detail view
 *
 * Pass 1 scope: US1 (feed + catch-up stream + copy) + US4 (health + stale banner)
 * Pass 2 scope: US2 (mode chips + time-range sheet) + US3 (per-group history)
 *
 * Structure:
 *   1. Imports & globals
 *   2. Routing (pushState / popstate)
 *   3. Health polling (US4)
 *   4. Feed view (US1 — group list, search)
 *   5. Detail view (US1 — catch-up stream; US2 — mode chips + range sheet; US3 — history)
 *   6. Helper utilities
 *   7. Bootstrap
 */

import { getGroups, getStatus, getSummaries, summarizeStream } from "./lib/api.js";
import { formatAgo, presetToSince, validateRangeInput } from "./lib/time.js";
import { renderMarkdown } from "./lib/markdown.js";
import { deriveHealth } from "./lib/health.js";
import { loaderProgress } from "./lib/progress.js";
import { shouldShowUpdatingChip, shouldShowStreamError, shouldStartBackgroundRefresh } from "./lib/open-state.js";

/* ── 1. Globals ──────────────────────────────────────────── */

/** The #app mount point. */
const app = document.getElementById("app");

/** The global stale banner element. */
const staleBanner = document.getElementById("stale-banner");

/** Currently open EventSource (cleaned up on view change). */
let activeEventSource = null;

/** Health poll interval id. */
let healthInterval = null;

/** Cached groups list (populated once; refreshed on feed render). */
let cachedGroups = [];

/* ── 2. Routing ──────────────────────────────────────────── */

/**
 * Navigate to a view, pushing a history entry.
 * @param {"feed"|"detail"} view
 * @param {string} [group] — required for "detail"
 */
function navigate(view, group) {
  if (view === "detail" && group) {
    history.pushState({ view: "detail", group }, "", `#group=${encodeURIComponent(group)}`);
    renderDetail(group, true);
  } else {
    history.pushState({ view: "feed" }, "", location.pathname);
    renderFeed();
  }
}

/** Handle browser Back / Forward. */
window.addEventListener("popstate", (e) => {
  teardownStream();
  const state = e.state;
  if (state?.view === "detail" && state.group) {
    renderDetail(state.group, false);
  } else {
    renderFeed();
  }
});

/* ── 3. Health polling (US4) ─────────────────────────────── */

/**
 * Update the health pill (wherever it lives in the current DOM)
 * and the global stale banner.
 */
function applyHealth(healthy) {
  // Update stale banner
  if (healthy) {
    staleBanner.hidden = true;
  } else {
    staleBanner.hidden = false;
  }

  // Update all health pills in the DOM
  document.querySelectorAll(".health-pill").forEach((pill) => {
    const dot = pill.querySelector(".health-pill__dot");
    if (healthy) {
      pill.classList.remove("health-pill--bad");
      pill.textContent = "";
      if (dot) pill.appendChild(dot);
      else {
        const d = document.createElement("span");
        d.className = "health-pill__dot";
        pill.appendChild(d);
      }
      pill.appendChild(document.createTextNode("המערכת תקינה"));
    } else {
      pill.classList.add("health-pill--bad");
      pill.textContent = "";
      const d = document.createElement("span");
      d.className = "health-pill__dot";
      pill.appendChild(d);
      pill.appendChild(document.createTextNode("לא מגיב"));
    }
  });
}

/**
 * Poll /api/status once and update UI.
 * On fetch failure, treats as unhealthy.
 */
async function pollHealth() {
  try {
    const status = await getStatus();
    applyHealth(deriveHealth(status));
  } catch {
    applyHealth(false);
  }
}

/** Start health polling (5 s interval + immediate first call). */
function startHealthPolling() {
  if (healthInterval) return; // already running
  pollHealth();
  healthInterval = setInterval(pollHealth, 5_000);
}

/* ── 4. Feed view ────────────────────────────────────────── */

/**
 * Render the feed (group list) into #app.
 * Re-fetches groups from the API each time.
 */
async function renderFeed() {
  teardownStream();

  // Skeleton placeholder while loading
  app.innerHTML = buildFeedShell("", true);

  let groups;
  try {
    groups = await getGroups();
    cachedGroups = groups;
  } catch {
    app.innerHTML = buildFeedShell("");
    app.querySelector(".feed-list").innerHTML =
      `<p class="error-state">שגיאה בטעינת הקבוצות. אנא רעננו את הדף.</p>`;
    return;
  }

  app.innerHTML = buildFeedShell("");
  renderGroupList(groups, "");
  wireSearchInput();
}

/** Build the static feed shell HTML (header, search, empty list). */
function buildFeedShell(searchValue, loading = false) {
  return `
    <div class="feed-header">
      <div class="feed-top">
        <div>
          <div class="feed-kicker">on the go</div>
          <h1 class="feed-title">הקבוצות שלי</h1>
        </div>
        <div class="health-pill" role="status" aria-live="polite">
          <span class="health-pill__dot"></span>
          <span>טוען…</span>
        </div>
      </div>
    </div>
    <div class="search-wrap">
      <input
        id="search-input"
        class="search-input"
        type="search"
        placeholder="🔍  חיפוש קבוצה…"
        value="${escHtml(searchValue)}"
        aria-label="חיפוש קבוצה"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
      />
    </div>
    <div class="feed-list" id="feed-list" role="list" aria-live="polite">
      ${loading ? buildSkeletonCards(3) : ""}
    </div>
  `;
}

/** Re-render just the card list based on a filter string. */
function renderGroupList(groups, filter) {
  const list = document.getElementById("feed-list");
  if (!list) return;

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? groups.filter((g) => g.name.toLowerCase().includes(q))
    : groups;

  if (filtered.length === 0) {
    list.innerHTML = `<p class="empty-state">${
      q ? "לא נמצאו קבוצות תואמות." : "אין שיחות שמורות."
    }</p>`;
    return;
  }

  list.innerHTML = filtered
    .map((g, i) => buildGroupCard(g, i))
    .join("");

  // Wire CTA buttons
  list.querySelectorAll(".group-card__cta").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.group;
      navigate("detail", group);
    });
  });
}

/** Build a single group card's HTML. */
function buildGroupCard(group, index) {
  const ago = formatAgo(group.lastMessageAt);
  const isFresh = ago && group.lastMessageAt
    ? (Date.now() - new Date(group.lastMessageAt).getTime()) < 24 * 60 * 60 * 1000
    : false;
  const muted = !isFresh;

  const dotClass = muted ? "group-card__dot group-card__dot--muted" : "group-card__dot";
  const cardClass = muted ? "glass-card group-card group-card--muted" : "glass-card group-card";
  const delay = `animation-delay:${index * 55}ms`;

  const metaParts = [];
  if (ago) metaParts.push(ago);
  if (group.messageCount != null) metaParts.push(`${Number(group.messageCount).toLocaleString("he-IL")} הודעות`);
  const metaText = metaParts.join(" · ");

  return `
    <div class="${cardClass}" style="${delay}" role="listitem">
      <div class="group-card__name">${escHtml(formatGroupName(group.name))}</div>
      <div class="group-card__meta">
        ${ago ? `<span class="${dotClass}"></span>` : ""}
        <span>${escHtml(metaText)}</span>
      </div>
      <button
        class="group-card__cta"
        data-group="${escHtml(group.name)}"
        aria-label="סכם מה שפספסתי בקבוצה ${escHtml(formatGroupName(group.name))}"
      >סכם מה שפספסתי ›</button>
    </div>
  `;
}

/** Wire the search input to filter the cached group list. */
function wireSearchInput() {
  const input = document.getElementById("search-input");
  if (!input) return;
  input.addEventListener("input", () => {
    renderGroupList(cachedGroups, input.value);
    // Re-wire buttons after re-render
    const list = document.getElementById("feed-list");
    if (list) {
      list.querySelectorAll(".group-card__cta").forEach((btn) => {
        btn.addEventListener("click", () => navigate("detail", btn.dataset.group));
      });
    }
  });
}

/** Build placeholder skeleton cards for loading state. */
function buildSkeletonCards(count) {
  return Array.from({ length: count }, () => `
    <div class="glass-card group-card group-card--loading" aria-hidden="true">
      <div class="skeleton" style="width:55%;height:16px;margin-bottom:10px"></div>
      <div class="skeleton" style="width:75%"></div>
    </div>
  `).join("");
}

/* ── 5. Detail view ──────────────────────────────────────── */

/**
 * State for the current detail view.
 * Allows sharing between event handlers without closures leaking.
 */
const detailState = {
  group: null,
  started: 0,
  syncingTimer: null,
  syncingStart: 0,
  summaryText: "",
  phase: "idle", // idle | syncing | streaming | done | cached | empty | error
  activeChip: "catchup", // "catchup" | "24h" | "3d" | "week" | "month" | "range"
  /** The pre-cached summary text displayed instantly on open (null = cold open). */
  cachedSummaryText: null,
  /** Whether the instant-cache card is currently visible (controls chip + error suppression). */
  showingCachedCard: false,
  /** Whether a background refresh has already been started for the current open (prevents duplicates). */
  backgroundRefreshStarted: false,
};

/**
 * Render the detail view for a group.
 * @param {string} group — display name
 * @param {boolean} autoStart — if true, start the catch-up stream immediately
 */
function renderDetail(group, autoStart) {
  teardownStream();

  // Find group metadata from cache
  const meta = cachedGroups.find((g) => g.name === group) || { name: group };
  const ago = formatAgo(meta.lastMessageAt);

  detailState.group = group;
  detailState.summaryText = "";
  detailState.phase = "idle";
  detailState.activeChip = "catchup";
  detailState.cachedSummaryText = null;
  detailState.showingCachedCard = false;
  detailState.backgroundRefreshStarted = false;

  app.innerHTML = buildDetailShell(group, ago, meta);
  wireDetailButtons(group);

  // Load history (async, non-blocking)
  loadHistory(group);

  if (autoStart) {
    // autoStart always runs catch-up (the primary CTA from the feed)
    setActiveChip("catchup");
    // US1/US2: fetch the latest cached summary first; render it instantly if present.
    // Then start the catch-up stream in background.
    void runDetailWithCacheFirst(group);
  }
}

/**
 * US1/US2: Open-time instant-cache orchestration.
 * 1. Fetch the most-recent cached summary via the existing /api/summaries endpoint (limit=1).
 * 2. If present, render it immediately (no loader) and start the SSE stream in background.
 * 3. If absent (cold open), behave exactly as today — show Reader loader + stream.
 * @param {string} group
 */
async function runDetailWithCacheFirst(group) {
  let cached = null;
  try {
    const history = await getSummaries(group, 1);
    if (history && history.length > 0 && history[0].output?.overview) {
      cached = history[0];
    }
  } catch {
    // History fetch failed — fall through to cold open
  }

  if (cached) {
    // US1: render cached summary instantly (no loader)
    detailState.cachedSummaryText = cached.output.overview;
    detailState.showingCachedCard = true;
    const timeStr = fmtTime(cached.createdAt);
    const statusText = `מהמטמון • נוצר ב־${timeStr}`;
    setSummaryRegion(buildSummaryCardDone(cached.output.overview, statusText, false));
    // Debounce: wait 400ms before starting the background refresh.
    // If the user navigates away within that window, skip the 70s Ollama call.
    const openedGroup = group;
    setTimeout(() => {
      if (shouldStartBackgroundRefresh({
        hasCached: true,
        openedGroup,
        currentDetailGroup: detailState.group,
        backgroundRefreshStarted: detailState.backgroundRefreshStarted,
      })) {
        detailState.backgroundRefreshStarted = true;
        runSummary({ mode: "catchup", group: openedGroup }, /* background= */ true);
      }
    }, 400);
  } else {
    // Cold open: behave exactly as before (Reader loader + stream)
    runSummary({ mode: "catchup", group }, /* background= */ false);
  }
}

/** Build the static detail shell HTML. */
function buildDetailShell(group, ago, meta) {
  const metaParts = [];
  if (ago) metaParts.push(ago);
  if (meta.messageCount != null) metaParts.push(`${Number(meta.messageCount).toLocaleString("he-IL")} הודעות`);

  return `
    <div class="detail-view">
      <nav class="detail-nav" aria-label="ניווט">
        <button class="back-btn" id="back-btn" aria-label="חזרה לרשימת הקבוצות">
          <span class="back-btn__arrow" aria-hidden="true">‹</span>
          חזרה
        </button>
        <div class="health-pill" role="status" aria-live="polite">
          <span class="health-pill__dot"></span>
          <span>טוען…</span>
        </div>
      </nav>

      <div class="detail-ghead">
        <h2 class="detail-gtitle">${escHtml(formatGroupName(group))}</h2>
        ${ago ? `
          <div class="detail-gfresh">
            <span class="group-card__dot" aria-hidden="true"></span>
            <span>${escHtml(metaParts.join(" · "))}</span>
          </div>
        ` : ""}
      </div>

      <!-- Mode chips row (US2) -->
      <div class="chips mode-chips" role="group" aria-label="בחירת טווח זמן" id="mode-chips">
        <button class="chip chip--active" data-chip="catchup" aria-pressed="true">מה שפספסתי</button>
        <button class="chip" data-chip="24h" aria-pressed="false">24 שעות</button>
        <button class="chip" data-chip="3d" aria-pressed="false">3 ימים</button>
        <button class="chip" data-chip="week" aria-pressed="false">שבוע</button>
        <button class="chip" data-chip="month" aria-pressed="false">חודש</button>
        <button class="chip" data-chip="range" aria-pressed="false">טווח…</button>
      </div>

      <!-- summary region — aria-live so screen readers announce updates -->
      <div id="summary-region" aria-live="polite" aria-atomic="false">
      </div>

      <!-- Range sheet (US2) — hidden by default -->
      <div id="range-sheet" class="range-sheet" aria-modal="true" role="dialog" aria-label="בחירת טווח זמן" hidden>
        <div class="range-sheet__handle" aria-hidden="true"></div>
        <h4 class="range-sheet__title">בחירת טווח</h4>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-datetime">📅 מתאריך ושעה</label>
          <input
            id="range-datetime"
            class="range-sheet__input"
            type="datetime-local"
            aria-label="תאריך ושעה התחלה"
          />
        </div>
        <div class="range-sheet__until">
          <span class="range-sheet__until-label">עד:</span>
          <span class="range-sheet__until-val">עכשיו</span>
        </div>
        <div class="range-sheet__divider" aria-hidden="true">— או —</div>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-lastn">📩 הודעות אחרונות</label>
          <input
            id="range-lastn"
            class="range-sheet__input"
            type="number"
            min="1"
            step="1"
            placeholder="לדוגמה: 100"
            aria-label="מספר הודעות אחרונות"
          />
        </div>
        <p id="range-error" class="range-sheet__error" aria-live="polite" hidden></p>
        <button class="range-sheet__go" id="range-go">סכם את הטווח הזה</button>
        <button class="range-sheet__cancel" id="range-cancel">ביטול</button>
      </div>

      <!-- History section (US3) — collapsed by default, toggle reveals list -->
      <section class="history-section" id="history-section" aria-label="סיכומים קודמים">
        <!-- toggle button injected by loadHistory when count > 0 -->
        <div id="history-list" class="history-list" aria-live="polite" hidden>
        </div>
      </section>
    </div>
  `;
}

/** Wire back button and chip buttons in the detail view. */
function wireDetailButtons(group) {
  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      navigate("feed");
    });
  }

  // Wire mode chips
  const chipsContainer = document.getElementById("mode-chips");
  if (chipsContainer) {
    chipsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-chip]");
      if (!btn) return;
      const chip = btn.dataset.chip;
      onChipClick(chip);
    });
  }

  // Wire range sheet buttons
  const rangeGo = document.getElementById("range-go");
  if (rangeGo) {
    rangeGo.addEventListener("click", () => onRangeSubmit());
  }

  const rangeCancel = document.getElementById("range-cancel");
  if (rangeCancel) {
    rangeCancel.addEventListener("click", () => closeRangeSheet());
  }
}

/**
 * Handle a chip click (US2).
 * @param {string} chip — "catchup" | "24h" | "3d" | "week" | "month" | "range"
 */
function onChipClick(chip) {
  if (chip === "range") {
    setActiveChip("range");
    openRangeSheet();
    return;
  }

  closeRangeSheet();
  setActiveChip(chip);

  if (chip === "catchup") {
    runSummary({ mode: "catchup", group: detailState.group });
  } else {
    // preset: 24h | 3d | week | month
    const since = presetToSince(chip);
    runSummary({ since, group: detailState.group });
  }
}

/**
 * Mark the active chip visually and update state.
 * @param {string} chip
 */
function setActiveChip(chip) {
  detailState.activeChip = chip;
  const container = document.getElementById("mode-chips");
  if (!container) return;
  container.querySelectorAll(".chip[data-chip]").forEach((btn) => {
    const isActive = btn.dataset.chip === chip;
    btn.classList.toggle("chip--active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

/* ── 5a. Range sheet (US2) ───────────────────────────────── */

function openRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (sheet) {
    sheet.hidden = false;
    // Clear any previous error
    const err = document.getElementById("range-error");
    if (err) { err.hidden = true; err.textContent = ""; }
    // Focus the first input for accessibility
    const dtInput = document.getElementById("range-datetime");
    if (dtInput) dtInput.focus();
  }
}

function closeRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (sheet) sheet.hidden = true;
}

function onRangeSubmit() {
  const dtInput = document.getElementById("range-datetime");
  const lastNInput = document.getElementById("range-lastn");
  const errEl = document.getElementById("range-error");

  const datetime = dtInput ? dtInput.value : "";
  const lastNRaw = lastNInput ? lastNInput.value.trim() : "";

  let result;
  if (lastNRaw !== "") {
    // last-N mode takes priority when filled
    const n = parseInt(lastNRaw, 10);
    result = validateRangeInput({ mode: "last", n: isNaN(n) ? null : n });
  } else {
    // since mode
    result = validateRangeInput({ mode: "since", datetime });
  }

  if (!result.ok) {
    if (errEl) {
      errEl.textContent = result.error;
      errEl.hidden = false;
    }
    return;
  }

  // Validation passed — close sheet, start stream
  closeRangeSheet();
  if (result.last !== undefined) {
    runSummary({ last: result.last, group: detailState.group });
  } else {
    runSummary({ since: result.since, group: detailState.group });
  }
}

/* ── 5b. runSummary — generic streaming runner (US1+US2) ──── */

/**
 * Start a summary stream for the current detail group.
 * Replaces the old startCatchup(); all modes share this path.
 *
 * @param {Object} params — one of:
 *   { mode: "catchup", group: string }
 *   { since: string, group: string }
 *   { last: number, group: string }
 * @param {boolean} [background=false] — when true, a cached card is already visible;
 *   skip the Reader loader skeleton and suppress loader/error UI changes until needed.
 */
function runSummary(params, background = false) {
  teardownStream();
  if (!detailState.group) return;

  detailState.started = Date.now();
  detailState.syncingTimer = null;
  detailState.syncingStart = 0;
  detailState.summaryText = "";
  detailState.phase = "streaming";

  if (!background) {
    // Cold open or user-triggered re-run: clear cached-card state and show Reader loader
    detailState.cachedSummaryText = null;
    detailState.showingCachedCard = false;
    showUpdatingChip(false); // ensure any lingering chip is cleared
    setSummaryRegion(buildSkeleton());
  }
  // When background=true, the cached card is already rendered — leave it in place
  // and show the מתעדכן… chip to indicate background refresh is in flight.
  if (background && detailState.showingCachedCard) {
    showUpdatingChip(true);
  }

  activeEventSource = summarizeStream(
    params,
    {
      syncing: onSyncing,
      status: onStatus,
      token: onToken,
      cached: onCached,
      empty: onEmpty,
      done: onDone,
      error: onError,
    }
  );
}

/**
 * @deprecated Use runSummary({ mode: "catchup", group }) instead.
 * Kept as alias so existing call-sites are harmless.
 */
function startCatchup() {
  setActiveChip("catchup");
  runSummary({ mode: "catchup", group: detailState.group });
}

/** Close & discard any active EventSource. Also clears the syncing timer. */
function teardownStream() {
  if (detailState.syncingTimer) {
    clearInterval(detailState.syncingTimer);
    detailState.syncingTimer = null;
  }
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
}

/* ── 5c. SSE event handlers ──────────────────────────────── */

/**
 * Advance the determinate loader progress bar to match elapsed time.
 * The fill width comes from loaderProgress() — monotonic, eases toward a
 * ceiling — so it always feels like it's making headway (the CSS transition
 * animates each step smoothly).
 */
function updateLoaderProgress(elapsedSec) {
  const fill = document.querySelector(".glacier-loader__bar-fill");
  if (fill) fill.style.width = `${loaderProgress(elapsedSec)}%`;
}

function onSyncing(data) {
  // If a cached card is visible, skip loader UI changes — the cached card stays.
  if (detailState.showingCachedCard) return;

  if (data.phase === "start") {
    detailState.syncingStart = Date.now();
    setSummaryRegion(buildGlacierLoader({ statusLine: "מסנכרן הודעות חדשות…", elapsed: 0, phase: "syncing" }));
    detailState.syncingTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - detailState.syncingStart) / 1000);
      const elEl = document.getElementById("gl-elapsed");
      if (elEl) elEl.textContent = `${elapsed}ש׳`;
      updateLoaderProgress(elapsed);
    }, 500);
  } else if (data.phase === "done") {
    clearSyncingTimer();
    const fetchSec = (data.fetchMs / 1000).toFixed(1);
    const statusLine = `סנכרון הושלם · ${data.fetched} הודעות · ${fetchSec}ש׳`;
    setSummaryRegion(buildGlacierLoader({ statusLine, elapsed: Math.round(data.fetchMs / 1000), phase: "syncing" }));
  }
}

function onStatus(data) {
  // If a cached card is visible, skip loader UI changes — the cached card stays.
  if (detailState.showingCachedCard) {
    clearSyncingTimer();
    return;
  }

  clearSyncingTimer();
  const staleNote = data.stale ? " ⚠️ האספן לא מגיב" : "";
  const fallbackNote = data.usedFallback ? " (הצצה ראשונה — ההודעות האחרונות)" : "";
  const statusText = `מסכם ${data.messages} הודעות${fallbackNote}${staleNote}`;
  const msgCount = data.messages || 0;
  const elapsed = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
  setSummaryRegion(buildGlacierLoader({ statusLine: statusText, messageCount: msgCount, elapsed, phase: "analyzing" }));
  // Start a live elapsed tick in the loader
  detailState.syncingTimer = setInterval(() => {
    const secs = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
    const elEl = document.getElementById("gl-elapsed");
    if (elEl) elEl.textContent = `${secs}ש׳`;
    updateLoaderProgress(secs);
  }, 1000);
}

function onToken(data) {
  // If a cached card is visible, we're in background refresh mode.
  // Don't replace the cached card with streaming output — wait for `done` to swap.
  if (detailState.showingCachedCard) {
    detailState.summaryText += data.delta;
    return;
  }

  detailState.summaryText += data.delta;
  // Mount the streaming card once; thereafter update ONLY the body so the
  // "writing" indicator + caret keep animating (it feels alive) and the
  // formatted markdown visibly builds up token by token.
  let body = document.querySelector(".summary-card--streaming .summary-card__body");
  if (!body) {
    setSummaryRegion(buildSummaryCardStreaming(detailState.summaryText, ""));
    body = document.querySelector(".summary-card--streaming .summary-card__body");
  } else {
    body.innerHTML = `${renderMarkdown(detailState.summaryText)}<span class="caret" aria-hidden="true"></span>`;
    body.scrollTop = body.scrollHeight; // keep the freshest text in view
  }
}

function onCached(data) {
  clearSyncingTimer();
  detailState.phase = "cached";

  if (detailState.showingCachedCard) {
    // US1: the cached card we showed instantly IS this cache-hit — no new messages.
    // Just clear the chip and we're done; the card is already rendered correctly.
    showUpdatingChip(false);
    detailState.showingCachedCard = false;
    teardownStream();
    return;
  }

  // Cold open: the stream returned a cached result — render it now.
  detailState.summaryText = data.summary;
  const timeStr = fmtTime(data.generatedAt);
  const statusText = `אין חדש — מתוך מטמון • נוצר ב־${timeStr}`;
  setSummaryRegion(buildSummaryCardDone(detailState.summaryText, statusText, false));
  teardownStream();
}

function onEmpty() {
  clearSyncingTimer();
  detailState.phase = "empty";

  if (detailState.showingCachedCard) {
    // Cached card visible but stream says empty — no new messages.
    // Keep the cached card; just clear the chip.
    showUpdatingChip(false);
    detailState.showingCachedCard = false;
    teardownStream();
    return;
  }

  setSummaryRegion(buildEmptyResult());
  teardownStream();
}

function onDone(data) {
  clearSyncingTimer();
  detailState.phase = "done";
  const totalSec = ((Date.now() - detailState.started) / 1000).toFixed(1);
  const parts = [`נשמר • ${totalSec} שניות`];
  if (data.fetchMs > 0) parts.push(`טעינה ${(data.fetchMs / 1000).toFixed(1)}ש׳ (${data.fetched} הודעות)`);
  if (data.summarizeMs) parts.push(`סיכום ${(data.summarizeMs / 1000).toFixed(1)}ש׳`);
  const statusText = parts.join(" • ");
  const isStale = !!data.stale;

  // US2: clear the chip and swap to the fresh merged summary
  showUpdatingChip(false);
  detailState.showingCachedCard = false;

  setSummaryRegion(buildSummaryCardDone(detailState.summaryText, statusText, isStale));
  teardownStream();

  // Refresh history after a new summary is saved (US3)
  if (detailState.group) {
    loadHistory(detailState.group);
  }
}

function onError(data) {
  clearSyncingTimer();
  detailState.phase = "error";

  if (detailState.showingCachedCard) {
    // US2: background refresh failed — keep the cached summary, clear the chip.
    // Do NOT replace valid cached content with an error state.
    showUpdatingChip(false);
    // showingCachedCard remains true so the card stays
    teardownStream();
    return;
  }

  const msg = data?.message || "שגיאת חיבור.";
  setSummaryRegion(`<p class="detail-status detail-status--error" role="alert">${escHtml(msg)}</p>`);
  teardownStream();
}

/* ── 5d. Summary region builders ────────────────────────── */

/**
 * Build the Glacier loader card shown before the first token arrives.
 * @param {{ statusLine?: string, messageCount?: number, elapsed?: number, phase?: string }} opts
 */
function buildGlacierLoader({ statusLine = "מכין סיכום…", messageCount = 0, elapsed = 0, phase = "analyzing" } = {}) {
  const large = messageCount >= 100;
  const elapsedStr = elapsed > 0 ? `${elapsed}ש׳` : "";
  // Message bubbles that fly in (RTL: from the right) to be "read".
  const msgs = Array.from({ length: 4 }, (_, i) =>
    `<span class="gl-msg gl-msg--${i + 1}" aria-hidden="true"></span>`
  ).join("");

  const phaseClass = phase === "syncing" ? "glacier-loader--syncing" : "glacier-loader--analyzing";
  return `
    <div class="glacier-loader glass-card ${phaseClass}" role="status" aria-live="polite" aria-label="${escHtml(statusLine)}">
      <div class="glacier-loader__aurora" aria-hidden="true"></div>
      <div class="glacier-loader__inner">
        <div class="gl-scene" aria-hidden="true">
          <div class="gl-stage">
            ${msgs}
            <div class="gl-reader">
              <span class="gl-reader__halo"></span>
              <span class="gl-reader__book"></span>
              <span class="gl-reader__head">
                <span class="gl-brow gl-brow--l"></span>
                <span class="gl-brow gl-brow--r"></span>
                <span class="gl-eye gl-eye--l"><i></i></span>
                <span class="gl-eye gl-eye--r"><i></i></span>
              </span>
              <span class="gl-spark gl-spark--1"></span>
              <span class="gl-spark gl-spark--2"></span>
              <span class="gl-spark gl-spark--3"></span>
            </div>
          </div>
        </div>
        ${large ? `<div class="glacier-loader__count">${escHtml(String(messageCount))}<span class="glacier-loader__count-label"> הודעות</span></div>` : ""}
        <div class="glacier-loader__status">${escHtml(statusLine)}</div>
        <div class="glacier-loader__footer">
          ${elapsedStr ? `<span class="glacier-loader__elapsed" id="gl-elapsed">${escHtml(elapsedStr)}</span>` : `<span class="glacier-loader__elapsed" id="gl-elapsed"></span>`}
        </div>
        <div class="glacier-loader__bar" aria-hidden="true"><div class="glacier-loader__bar-fill" style="width:${loaderProgress(elapsed)}%"></div></div>
      </div>
    </div>
  `;
}

function buildSkeleton() {
  return buildGlacierLoader();
}

function buildSyncingPill(text, sub) {
  // sub is like "5 שניות…" from the timer — we parse the number out for elapsed display
  let elapsed = 0;
  if (sub) {
    const m = sub.match(/^(\d+)/);
    if (m) elapsed = parseInt(m[1], 10);
  }
  const fetched = (() => {
    if (!sub) return 0;
    const m2 = sub.match(/נטענו (\d+)/);
    return m2 ? parseInt(m2[1], 10) : 0;
  })();
  const statusLine = fetched > 0
    ? `מסנכרן — נטענו ${fetched} הודעות`
    : escHtml(text);
  return buildGlacierLoader({ statusLine, elapsed, phase: "syncing" });
}

function buildSummaryCardStreaming(text, statusText) {
  const hasText = text.length > 0;

  if (!hasText) {
    // Still pre-first-token: show the Glacier loader with updated status
    // Extract message count from statusText like "מסכם 247 הודעות…"
    let msgCount = 0;
    if (statusText) {
      const m = statusText.match(/(\d+)\s+הודעות/);
      if (m) msgCount = parseInt(m[1], 10);
    }
    const elapsed = detailState.started
      ? Math.round((Date.now() - detailState.started) / 1000)
      : 0;
    return buildGlacierLoader({ statusLine: statusText || "מסכם…", messageCount: msgCount, elapsed, phase: "analyzing" });
  }

  // First token has arrived — render markdown live, with a "writing" indicator + caret.
  return `
    <div class="glass-card summary-card summary-card--streaming" style="animation: summary-fade-in 0.35s ease both">
      <div class="summary-card__meta">
        <span class="writing-indicator">
          <span class="writing-indicator__pen" aria-hidden="true">✍️</span>
          כותב סיכום<span class="writing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </span>
      </div>
      <div class="summary-card__body summary-card__body--rendered">${renderMarkdown(text)}<span class="caret" aria-hidden="true"></span></div>
    </div>
  `;
}

function buildSummaryCardDone(text, statusText, stale) {
  return `
    ${stale ? `
      <div class="stale-note" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>נתונים עלולים להיות לא עדכניים</span>
      </div>
    ` : ""}
    <div class="glass-card summary-card">
      <div class="summary-card__meta">
        <span>${escHtml(statusText)}</span>
      </div>
      <div class="summary-card__body summary-card__body--rendered">${renderMarkdown(text)}</div>
      <div class="summary-actions">
        <button class="copy-btn" id="copy-btn" aria-label="העתק סיכום">📋 העתק סיכום</button>
      </div>
    </div>
  `;
}

function buildEmptyResult() {
  return `
    <div class="glass-card summary-card">
      <div class="summary-card__meta">
        <span>אין חדש</span>
      </div>
      <p class="detail-status">אין הודעות חדשות לסיכום.</p>
    </div>
  `;
}

/**
 * Show or hide the "מתעדכן…" (updating) chip overlaid on the cached summary card.
 * The chip is injected into / removed from a dedicated #updating-chip-host element
 * that lives adjacent to the summary-region, so it doesn't disturb the card DOM.
 *
 * @param {boolean} show
 */
function showUpdatingChip(show) {
  let host = document.getElementById("updating-chip-host");
  if (!host) {
    // Create the host element once and insert it just before the summary-region
    const region = document.getElementById("summary-region");
    if (!region) return;
    host = document.createElement("div");
    host.id = "updating-chip-host";
    region.parentNode.insertBefore(host, region);
  }
  if (show) {
    host.innerHTML = buildUpdatingChip();
  } else {
    host.innerHTML = "";
  }
}

/**
 * Build the HTML for the "מתעדכן…" updating chip (US2).
 * Subtle, non-blocking indicator that a background refresh is in progress.
 * @returns {string}
 */
function buildUpdatingChip() {
  return `
    <div class="updating-chip" role="status" aria-live="polite" aria-label="מתעדכן">
      <span class="updating-chip__dot" aria-hidden="true"></span>
      <span class="updating-chip__text">מתעדכן…</span>
    </div>
  `;
}

function buildSkeletonLines() {
  return `
    <div class="skeleton" style="width:92%"></div>
    <div class="skeleton" style="width:78%"></div>
    <div class="skeleton" style="width:85%"></div>
    <div class="skeleton" style="width:60%"></div>
  `;
}

/* ── 5e. Copy button logic ───────────────────────────────── */

/**
 * Wire copy button via event delegation on the stable #app container.
 * Called once at boot time — handles dynamically-rendered #copy-btn
 * both in the live summary region AND in expanded history rows.
 */
function wireCopyButton() {
  app.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;

    // Determine what text to copy.
    // History row copy buttons carry data-text attribute; the main copy-btn uses detailState.
    let text;
    if (btn.dataset.text != null) {
      text = btn.dataset.text;
    } else {
      text = detailState.summaryText;
    }
    if (!text) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback: create a temporary textarea and use execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      // Confirm visually
      btn.textContent = "הועתק!";
      btn.classList.add("copy-btn--confirm");
      setTimeout(() => {
        btn.textContent = "📋 העתק סיכום";
        btn.classList.remove("copy-btn--confirm");
      }, 2000);
    } catch {
      btn.textContent = "לא ניתן להעתיק";
      setTimeout(() => {
        btn.textContent = "📋 העתק סיכום";
      }, 2000);
    }
  });
}

/* ── 5f. History (US3) ───────────────────────────────────── */

/**
 * Map a summaryType value to a Hebrew label.
 * @param {string} type
 * @returns {string}
 */
function summaryTypeLabel(type) {
  switch (type) {
    case "watermark": return "מה שפספסתי";
    case "last_n": return "הודעות אחרונות";
    case "since": return "טווח זמן";
    default: return escHtml(type);
  }
}

/**
 * Fetch and render the history list for a group (US3).
 * List is collapsed by default; a toggle button is shown when count > 0.
 * @param {string} group
 */
async function loadHistory(group) {
  const section = document.getElementById("history-section");
  const listEl = document.getElementById("history-list");
  if (!section || !listEl) return;

  let summaries;
  try {
    summaries = await getSummaries(group);
  } catch {
    // On error show a minimal error toggle so user knows history failed
    _renderHistoryToggle(section, listEl, 0, true);
    return;
  }

  if (!summaries || summaries.length === 0) {
    // No history: remove any existing toggle and hide list entirely
    const existing = section.querySelector(".history-toggle");
    if (existing) existing.remove();
    listEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }

  // Newest-first (API should return newest-first, but sort defensively)
  const sorted = [...summaries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  listEl.innerHTML = sorted
    .map((s) => buildHistoryRow(s))
    .join("");

  // Wire expand/collapse on each row
  listEl.querySelectorAll(".history-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      // Don't collapse when clicking inside the expanded body (copy button)
      if (e.target.closest(".history-row__body")) return;
      toggleHistoryRow(row);
    });
  });

  // Render (or update) the toggle button with fresh count
  _renderHistoryToggle(section, listEl, sorted.length, false);
}

/**
 * Render (or update) the history toggle button.
 * @param {HTMLElement} section
 * @param {HTMLElement} listEl
 * @param {number} count
 * @param {boolean} error
 */
function _renderHistoryToggle(section, listEl, count, error) {
  // Preserve current open/closed state across refreshes
  const existingToggle = section.querySelector(".history-toggle");
  const wasOpen = existingToggle
    ? existingToggle.getAttribute("aria-expanded") === "true"
    : false;

  // Remove old toggle if any
  if (existingToggle) existingToggle.remove();

  if (error) {
    listEl.hidden = true;
    listEl.innerHTML = `<p class="history-empty">שגיאה בטעינת היסטוריה.</p>`;
    return;
  }

  if (count === 0) {
    listEl.hidden = true;
    return;
  }

  // Build toggle button
  const toggle = document.createElement("button");
  toggle.className = "history-toggle";
  toggle.setAttribute("aria-expanded", wasOpen ? "true" : "false");
  toggle.setAttribute("aria-controls", "history-list");
  toggle.innerHTML = `<span class="history-toggle__label">סיכומים קודמים (${count})</span><span class="history-toggle__chevron" aria-hidden="true">▾</span>`;

  // Insert before listEl in the section
  section.insertBefore(toggle, listEl);

  // Restore state
  if (wasOpen) {
    listEl.hidden = false;
    toggle.querySelector(".history-toggle__chevron").classList.add("history-toggle__chevron--open");
  } else {
    listEl.hidden = true;
  }

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    listEl.hidden = open;
    const chevron = toggle.querySelector(".history-toggle__chevron");
    if (chevron) chevron.classList.toggle("history-toggle__chevron--open", !open);
  });
}

/**
 * Build HTML for a single history row.
 * @param {{ id: number, summaryType: string, output: {overview: string}, createdAt: string }} s
 * @returns {string}
 */
function buildHistoryRow(s) {
  const label = summaryTypeLabel(s.summaryType);
  const ts = fmtTime(s.createdAt);
  const bodyText = s.output?.overview ?? "";
  // copy-btn delegation reads the RAW markdown from this data attribute
  const dataText = bodyText.replace(/"/g, "&quot;");

  return `
    <div class="history-row glass-card" data-id="${s.id}" aria-expanded="false">
      <div class="history-row__head">
        <span class="history-row__type">${label}</span>
        <span class="history-row__ts">${escHtml(ts)}</span>
        <span class="history-row__chevron" aria-hidden="true">›</span>
      </div>
      <div class="history-row__body" hidden>
        <div class="history-row__text summary-card__body--rendered">${renderMarkdown(bodyText)}</div>
        <div class="summary-actions">
          <button class="copy-btn" data-text="${dataText}" aria-label="העתק סיכום">📋 העתק סיכום</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Toggle expand/collapse on a history row.
 * @param {HTMLElement} row
 */
function toggleHistoryRow(row) {
  const body = row.querySelector(".history-row__body");
  const chevron = row.querySelector(".history-row__chevron");
  if (!body) return;
  const expanded = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", expanded ? "false" : "true");
  body.hidden = expanded;
  if (chevron) {
    chevron.classList.toggle("history-row__chevron--open", !expanded);
  }
}

/* ── 6. Helpers ──────────────────────────────────────────── */

/**
 * Format a raw WhatsApp JID / lid into a friendly display name.
 * Does NOT modify the raw value — only used for displayed text.
 * @param {string} name
 * @returns {string}
 */
function formatGroupName(name) {
  if (!name) return name;
  if (name.endsWith("@s.whatsapp.net")) {
    const part = name.slice(0, name.lastIndexOf("@"));
    return "+" + part;
  }
  if (name.endsWith("@lid")) {
    const part = name.slice(0, name.lastIndexOf("@"));
    const last4 = part.slice(-4);
    return "איש קשר · …" + last4;
  }
  if (name.endsWith("@g.us")) {
    const part = name.slice(0, name.lastIndexOf("@"));
    const last4 = part.slice(-4);
    return "קבוצה · …" + last4;
  }
  return name;
}

/** Replace the contents of the #summary-region element. */
function setSummaryRegion(html) {
  const region = document.getElementById("summary-region");
  if (region) region.innerHTML = html;
}

/** Clear the syncing interval timer. */
function clearSyncingTimer() {
  if (detailState.syncingTimer) {
    clearInterval(detailState.syncingTimer);
    detailState.syncingTimer = null;
  }
}

/** Format an ISO timestamp to a locale string (Hebrew). */
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("he-IL");
  } catch {
    return iso;
  }
}

/** Escape HTML special chars for text interpolation. */
function escHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ── 7. Bootstrap ────────────────────────────────────────── */

/** Parse the URL hash to determine the initial view. */
function resolveInitialRoute() {
  const hash = location.hash;
  const match = hash.match(/^#group=(.+)$/);
  if (match) {
    const group = decodeURIComponent(match[1]);
    history.replaceState({ view: "detail", group }, "", hash);
    return { view: "detail", group };
  }
  history.replaceState({ view: "feed" }, "", location.pathname);
  return { view: "feed" };
}

async function boot() {
  // Start health polling immediately (runs independently of views)
  startHealthPolling();

  // Wire copy button via delegation (once, on the app container)
  wireCopyButton();

  // Resolve route and render initial view
  const route = resolveInitialRoute();
  if (route.view === "detail") {
    // Pre-load groups so detail has metadata
    try {
      cachedGroups = await getGroups();
    } catch {
      cachedGroups = [];
    }
    renderDetail(route.group, false);
  } else {
    renderFeed();
  }
}

boot();
