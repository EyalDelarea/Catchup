/**
 * app.js — Elevated Glacier UI · Catchup
 *
 * Persistent two-pane shell:
 *   #top-bar   — brand + core-features row (AMA + total) + health pill
 *   #pane-list — search + group list (the right sidebar on desktop)
 *   #pane-main — detail | total | ama content
 *
 * Visible pane is CSS-driven by #layout[data-view]. On mobile one pane shows at
 * a time (feed ↔ detail/total/ama); on desktop both panes show together.
 *
 * View state machine: feed ↔ detail{group} ↔ total ↔ ama{scope?}
 * Routing: history.pushState + popstate (phone Back works)
 * Teardown: EventSource is closed when leaving a streaming view
 */

import { getGroups, getStatus, getSummaries, summarizeStream } from "./lib/api.js";
import { formatAgo, presetToSince, validateRangeInput } from "./lib/time.js";
import { renderMarkdown } from "./lib/markdown.js";
import { deriveHealth } from "./lib/health.js";
import { shouldStartBackgroundRefresh } from "./lib/open-state.js";
import { PHASE_LABELS, PHASES, phaseFill, activeZoneIndex, phaseCaption, scanFill } from "./lib/phase-loader.js";
import { createConversation, ask } from "./lib/ama-stub.js";
import { DEMO_GROUPS, DEMO_SUMMARY, DEMO_TOTAL_HIGHLIGHTS, DEMO_TOTAL_PERCHAT } from "./lib/demo-data.js";

/** Off by default. `?demo=1` previews dummy data; `?demo=tube` shows the loader. */
const DEMO = new URLSearchParams(location.search).get("demo");

/* ── 1. Globals ──────────────────────────────────────────── */

const layout = document.getElementById("layout");
const topBar = document.getElementById("top-bar");
const paneList = document.getElementById("pane-list");
const paneMain = document.getElementById("pane-main");
const staleBanner = document.getElementById("stale-banner");

/** Currently open EventSource (cleaned up on view change). */
let activeEventSource = null;
/** Total-view loader elapsed-timer handle. */
let totalLoaderTimer = null;
/** Health poll interval id. */
let healthInterval = null;
/** Cached groups list. */
let cachedGroups = [];
/** Active AMA conversation (recreated each time the panel opens). */
let amaConversation = createConversation();

/* ── 2. Routing ──────────────────────────────────────────── */

/** Set the visible-pane hint for CSS. */
function setView(view) {
  if (layout) layout.dataset.view = view;
}

/**
 * Navigate to a view, pushing a history entry.
 * @param {"feed"|"detail"|"total"|"ama"} view
 * @param {string} [arg] — group name (detail) or AMA scope (ama)
 */
function navigate(view, arg) {
  if (view === "detail" && arg) {
    history.pushState({ view: "detail", group: arg }, "", `#group=${encodeURIComponent(arg)}`);
    renderDetail(arg, true);
  } else if (view === "total") {
    history.pushState({ view: "total" }, "", "#total");
    renderTotal(true);
  } else if (view === "ama") {
    const hash = arg ? `#ama=${encodeURIComponent(arg)}` : "#ama";
    history.pushState({ view: "ama", scope: arg ?? null }, "", hash);
    renderAma(arg ?? null);
  } else {
    history.pushState({ view: "feed" }, "", location.pathname);
    setView("feed");
    markActiveRow(null);
  }
}

window.addEventListener("popstate", (e) => {
  teardownStream();
  const state = e.state;
  if (state?.view === "detail" && state.group) {
    renderDetail(state.group, false);
  } else if (state?.view === "total") {
    renderTotal(false);
  } else if (state?.view === "ama") {
    renderAma(state.scope ?? null);
  } else {
    setView("feed");
    markActiveRow(null);
  }
});

/* ── 3. Health polling ───────────────────────────────────── */

function applyHealth(healthy) {
  staleBanner.hidden = !!healthy;
  document.querySelectorAll(".health-pill").forEach((pill) => {
    const dot = pill.querySelector(".health-pill__dot");
    pill.textContent = "";
    const d = dot || document.createElement("span");
    d.className = "health-pill__dot";
    pill.appendChild(d);
    if (healthy) {
      pill.classList.remove("health-pill--bad");
      pill.appendChild(document.createTextNode("המערכת תקינה"));
    } else {
      pill.classList.add("health-pill--bad");
      pill.appendChild(document.createTextNode("לא מגיב"));
    }
  });
}

async function pollHealth() {
  try {
    applyHealth(deriveHealth(await getStatus()));
  } catch {
    applyHealth(false);
  }
}

function startHealthPolling() {
  if (healthInterval) return;
  pollHealth();
  healthInterval = setInterval(pollHealth, 5_000);
}

/* ── 4. Shell (top-bar + list pane) ──────────────────────── */

/** Render the persistent shell once at boot. */
function renderShell() {
  topBar.innerHTML = `
    <div class="brand">
      <div class="feed-kicker">on the go</div>
      <h1 class="feed-title">הקבוצות שלי</h1>
    </div>
    <div class="core" role="group" aria-label="פעולות ראשיות">
      <button class="feat feat--ama" id="ama-card" type="button" aria-label="שאל אותי הכל">
        <span class="feat__ico" aria-hidden="true">✨</span>
        <span class="feat__title">שאל אותי הכל</span>
        <span class="feat__sub">על כל השיחות שלך</span>
        <span class="feat__hint">הקש כדי לשאול ›</span>
      </button>
      <button class="feat feat--total" id="total-card" type="button" aria-label="סיכום כללי לכל הצ׳אטים">
        <span class="feat__ico" aria-hidden="true">📊</span>
        <span class="feat__title">סיכום כללי</span>
        <span class="feat__sub">מה קרה בכל הצ׳אטים</span>
        <span class="feat__hint">הקש לסיכום ›</span>
      </button>
    </div>
    <div class="health-pill" role="status" aria-live="polite">
      <span class="health-pill__dot"></span><span>טוען…</span>
    </div>
  `;

  paneList.innerHTML = `
    <div class="search-wrap">
      <input id="search-input" class="search-input" type="search"
        placeholder="🔍  חיפוש קבוצה…" aria-label="חיפוש קבוצה"
        autocomplete="off" autocorrect="off" spellcheck="false" />
    </div>
    <div class="seclabel">הקבוצות שלי</div>
    <div class="feed-list" id="feed-list" role="list" aria-live="polite">
      ${buildSkeletonCards(3)}
    </div>
  `;

  document.getElementById("ama-card").addEventListener("click", () => navigate("ama"));
  document.getElementById("total-card").addEventListener("click", () => navigate("total"));
  const input = document.getElementById("search-input");
  if (input) input.addEventListener("input", () => renderGroupList(cachedGroups, input.value));
}

/** Fetch groups and populate the list. */
async function loadGroupsIntoList() {
  if (DEMO) { cachedGroups = DEMO_GROUPS; renderGroupList(cachedGroups, ""); return; }
  try {
    cachedGroups = await getGroups();
  } catch {
    const list = document.getElementById("feed-list");
    if (list) list.innerHTML = `<p class="error-state">שגיאה בטעינת הקבוצות. אנא רעננו את הדף.</p>`;
    return;
  }
  renderGroupList(cachedGroups, "");
}

/** Re-render the card list based on a filter string. */
function renderGroupList(groups, filter) {
  const list = document.getElementById("feed-list");
  if (!list) return;
  const q = (filter || "").trim().toLowerCase();
  const filtered = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;

  if (filtered.length === 0) {
    list.innerHTML = `<p class="empty-state">${q ? "לא נמצאו קבוצות תואמות." : "אין שיחות שמורות."}</p>`;
    return;
  }
  list.innerHTML = filtered.map((g) => buildGroupCard(g)).join("");
  list.querySelectorAll(".gcard").forEach((card) => {
    card.addEventListener("click", () => {
      const group = card.dataset.group;
      if (group) navigate("detail", group);
    });
  });
}

/** True if the group had activity within the last 24h. */
function isFreshGroup(group) {
  return group.lastMessageAt
    ? Date.now() - new Date(group.lastMessageAt).getTime() < 24 * 60 * 60 * 1000
    : false;
}

/** Deterministic avatar emoji from the group name (no real data needed). */
const AVATARS = ["💬", "🗨️", "📨", "🌀", "✦", "🪐", "🔆", "🎐"];
function groupEmoji(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

/** Build a single group card (freshness only — no message counts). */
function buildGroupCard(group) {
  const ago = formatAgo(group.lastMessageAt);
  const fresh = isFreshGroup(group);
  const cls = fresh ? "gcard gcard--fresh" : "gcard gcard--dim";
  const ringCls = fresh ? "ring ring--fresh" : "ring ring--muted";
  const meta = fresh
    ? `<span class="gcard__live">● פעיל</span>${ago ? ` · ${escHtml(ago)}` : ""}`
    : ago ? escHtml(ago) : "—";
  const cta = fresh
    ? `<div class="gcard__cta" aria-hidden="true">סכם מה שפספסתי ›</div>`
    : "";
  return `
    <div class="${cls}" role="listitem" data-group="${escHtml(group.name)}"
      tabindex="0" aria-label="סכם מה שפספסתי בקבוצה ${escHtml(formatGroupName(group.name))}">
      <span class="${ringCls}" aria-hidden="true">${groupEmoji(group.name)}</span>
      <div class="gcard__name">${escHtml(formatGroupName(group.name))}</div>
      <div class="gcard__meta">${meta}</div>
      ${cta}
    </div>
  `;
}

function buildSkeletonCards(count) {
  return Array.from({ length: count }, () => `
    <div class="gcard gcard--loading" aria-hidden="true">
      <div class="skeleton" style="width:55%;height:16px;margin-bottom:10px"></div>
      <div class="skeleton" style="width:75%"></div>
    </div>
  `).join("");
}

/** Highlight the active group row in the sidebar (or clear with null). */
function markActiveRow(group) {
  document.querySelectorAll(".gcard").forEach((c) => {
    c.classList.toggle("gcard--active", !!group && c.dataset.group === group);
  });
}

/* ── 5. Detail view ──────────────────────────────────────── */

const detailState = {
  group: null,
  started: 0,
  syncingTimer: null,
  syncingStart: 0,
  summaryText: "",
  phase: "idle",
  activeChip: "catchup",
  cachedSummaryText: null,
  showingCachedCard: false,
  backgroundRefreshStarted: false,
};

function renderDetail(group, autoStart) {
  teardownStream();
  const meta = cachedGroups.find((g) => g.name === group) || { name: group };
  const ago = formatAgo(meta.lastMessageAt);
  const fresh = isFreshGroup(meta);

  detailState.group = group;
  detailState.summaryText = "";
  detailState.phase = "idle";
  detailState.activeChip = "catchup";
  detailState.cachedSummaryText = null;
  detailState.showingCachedCard = false;
  detailState.backgroundRefreshStarted = false;

  paneMain.innerHTML = buildDetailShell(group, ago, fresh);
  setView("detail");
  markActiveRow(group);
  wireDetailButtons(group);
  loadHistory(group);

  if (autoStart) {
    setActiveChip("catchup");
    if (DEMO) {
      if (DEMO === "tube") {
        setSummaryRegion(buildPhaseTube({ phase: "read", messages: 247, elapsed: 12 }));
      } else {
        setSummaryRegion(buildSummaryCardDone(DEMO_SUMMARY, "נשמר • 8.4 שניות • 247 הודעות", false));
      }
      return;
    }
    void runDetailWithCacheFirst(group);
  }
}

async function runDetailWithCacheFirst(group) {
  let cached = null;
  try {
    const history = await getSummaries(group, 1);
    if (history && history.length > 0 && history[0].output?.overview) cached = history[0];
  } catch {
    /* fall through to cold open */
  }

  if (cached) {
    detailState.cachedSummaryText = cached.output.overview;
    detailState.showingCachedCard = true;
    const statusText = `מהמטמון • נוצר ב־${fmtTime(cached.createdAt)}`;
    setSummaryRegion(buildSummaryCardDone(cached.output.overview, statusText, false));
    const openedGroup = group;
    setTimeout(() => {
      if (shouldStartBackgroundRefresh({
        hasCached: true,
        openedGroup,
        currentDetailGroup: detailState.group,
        backgroundRefreshStarted: detailState.backgroundRefreshStarted,
      })) {
        detailState.backgroundRefreshStarted = true;
        runSummary({ mode: "catchup", group: openedGroup }, true);
      }
    }, 400);
  } else {
    runSummary({ mode: "catchup", group }, false);
  }
}

function buildDetailShell(group, ago, fresh) {
  const freshLine = ago
    ? `<div class="detail-gfresh">${fresh ? '<span class="gcard__live">● פעיל</span> · ' : ""}${escHtml(ago)}</div>`
    : "";
  return `
    <div class="detail-view">
      <nav class="detail-nav" aria-label="ניווט">
        <button class="back-btn" id="back-btn" aria-label="חזרה לרשימת הקבוצות">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
      </nav>

      <div class="detail-ghead">
        <h2 class="detail-gtitle">${escHtml(formatGroupName(group))}</h2>
        ${freshLine}
      </div>

      <div class="chips mode-chips" role="group" aria-label="בחירת טווח זמן" id="mode-chips">
        <button class="chip chip--active" data-chip="catchup" aria-pressed="true">מה שפספסתי</button>
        <button class="chip" data-chip="24h" aria-pressed="false">24 שעות</button>
        <button class="chip" data-chip="3d" aria-pressed="false">3 ימים</button>
        <button class="chip" data-chip="week" aria-pressed="false">שבוע</button>
        <button class="chip" data-chip="month" aria-pressed="false">חודש</button>
        <button class="chip" data-chip="range" aria-pressed="false">טווח…</button>
      </div>

      <div id="summary-region" aria-live="polite" aria-atomic="false"></div>

      <div id="range-sheet" class="range-sheet" aria-modal="true" role="dialog" aria-label="בחירת טווח זמן" hidden>
        <div class="range-sheet__handle" aria-hidden="true"></div>
        <h4 class="range-sheet__title">בחירת טווח</h4>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-datetime">📅 מתאריך ושעה</label>
          <input id="range-datetime" class="range-sheet__input" type="datetime-local" aria-label="תאריך ושעה התחלה" />
        </div>
        <div class="range-sheet__until">
          <span class="range-sheet__until-label">עד:</span>
          <span class="range-sheet__until-val">עכשיו</span>
        </div>
        <div class="range-sheet__divider" aria-hidden="true">— או —</div>
        <div class="range-sheet__field">
          <label class="range-sheet__label" for="range-lastn">📩 הודעות אחרונות</label>
          <input id="range-lastn" class="range-sheet__input" type="number" min="1" step="1"
            placeholder="לדוגמה: 100" aria-label="מספר הודעות אחרונות" />
        </div>
        <p id="range-error" class="range-sheet__error" aria-live="polite" hidden></p>
        <button class="range-sheet__go" id="range-go">סכם את הטווח הזה</button>
        <button class="range-sheet__cancel" id="range-cancel">ביטול</button>
      </div>

      <section class="history-section" id="history-section" aria-label="סיכומים קודמים">
        <div id="history-list" class="history-list" aria-live="polite" hidden></div>
      </section>

      <button class="ama-bar" id="ama-bar-group" type="button" aria-label="שאל על הצ׳אט הזה">
        <span class="ama-bar__spark" aria-hidden="true">✨</span>
        <span class="ama-bar__text">שאל על הצ׳אט הזה…</span>
        <span class="ama-bar__send" aria-hidden="true">➤</span>
      </button>
    </div>
  `;
}

function wireDetailButtons(group) {
  document.getElementById("back-btn")?.addEventListener("click", () => navigate("feed"));
  document.getElementById("mode-chips")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-chip]");
    if (btn) onChipClick(btn.dataset.chip);
  });
  document.getElementById("range-go")?.addEventListener("click", () => onRangeSubmit());
  document.getElementById("range-cancel")?.addEventListener("click", () => closeRangeSheet());
  document.getElementById("ama-bar-group")?.addEventListener("click", () => navigate("ama", group));
}

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
    runSummary({ since: presetToSince(chip), group: detailState.group });
  }
}

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

/* ── 5a. Range sheet ─────────────────────────────────────── */

function openRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (!sheet) return;
  sheet.hidden = false;
  const err = document.getElementById("range-error");
  if (err) { err.hidden = true; err.textContent = ""; }
  document.getElementById("range-datetime")?.focus();
}

function closeRangeSheet() {
  const sheet = document.getElementById("range-sheet");
  if (sheet) sheet.hidden = true;
}

function onRangeSubmit() {
  const datetime = document.getElementById("range-datetime")?.value || "";
  const lastNRaw = (document.getElementById("range-lastn")?.value || "").trim();
  const errEl = document.getElementById("range-error");

  let result;
  if (lastNRaw !== "") {
    const n = parseInt(lastNRaw, 10);
    result = validateRangeInput({ mode: "last", n: isNaN(n) ? null : n });
  } else {
    result = validateRangeInput({ mode: "since", datetime });
  }

  if (!result.ok) {
    if (errEl) { errEl.textContent = result.error; errEl.hidden = false; }
    return;
  }
  closeRangeSheet();
  if (result.last !== undefined) {
    runSummary({ last: result.last, group: detailState.group });
  } else {
    runSummary({ since: result.since, group: detailState.group });
  }
}

/* ── 5b. runSummary — generic streaming runner ───────────── */

function runSummary(params, background = false) {
  teardownStream();
  if (!detailState.group) return;

  detailState.started = Date.now();
  detailState.syncingTimer = null;
  detailState.syncingStart = 0;
  detailState.summaryText = "";
  detailState.phase = "streaming";

  if (!background) {
    detailState.cachedSummaryText = null;
    detailState.showingCachedCard = false;
    showUpdatingChip(false);
    setSummaryRegion(buildPhaseTube({ phase: "sync", elapsed: 0 }));
  }
  if (background && detailState.showingCachedCard) showUpdatingChip(true);

  activeEventSource = summarizeStream(params, {
    syncing: onSyncing,
    status: onStatus,
    token: onToken,
    cached: onCached,
    empty: onEmpty,
    done: onDone,
    error: onError,
  });
}

function teardownStream() {
  if (detailState.syncingTimer) { clearInterval(detailState.syncingTimer); detailState.syncingTimer = null; }
  if (totalLoaderTimer) { clearInterval(totalLoaderTimer); totalLoaderTimer = null; }
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
}

/* ── 5c. SSE event handlers ──────────────────────────────── */

function onSyncing(data) {
  if (detailState.showingCachedCard) return;
  if (data.phase === "start") {
    detailState.syncingStart = Date.now();
    setSummaryRegion(buildPhaseTube({ phase: "sync", elapsed: 0 }));
    detailState.syncingTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - detailState.syncingStart) / 1000);
      setTubeElapsed(elapsed);
    }, 500);
  } else if (data.phase === "done") {
    clearSyncingTimer();
    setSummaryRegion(buildPhaseTube({ phase: "read", elapsed: Math.round(data.fetchMs / 1000), messages: data.fetched }));
  }
}

function onStatus(data) {
  if (detailState.showingCachedCard) { clearSyncingTimer(); return; }
  clearSyncingTimer();
  const elapsed = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
  setSummaryRegion(buildPhaseTube({ phase: "read", messages: data.messages || 0, elapsed }));
  detailState.syncingTimer = setInterval(() => {
    const secs = detailState.started ? Math.round((Date.now() - detailState.started) / 1000) : 0;
    setTubeElapsed(secs);
  }, 1000);
}

function onToken(data) {
  if (detailState.showingCachedCard) { detailState.summaryText += data.delta; return; }
  detailState.summaryText += data.delta;
  let body = document.querySelector(".summary-card--streaming .summary-card__body");
  if (!body) {
    setSummaryRegion(buildSummaryCardStreaming(detailState.summaryText, ""));
    body = document.querySelector(".summary-card--streaming .summary-card__body");
  } else {
    body.innerHTML = `${renderMarkdown(detailState.summaryText)}<span class="caret" aria-hidden="true"></span>`;
    body.scrollTop = body.scrollHeight;
  }
}

function onCached(data) {
  clearSyncingTimer();
  detailState.phase = "cached";
  if (detailState.showingCachedCard) {
    showUpdatingChip(false);
    detailState.showingCachedCard = false;
    teardownStream();
    return;
  }
  detailState.summaryText = data.summary;
  const statusText = `אין חדש — מתוך מטמון • נוצר ב־${fmtTime(data.generatedAt)}`;
  setSummaryRegion(buildSummaryCardDone(detailState.summaryText, statusText, false));
  teardownStream();
}

function onEmpty() {
  clearSyncingTimer();
  detailState.phase = "empty";
  if (detailState.showingCachedCard) {
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
  showUpdatingChip(false);
  detailState.showingCachedCard = false;
  setSummaryRegion(buildSummaryCardDone(detailState.summaryText, parts.join(" • "), !!data.stale));
  teardownStream();
  if (detailState.group) loadHistory(detailState.group);
}

function onError(data) {
  clearSyncingTimer();
  detailState.phase = "error";
  if (detailState.showingCachedCard) {
    showUpdatingChip(false);
    teardownStream();
    return;
  }
  const msg = data?.message || "שגיאת חיבור.";
  setSummaryRegion(`<p class="detail-status detail-status--error" role="alert">${escHtml(msg)}</p>`);
  teardownStream();
}

/* ── 5d. Phase Tube + summary builders ───────────────────── */

/**
 * Liquid Phase Tube — phase-aware loader.
 * @param {{ phase: string, messages?: number, elapsed?: number }} opts
 */
function buildPhaseTube({ phase = "sync", messages = 0, elapsed = 0 } = {}) {
  const fill = phaseFill(phase);
  const active = activeZoneIndex(phase);
  const caption = phaseCaption(phase, { messages });
  const elapsedStr = elapsed > 0 ? `${elapsed}ש׳` : "";
  // Labels render in phase order; RTL places the first (סנכרון) on the right.
  const labels = PHASES.map((p, i) =>
    `<span class="phase-tube__label${i <= active ? " is-lit" : ""}${i === active ? " is-active" : ""}">${PHASE_LABELS[p]}</span>`
  ).join("");
  return `
    <div class="phase-tube-wrap glass-card" role="status" aria-live="polite" aria-label="${escHtml(caption)}">
      <div class="phase-tube__aurora" aria-hidden="true"></div>
      <div class="phase-tube__cap">
        <span class="phase-tube__caption">${escHtml(caption)}</span>
        <span class="phase-tube__elapsed" id="tube-elapsed">${escHtml(elapsedStr)}</span>
      </div>
      <div class="phase-tube" aria-hidden="true">
        <div class="phase-tube__liq" style="width:${fill}%"></div>
        <span class="phase-tube__zone" style="right:25%"></span>
        <span class="phase-tube__zone" style="right:50%"></span>
        <span class="phase-tube__zone" style="right:75%"></span>
      </div>
      <div class="phase-tube__labels">${labels}</div>
    </div>
  `;
}

/** Update the live elapsed counter inside the tube. */
function setTubeElapsed(sec) {
  const el = document.getElementById("tube-elapsed");
  if (el) el.textContent = `${sec}ש׳`;
}

/** Update the liquid fill width (used by the total-view scan). */
function setTubeFill(pct) {
  const liq = document.querySelector(".phase-tube__liq");
  if (liq) liq.style.width = `${pct}%`;
}

function buildSummaryCardStreaming(text) {
  if (!text.length) return buildPhaseTube({ phase: "summarize", elapsed: 0 });
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
        <span aria-hidden="true">⚠️</span><span>נתונים עלולים להיות לא עדכניים</span>
      </div>` : ""}
    <div class="glass-card summary-card">
      <div class="summary-card__meta"><span>${escHtml(statusText)}</span></div>
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
      <div class="summary-card__meta"><span>אין חדש</span></div>
      <p class="detail-status">אין הודעות חדשות לסיכום.</p>
    </div>
  `;
}

function showUpdatingChip(show) {
  let host = document.getElementById("updating-chip-host");
  if (!host) {
    const region = document.getElementById("summary-region");
    if (!region) return;
    host = document.createElement("div");
    host.id = "updating-chip-host";
    region.parentNode.insertBefore(host, region);
  }
  host.innerHTML = show
    ? `<div class="updating-chip" role="status" aria-live="polite" aria-label="מתעדכן">
         <span class="updating-chip__dot" aria-hidden="true"></span>
         <span class="updating-chip__text">מתעדכן…</span>
       </div>`
    : "";
}

/* ── 5e. Copy button (delegated) ─────────────────────────── */

function wireCopyButton() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const text = btn.dataset.text != null ? btn.dataset.text : detailState.summaryText;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
      }
      btn.textContent = "הועתק!";
      btn.classList.add("copy-btn--confirm");
      setTimeout(() => { btn.textContent = "📋 העתק סיכום"; btn.classList.remove("copy-btn--confirm"); }, 2000);
    } catch {
      btn.textContent = "לא ניתן להעתיק";
      setTimeout(() => { btn.textContent = "📋 העתק סיכום"; }, 2000);
    }
  });
}

/* ── 5f. History ─────────────────────────────────────────── */

function summaryTypeLabel(type) {
  switch (type) {
    case "watermark": return "מה שפספסתי";
    case "last_n": return "הודעות אחרונות";
    case "since": return "טווח זמן";
    default: return escHtml(type);
  }
}

async function loadHistory(group) {
  const section = document.getElementById("history-section");
  const listEl = document.getElementById("history-list");
  if (!section || !listEl) return;

  let summaries;
  try {
    summaries = await getSummaries(group);
  } catch {
    _renderHistoryToggle(section, listEl, 0, true);
    return;
  }

  if (!summaries || summaries.length === 0) {
    section.querySelector(".history-toggle")?.remove();
    listEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }

  const sorted = [...summaries].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  listEl.innerHTML = sorted.map((s) => buildHistoryRow(s)).join("");
  listEl.querySelectorAll(".history-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".history-row__body")) return;
      toggleHistoryRow(row);
    });
  });
  _renderHistoryToggle(section, listEl, sorted.length, false);
}

function _renderHistoryToggle(section, listEl, count, error) {
  const existingToggle = section.querySelector(".history-toggle");
  const wasOpen = existingToggle ? existingToggle.getAttribute("aria-expanded") === "true" : false;
  if (existingToggle) existingToggle.remove();

  if (error) {
    listEl.hidden = true;
    listEl.innerHTML = `<p class="history-empty">שגיאה בטעינת היסטוריה.</p>`;
    return;
  }
  if (count === 0) { listEl.hidden = true; return; }

  const toggle = document.createElement("button");
  toggle.className = "history-toggle";
  toggle.setAttribute("aria-expanded", wasOpen ? "true" : "false");
  toggle.setAttribute("aria-controls", "history-list");
  toggle.innerHTML = `<span class="history-toggle__label">סיכומים קודמים (${count})</span><span class="history-toggle__chevron" aria-hidden="true">▾</span>`;
  section.insertBefore(toggle, listEl);

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
    toggle.querySelector(".history-toggle__chevron")?.classList.toggle("history-toggle__chevron--open", !open);
  });
}

function buildHistoryRow(s) {
  const label = summaryTypeLabel(s.summaryType);
  const ts = fmtTime(s.createdAt);
  const bodyText = s.output?.overview ?? "";
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

function toggleHistoryRow(row) {
  const body = row.querySelector(".history-row__body");
  const chevron = row.querySelector(".history-row__chevron");
  if (!body) return;
  const expanded = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", expanded ? "false" : "true");
  body.hidden = expanded;
  chevron?.classList.toggle("history-row__chevron--open", !expanded);
}

/* ── 6. Total view ───────────────────────────────────────── */

function renderTotal(autoStart) {
  teardownStream();
  paneMain.innerHTML = buildTotalShell();
  setView("total");
  markActiveRow(null);

  document.getElementById("total-back-btn")?.addEventListener("click", () => navigate("feed"));
  const chipsContainer = document.getElementById("total-chips");
  chipsContainer?.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-since]");
    if (!btn) return;
    chipsContainer.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("chip--active", c === btn);
      c.setAttribute("aria-pressed", c === btn ? "true" : "false");
    });
    runTotal({ since: btn.dataset.since });
  });

  if (autoStart) {
    if (DEMO) {
      const card = document.getElementById("total-highlights");
      const body = document.getElementById("total-highlights-body");
      if (card) card.hidden = false;
      if (body) body.innerHTML = renderMarkdown(DEMO_TOTAL_HIGHLIGHTS);
      renderTotalPerChat(DEMO_TOTAL_PERCHAT);
      return;
    }
    runTotal({ since: defaultTotalSince() });
  }
}

function defaultTotalSince() {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
}

function buildTotalShell() {
  const since24h = defaultTotalSince();
  const since3d = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const sinceWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  return `
    <div class="detail-view total-view">
      <nav class="detail-nav" aria-label="ניווט">
        <button class="back-btn" id="total-back-btn" aria-label="חזרה לרשימת הקבוצות">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
      </nav>
      <div class="detail-ghead detail-ghead--center">
        <h2 class="detail-gtitle">📊 סיכום כללי</h2>
        <div class="detail-gfresh">מה קרה בכל הצ׳אטים</div>
      </div>
      <div class="chips mode-chips chips--center" role="group" aria-label="בחירת טווח זמן" id="total-chips">
        <button class="chip chip--active" data-since="${escHtml(since24h)}" aria-pressed="true">24 שעות</button>
        <button class="chip" data-since="${escHtml(since3d)}" aria-pressed="false">3 ימים</button>
        <button class="chip" data-since="${escHtml(sinceWeek)}" aria-pressed="false">שבוע</button>
      </div>
      <div id="total-loader" aria-live="polite"></div>
      <p id="total-error" class="detail-status detail-status--error" role="alert" hidden></p>
      <div id="total-highlights" class="glass-card summary-card" hidden>
        <div id="total-highlights-body" class="summary-card__body summary-card__body--rendered"></div>
      </div>
      <div id="total-perchat" class="total-perchat-list"></div>
    </div>
  `;
}

function showTotalLoader(phase, opts = {}) {
  const region = document.getElementById("total-loader");
  if (region) region.innerHTML = buildPhaseTube({ phase, elapsed: 0, ...opts });
}

function clearTotalLoader() {
  const region = document.getElementById("total-loader");
  if (region) region.innerHTML = "";
  if (totalLoaderTimer) { clearInterval(totalLoaderTimer); totalLoaderTimer = null; }
}

function renderTotalPerChat(perChat) {
  const perChatEl = document.getElementById("total-perchat");
  if (!perChatEl) return;
  if (perChat.length === 0) { perChatEl.innerHTML = ""; return; }
  const chats = perChat.slice().sort((a, b) => Number(b.messageCount) - Number(a.messageCount));
  const heading = `<h3 class="total-section-heading">לפי צ׳אט · ${chats.length} צ׳אטים</h3>`;
  const items = chats.map((c) => `
    <details class="perchat glass-card">
      <summary class="perchat__summary">
        <span class="perchat__name">${escHtml(c.name)}</span>
      </summary>
      <div class="perchat__body summary-card__body--rendered">${renderMarkdown(c.summary)}</div>
    </details>
  `).join("");
  perChatEl.innerHTML = heading + items;
}

function runTotal({ since }) {
  teardownStream();
  const highlightsCard = document.getElementById("total-highlights");
  const highlightsBody = document.getElementById("total-highlights-body");
  const perChatEl = document.getElementById("total-perchat");
  const errorEl = document.getElementById("total-error");
  if (highlightsCard) highlightsCard.hidden = true;
  if (highlightsBody) highlightsBody.innerHTML = "";
  if (perChatEl) perChatEl.innerHTML = "";
  if (errorEl) errorEl.hidden = true;

  const startedAt = Date.now();
  showTotalLoader("read");
  totalLoaderTimer = setInterval(() => {
    setTubeElapsed(Math.round((Date.now() - startedAt) / 1000));
  }, 1000);

  let raw = "";
  let loaderActive = true;
  const es = new EventSource(`/api/total-summary?since=${encodeURIComponent(since)}`);
  activeEventSource = es;

  es.addEventListener("status", (e) => {
    const d = JSON.parse(e.data);
    if (d.phase === "chat" && loaderActive) {
      const cap = document.querySelector("#total-loader .phase-tube__caption");
      if (cap) cap.textContent = `📖 מסכם את "${d.name}" · צ׳אט ${d.index} מתוך ${d.total}`;
      if (d.total > 0) setTubeFill(scanFill(d.index - 1, d.total));
    }
  });

  es.addEventListener("token", (e) => {
    if (loaderActive) { loaderActive = false; clearTotalLoader(); }
    raw += JSON.parse(e.data).delta;
    if (highlightsCard) highlightsCard.hidden = false;
    if (highlightsBody) highlightsBody.innerHTML = `${renderMarkdown(raw)}<span class="caret" aria-hidden="true"></span>`;
  });

  es.addEventListener("done", (e) => {
    const d = JSON.parse(e.data);
    loaderActive = false;
    clearTotalLoader();
    if (highlightsCard) highlightsCard.hidden = false;
    if (highlightsBody) highlightsBody.innerHTML = renderMarkdown(d.highlights);
    renderTotalPerChat(d.perChat || []);
    teardownStream();
  });

  es.addEventListener("error", (e) => {
    let msg = "שגיאה בהפקת הסיכום.";
    try { const data = JSON.parse(e.data); if (data?.message) msg = data.message; } catch { /* native error */ }
    loaderActive = false;
    clearTotalLoader();
    if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; }
    teardownStream();
  });
}

/* ── 7. AMA view (stub) ──────────────────────────────────── */

/**
 * Render the Ask-Me-Anything chat panel.
 * @param {string|null} scope — null for global, group name for per-group
 */
function renderAma(scope) {
  teardownStream();
  amaConversation = createConversation();
  const sub = scope ? `על "${escHtml(formatGroupName(scope))}"` : "מחפש בכל השיחות שלך";
  paneMain.innerHTML = `
    <div class="ama-panel">
      <div class="ama-head">
        <button class="back-btn" id="ama-back-btn" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <span class="ama-head__orb" aria-hidden="true"></span>
        <div class="ama-head__txt">
          <div class="ama-head__title">שאל אותי הכל</div>
          <div class="ama-head__sub">${sub}</div>
        </div>
      </div>
      <div class="ama-messages" id="ama-messages" aria-live="polite">
        <div class="ama-empty">${scope ? "שאל כל שאלה על הצ׳אט הזה ✨" : "שאל כל שאלה על השיחות שלך ✨"}</div>
      </div>
      <form class="ama-input" id="ama-form">
        <input id="ama-q" class="ama-input__field" type="text" placeholder="שאל שאלה…"
          aria-label="שאלה" autocomplete="off" />
        <button class="ama-input__send" type="submit" aria-label="שלח">➤</button>
      </form>
    </div>
  `;
  setView("ama");
  markActiveRow(scope);

  document.getElementById("ama-back-btn")?.addEventListener("click", () => history.back());
  document.getElementById("ama-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("ama-q");
    const val = input?.value || "";
    if (!val.trim()) return;
    ask(amaConversation, val);
    if (input) input.value = "";
    renderAmaMessages();
  });
}

function renderAmaMessages() {
  const el = document.getElementById("ama-messages");
  if (!el) return;
  el.innerHTML = amaConversation.messages.map((m) => {
    if (m.role === "user") {
      return `<div class="ama-bubble ama-bubble--user">${escHtml(m.text)}</div>`;
    }
    return `<div class="ama-bubble ama-bubble--ai">${escHtml(m.text)}
      <span class="ama-bubble__src">↳ מקורות יחוברו בהמשך</span></div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

/* ── 8. Helpers ──────────────────────────────────────────── */

function formatGroupName(name) {
  if (!name) return name;
  if (name.endsWith("@s.whatsapp.net")) return "+" + name.slice(0, name.lastIndexOf("@"));
  if (name.endsWith("@lid")) return "איש קשר · …" + name.slice(0, name.lastIndexOf("@")).slice(-4);
  if (name.endsWith("@g.us")) return "קבוצה · …" + name.slice(0, name.lastIndexOf("@")).slice(-4);
  return name;
}

function setSummaryRegion(html) {
  const region = document.getElementById("summary-region");
  if (region) region.innerHTML = html;
}

function clearSyncingTimer() {
  if (detailState.syncingTimer) { clearInterval(detailState.syncingTimer); detailState.syncingTimer = null; }
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString("he-IL"); } catch { return iso; }
}

function escHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ── 9. Bootstrap ────────────────────────────────────────── */

function resolveInitialRoute() {
  const hash = location.hash;
  let m = hash.match(/^#group=(.+)$/);
  if (m) {
    const group = decodeURIComponent(m[1]);
    history.replaceState({ view: "detail", group }, "", hash);
    return { view: "detail", group };
  }
  if (hash === "#total") {
    history.replaceState({ view: "total" }, "", hash);
    return { view: "total" };
  }
  m = hash.match(/^#ama=(.+)$/);
  if (m) {
    const scope = decodeURIComponent(m[1]);
    history.replaceState({ view: "ama", scope }, "", hash);
    return { view: "ama", scope };
  }
  if (hash === "#ama") {
    history.replaceState({ view: "ama", scope: null }, "", hash);
    return { view: "ama", scope: null };
  }
  history.replaceState({ view: "feed" }, "", location.pathname);
  return { view: "feed" };
}

async function boot() {
  renderShell();
  if (DEMO) applyHealth(true);
  else startHealthPolling();
  wireCopyButton();

  const route = resolveInitialRoute();
  await loadGroupsIntoList();

  if (route.view === "detail") {
    renderDetail(route.group, true);
  } else if (route.view === "total") {
    renderTotal(true);
  } else if (route.view === "ama") {
    renderAma(route.scope ?? null);
  } else {
    setView("feed");
    renderMainWelcome();
  }
}

/** Desktop default for the main pane while on the feed (hidden on mobile). */
function renderMainWelcome() {
  paneMain.innerHTML = `
    <div class="main-welcome">
      <span class="main-welcome__orb" aria-hidden="true"></span>
      <p class="main-welcome__txt">בחר צ׳אט מהרשימה<br>או השתמש בפעולות שלמעלה ✨</p>
    </div>
  `;
}

boot();
