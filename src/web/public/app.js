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

import { actOnSuggestion, askStream, createScopeCategory, getGroups, getMeetings, getMessages, getPeople, getPreferences, getScopeCategories, getScopes, getStatus, getSummaries, getToday, getTodos, putPreferences, putScopes, setTodoDone, summarizeStream } from "./lib/api.js";
import { avatarTint, buildMonthGrid, eventDaySet, groupMeetingsByDay, peopleStatusMeta, relativeDay, todoProgress } from "./lib/agenda.js";
import { activeCount, filterScopes, groupByCategory, partitionRemoved, sectionCount } from "./lib/scopes.js";
import { DIGEST_CHOICES, ENGINE_KINDS, PROACT_LEVELS, isDigestSelected, normalizeEngineConfig, toggleDigestTime } from "./lib/prefs.js";
import { buildDeck, clampIndex, commitActionFor, emptyTally, greeting, indexAfterRemoval, isSuggestion, leavingVariant, peekCount, recordTally, removeCardById, segmentFills, suggestionConfig, tallyBits, tileCounts, TILE_KINDS } from "./lib/today.js";
import { formatAgo, presetToSince, validateRangeInput } from "./lib/time.js";
import { renderMarkdown } from "./lib/markdown.js";
import { deriveHealth } from "./lib/health.js";
import { shouldStartBackgroundRefresh } from "./lib/open-state.js";
import { PHASE_LABELS, PHASES, phaseFill, activeZoneIndex, phaseCaption, scanFill } from "./lib/phase-loader.js";
import { appendToken, beginQuestion, createConversation, failAnswer, finishAnswer, loadConversation, saveConversation, setPhase } from "./lib/ama-conversation.js";
import { DEMO_GROUPS, DEMO_SUMMARY, DEMO_SUMMARIES, DEMO_TOTAL_HIGHLIGHTS, DEMO_TOTAL_PERCHAT } from "./lib/demo-data.js";
import { applyTheme, readStoredTheme, resolveInitialTheme, setTheme } from "./lib/theme.js";
import { icon } from "./lib/icons.js";

/** Off by default. `?demo=1` previews dummy data; `?demo=tube` shows the loader. */
const DEMO = new URLSearchParams(location.search).get("demo");

/* ── 1. Globals ──────────────────────────────────────────── */

const layout = document.getElementById("layout");
const topBar = document.getElementById("top-bar");
const paneList = document.getElementById("pane-list");
const paneMain = document.getElementById("pane-main");
const staleBanner = document.getElementById("stale-banner");

/** Active theme ("light" | "dark"). The pre-paint snippet in index.html already
 *  reflected this onto <html>; we resolve it again here to drive the toggle. */
let currentTheme = resolveInitialTheme(
  readStoredTheme(),
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
);
applyTheme(currentTheme);

/** Currently open EventSource (cleaned up on view change). */
let activeEventSource = null;
/** Total-view loader elapsed-timer handle. */
let totalLoaderTimer = null;
/** Health poll interval id. */
let healthInterval = null;
/** Cached groups list. */
let cachedGroups = [];
/** Active AMA conversation (restored from sessionStorage when the panel opens). */
let amaConversation = createConversation();
/** Scope of the active AMA conversation, for persistence keying. */
let amaScope = null;

/** sessionStorage, or null if the browser blocks access (private mode, etc.). */
function amaStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/* ── 2. Routing ──────────────────────────────────────────── */

/** Set the visible-pane hint for CSS. */
function setView(view) {
  if (layout) layout.dataset.view = view;
}

/**
 * Navigate to a view, pushing a history entry.
 * @param {"feed"|"detail"|"total"|"ama"|"thread"|"sources"|"settings"|"today"|"people"|"agenda"} view
 * @param {string} [arg] — group name (detail) or AMA scope (ama)
 */
function navigate(view, arg) {
  if (view === "today") {
    history.pushState({ view: "today" }, "", "#today");
    renderToday();
  } else if (view === "detail" && arg) {
    history.pushState({ view: "detail", group: arg }, "", `#group=${encodeURIComponent(arg)}`);
    renderDetail(arg, true);
  } else if (view === "total") {
    history.pushState({ view: "total" }, "", "#total");
    renderTotal(true);
  } else if (view === "ama") {
    const hash = arg ? `#ama=${encodeURIComponent(arg)}` : "#ama";
    history.pushState({ view: "ama", scope: arg ?? null }, "", hash);
    renderAma(arg ?? null);
  } else if (view === "thread" && arg) {
    history.pushState(
      { view: "thread", chat: arg.chat, aroundId: arg.aroundId },
      "",
      `#thread=${encodeURIComponent(arg.chat)}&m=${arg.aroundId}`,
    );
    renderThread(arg.chat, arg.aroundId);
  } else if (view === "sources") {
    history.pushState({ view: "sources" }, "", "#sources");
    renderSources();
  } else if (view === "settings") {
    history.pushState({ view: "settings" }, "", "#settings");
    renderSettings();
  } else if (view === "people") {
    history.pushState({ view: "people" }, "", "#people");
    renderPeople();
  } else if (view === "agenda") {
    history.pushState({ view: "agenda" }, "", "#agenda");
    renderAgenda();
  } else {
    history.pushState({ view: "feed" }, "", location.pathname);
    setView("feed");
    markActiveRow(null);
  }
}

window.addEventListener("popstate", (e) => {
  teardownStream();
  const state = e.state;
  if (state?.view === "today") {
    renderToday();
  } else if (state?.view === "detail" && state.group) {
    renderDetail(state.group, false);
  } else if (state?.view === "total") {
    renderTotal(false);
  } else if (state?.view === "sources") {
    renderSources();
  } else if (state?.view === "settings") {
    renderSettings();
  } else if (state?.view === "people") {
    renderPeople();
  } else if (state?.view === "agenda") {
    renderAgenda();
  } else if (state?.view === "ama") {
    renderAma(state.scope ?? null);
  } else if (state?.view === "thread" && state.chat) {
    renderThread(state.chat, state.aroundId);
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
      <button class="feat feat--today" id="today-card" type="button" aria-label="הסיכום היומי">
        <span class="feat__ico" aria-hidden="true">✦</span>
        <span class="feat__title">היום</span>
        <span class="feat__sub">הסיכום היומי שלך</span>
        <span class="feat__hint">פתח את הסיכום ›</span>
      </button>
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
      <button class="feat feat--people" id="people-card" type="button" aria-label="אנשים">
        <span class="feat__ico" aria-hidden="true">👥</span>
        <span class="feat__title">אנשים</span>
        <span class="feat__sub">מי מחכה לתשובה</span>
        <span class="feat__hint">פתח את האנשים ›</span>
      </button>
      <button class="feat feat--agenda" id="agenda-card" type="button" aria-label="פגישות ומשימות">
        <span class="feat__ico" aria-hidden="true">🗓️</span>
        <span class="feat__title">פגישות ומשימות</span>
        <span class="feat__sub">היומן והמשימות שלך</span>
        <span class="feat__hint">פתח את היומן ›</span>
      </button>
    </div>
    <div class="health-pill" role="status" aria-live="polite">
      <span class="health-pill__dot"></span><span>טוען…</span>
    </div>
    <button id="settings-gear" class="theme-toggle" type="button" aria-label="הגדרות">${icon("sliders")}</button>
    ${themeToggleHtml()}
  `;

  paneList.innerHTML = `
    <div class="search-wrap">
      <input id="search-input" class="search-input" type="search"
        placeholder="🔍  חיפוש קבוצה…" aria-label="חיפוש קבוצה"
        autocomplete="off" autocorrect="off" spellcheck="false" />
    </div>
    <div class="seclabel seclabel--row">
      <span>הקבוצות שלי</span>
      <button class="manage-sources" id="manage-sources" type="button">נהל צ׳אטים ›</button>
    </div>
    <div class="feed-list" id="feed-list" role="list" aria-live="polite">
      ${buildSkeletonCards(3)}
    </div>
  `;

  document.getElementById("today-card")?.addEventListener("click", () => navigate("today"));
  document.getElementById("ama-card").addEventListener("click", () => navigate("ama"));
  document.getElementById("total-card").addEventListener("click", () => navigate("total"));
  document.getElementById("people-card")?.addEventListener("click", () => navigate("people"));
  document.getElementById("agenda-card")?.addEventListener("click", () => navigate("agenda"));
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
  document.getElementById("settings-gear")?.addEventListener("click", () => navigate("settings"));
  document.getElementById("manage-sources")?.addEventListener("click", () => navigate("sources"));
  const input = document.getElementById("search-input");
  if (input) input.addEventListener("input", () => renderGroupList(cachedGroups, input.value));
}

/** Top-bar בהיר/כהה control. Shows the icon of the mode it switches TO. */
function themeToggleHtml() {
  const toDark = currentTheme !== "dark";
  return `<button id="theme-toggle" class="theme-toggle" type="button"
    aria-label="${toDark ? "מעבר למצב כהה" : "מעבר למצב בהיר"}">${icon(toDark ? "moon" : "sun")}</button>`;
}

/** Flip + persist the theme, updating the toggle button in place (re-rendering
 *  the whole shell would reset the populated group list to skeletons). */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  setTheme(currentTheme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.outerHTML = themeToggleHtml();
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
}

/** Fetch groups and populate the list, filtered to included (non-excluded/removed) chats. */
async function loadGroupsIntoList() {
  if (DEMO) { cachedGroups = DEMO_GROUPS; renderGroupList(cachedGroups, ""); return; }
  let groups;
  try {
    groups = await getGroups();
  } catch {
    const list = document.getElementById("feed-list");
    if (list) list.innerHTML = `<p class="error-state">שגיאה בטעינת הקבוצות. אנא רעננו את הדף.</p>`;
    return;
  }
  // Scope filter (S4 §3): hide excluded/removed chats. Resilient — on any scope
  // failure, fall back to showing all groups (default-on).
  try {
    const excluded = new Set(
      (await getScopes()).filter((s) => !s.included || s.removed).map((s) => s.group),
    );
    groups = groups.filter((g) => !excluded.has(g.name));
  } catch {
    /* show all on scope-load failure */
  }
  cachedGroups = groups;
  if (cachedGroups.length === 0) {
    const list = document.getElementById("feed-list");
    if (list) {
      list.innerHTML =
        `<p class="empty-state">אין צ׳אטים מוזנים. <button class="manage-sources" id="empty-manage">נהל צ׳אטים ›</button></p>`;
      document.getElementById("empty-manage")?.addEventListener("click", () => navigate("sources"));
    }
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
  if (!DEMO) loadHistory(group);

  if (autoStart) {
    setActiveChip("catchup");
    if (DEMO) {
      if (DEMO === "tube") {
        setSummaryRegion(buildPhaseTube({ phase: "read", messages: 247, elapsed: 12 }));
      } else {
        setSummaryRegion(buildSummaryCardDone(DEMO_SUMMARIES[group] || DEMO_SUMMARY, "נשמר • 8.4 שניות • 247 הודעות", false));
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
    detailState.summaryText = cached.output.overview; // so copy works on the cached card
    detailState.showingCachedCard = true;
    const statusText = `מהמטמון • נוצר ב־${fmtTime(cached.createdAt)}`;
    setSummaryRegion(buildStructuredSummaryCard(cached.output, statusText, false));
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
  // Source-jump: a structured-summary bullet → the chat thread, pulsing the source.
  document.getElementById("summary-region")?.addEventListener("click", (e) => {
    const jump = e.target.closest?.(".sum-jump");
    if (!jump || !detailState.group) return;
    const id = Number(jump.dataset.id);
    if (Number.isFinite(id)) navigate("thread", { chat: detailState.group, aroundId: id });
  });
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
  // Prefer the structured summary carried on `done`; keep summaryText as the full
  // markdown so the copy button still copies the verbatim summary.
  if (data.summary?.overview) detailState.summaryText = data.summary.overview;
  const statusText = parts.join(" • ");
  setSummaryRegion(
    data.summary
      ? buildStructuredSummaryCard(data.summary, statusText, !!data.stale)
      : buildSummaryCardDone(detailState.summaryText, statusText, !!data.stale),
  );
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

/** Render a section's bullets; those with a sourceMessageId become source-jump buttons. */
function renderSumBullets(bullets) {
  return bullets
    .map((b) => {
      const text = escHtml(b.text);
      if (b.sourceMessageId) {
        return `<li><button type="button" class="sum-jump" data-id="${b.sourceMessageId}">` +
          `<span class="sum-jump__text">${text}</span>` +
          `<span class="sum-jump__icon" aria-hidden="true">↩︎</span></button></li>`;
      }
      return `<li class="sum-item">${text}</li>`;
    })
    .join("");
}

/**
 * Structured summary-first card (§3). Falls back to the markdown card for legacy
 * (version !== 2) or missing structure, so nothing ever fails to render.
 * @param {{version:number, overview:string, tldr:string, topics:Array, decisions:Array, openQuestions:Array}} summary
 */
function buildStructuredSummaryCard(summary, statusText, stale) {
  if (!summary || summary.version !== 2) {
    return buildSummaryCardDone(summary?.overview ?? "", statusText, stale);
  }
  const section = (title, bullets) =>
    bullets && bullets.length
      ? `<div class="sum-section"><h4 class="sum-section__title">${title}</h4>` +
        `<ul class="sum-list">${renderSumBullets(bullets)}</ul></div>`
      : "";
  const tldr = summary.tldr
    ? `<div class="sum-section sum-section--tldr"><p class="sum-tldr">${escHtml(summary.tldr)}</p></div>`
    : "";
  return `
    ${stale ? `
      <div class="stale-note" role="alert">
        <span aria-hidden="true">⚠️</span><span>נתונים עלולים להיות לא עדכניים</span>
      </div>` : ""}
    <div class="glass-card summary-card sum-card">
      <div class="summary-card__meta"><span>${escHtml(statusText)}</span></div>
      ${tldr}
      ${section("נושאים עיקריים", summary.topics)}
      ${section("החלטות ומשימות", summary.decisions)}
      ${section("שאלות פתוחות", summary.openQuestions)}
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

/* ── 7. AMA view ─────────────────────────────────────────── */

/**
 * Render the Ask-Me-Anything chat panel.
 * @param {string|null} scope — null for global, group name for per-group
 */
function renderAma(scope) {
  teardownStream();
  amaScope = scope ?? null;
  amaConversation = loadConversation(amaStorage(), amaScope);
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
      ${amaSuggestHtml(scope)}
      <form class="ama-input" id="ama-form">
        <input id="ama-q" class="ama-input__field" type="text" placeholder="שאל שאלה…"
          aria-label="שאלה" autocomplete="off" />
        <button class="ama-input__send" type="submit" aria-label="שלח">➤</button>
      </form>
    </div>
  `;
  setView("ama");
  markActiveRow(scope);

  // Replace the empty-state hint with the restored thread, if there is one.
  if (amaConversation.messages.length) renderAmaMessages();

  document.getElementById("ama-back-btn")?.addEventListener("click", () => history.back());
  document.getElementById("ama-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAmaQuestion(scope);
  });

  // Delegate citation clicks (chips are re-rendered on every token) → source jump.
  document.getElementById("ama-messages")?.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".ama-src");
    if (!chip) return;
    const chat = chip.dataset.chat;
    const id = Number(chip.dataset.id);
    if (chat && Number.isFinite(id)) navigate("thread", { chat, aroundId: id });
  });

  // Suggestion chips fill the box and submit.
  for (const chip of document.querySelectorAll(".ama-suggest__chip")) {
    chip.addEventListener("click", () => {
      const input = document.getElementById("ama-q");
      if (input) input.value = chip.dataset.q || chip.textContent || "";
      submitAmaQuestion(scope);
    });
  }
}

/** Starter prompts shown above the input on the global Ask, before any question. */
const AMA_SUGGESTIONS = [
  "מה הכי דחוף מכל השיחות שלי?",
  "מה פספסתי היום?",
  "אילו החלטות פתוחות צריך לסגור?",
];

/** Suggestion-chip row — only on the global Ask with an empty thread. */
function amaSuggestHtml(scope) {
  if (scope || amaConversation.messages.length) return "";
  const chips = AMA_SUGGESTIONS.map(
    (q) => `<button type="button" class="ama-suggest__chip" data-q="${escHtml(q)}">${escHtml(q)}</button>`,
  ).join("");
  return `<div class="ama-suggest">${chips}</div>`;
}

/** No SSE activity for this long → treat the request as stuck and surface it. */
const AMA_STALL_MS = 120_000;
let amaStallTimer = null;

/** Send the typed question to /api/ask and stream the answer into the panel. */
function submitAmaQuestion(scope) {
  if (activeEventSource) return; // one question at a time
  const input = document.getElementById("ama-q");
  const q = (input?.value || "").trim();
  const reply = beginQuestion(amaConversation, q);
  if (!reply) return;
  if (input) input.value = "";
  document.querySelector(".ama-suggest")?.remove();
  renderAmaMessages();
  saveConversation(amaStorage(), amaScope, amaConversation);

  const settle = () => {
    if (amaStallTimer) { clearTimeout(amaStallTimer); amaStallTimer = null; }
    teardownStream();
    renderAmaMessages();
    saveConversation(amaStorage(), amaScope, amaConversation);
  };
  // Reset on every event; if the server goes silent for too long (a hung or
  // overloaded model), fail visibly instead of spinning "חושב…" forever.
  const armStall = () => {
    if (amaStallTimer) clearTimeout(amaStallTimer);
    amaStallTimer = setTimeout(() => {
      if (reply.pending) failAnswer(reply, "אין תגובה מהשרת. נסה שוב.");
      settle();
    }, AMA_STALL_MS);
  };
  armStall();

  activeEventSource = askStream({ q, chat: scope ?? undefined }, {
    phase: (d) => {
      armStall();
      setPhase(reply, d.phase);
      renderAmaMessages();
    },
    token: (d) => {
      armStall();
      appendToken(reply, d.delta);
      renderAmaMessages();
    },
    citations: (d) => finishAnswer(reply, d.citations),
    done: settle,
    error: (d) => {
      // A dropped connection after the answer completed is not a failure.
      if (reply.pending) failAnswer(reply, d.message);
      settle();
    },
  });
}

function renderAmaMessages() {
  const el = document.getElementById("ama-messages");
  if (!el) return;
  el.innerHTML = amaConversation.messages.map((m) => {
    if (m.role === "user") {
      return `<div class="ama-bubble ama-bubble--user">${escHtml(m.text)}</div>`;
    }
    if (m.pending && !m.text) {
      const label =
        m.phase === "searching" ? "מחפש בהודעות…" : m.phase === "synthesizing" ? "מנסח תשובה…" : "חושב…";
      return `<div class="ama-bubble ama-bubble--ai ama-bubble--pending">${label}</div>`;
    }
    const err = m.error ? `<span class="ama-bubble__err">${escHtml(m.error)}</span>` : "";
    return `<div class="ama-bubble ama-bubble--ai">${escHtml(m.text)}${err}${renderAmaSources(m.citations)}</div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

/** Render the resolved [n] citations under an answer bubble. Each chip is a
 *  button that jumps to the cited message in its chat thread. */
function renderAmaSources(citations) {
  if (!citations?.length) return "";
  const items = citations.map((c) =>
    `<button type="button" class="ama-src" data-chat="${escHtml(c.chat)}" data-id="${c.messageId}">` +
    `[${c.n}] ${escHtml(c.sender)} · ${escHtml(formatGroupName(c.chat))} · ` +
    `<span dir="ltr">${escHtml(fmtTime(c.sentAt))}</span></button>`
  ).join("");
  return `<span class="ama-bubble__src">↳ ${items}</span>`;
}

/* ── 7b. Thread view (Ask source-jump) ───────────────────── */

/**
 * Render a chat thread windowed around a cited message and pulse the source.
 * Reuses the single-pane (ama) layout slot. Back returns via history.
 * @param {string} chat — group name
 * @param {number} aroundId — cited message id to center + pulse
 */
async function renderThread(chat, aroundId) {
  teardownStream();
  setView("ama");
  paneMain.innerHTML = `
    <div class="thread-panel">
      <div class="thread-head">
        <button class="back-btn" id="thread-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="thread-head__title">${escHtml(formatGroupName(chat))}</div>
        <span class="thread-head__src">מקור מקושר</span>
      </div>
      <div class="thread-msgs" id="thread-msgs"><p class="thread-loading">טוען שיחה…</p></div>
    </div>`;
  document.getElementById("thread-back")?.addEventListener("click", () => history.back());

  let rows = [];
  try {
    rows = await getMessages({ chat, aroundId, limit: 24 });
  } catch {
    const box = document.getElementById("thread-msgs");
    if (box) box.innerHTML = `<p class="error-state">שגיאה בטעינת השיחה.</p>`;
    return;
  }
  const box = document.getElementById("thread-msgs");
  if (!box) return; // navigated away while loading
  if (!rows.length) {
    box.innerHTML = `<p class="empty-state">לא נמצאו הודעות.</p>`;
    return;
  }
  box.innerHTML = rows
    .map((m) => {
      const side = m.fromMe ? "cmsg--me" : "cmsg--them";
      const hl = m.id === aroundId ? " cmsg--hl" : "";
      const tag = m.id === aroundId ? `<span class="cmsg__tag">מקור הסיכום</span>` : "";
      return `<div class="cmsg ${side}${hl}" data-id="${m.id}">
        <div class="cmsg__meta">${escHtml(m.sender)} · <span dir="ltr">${escHtml(fmtTime(m.sentAt))}</span></div>
        <div class="cmsg__text">${escHtml(m.text)}</div>${tag}
      </div>`;
    })
    .join("");
  const target = box.querySelector(".cmsg--hl");
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("cmsg--pulse");
  }
}

/* ── 7c. Sources (chat scopes) ───────────────────────────── */

const SEG_LABEL = { all: "הכול", included: "מוזנים", excluded: "מוחרגים" };
const sourcesState = { scopes: [], categories: [], query: "", segment: "all" };

/** The Sources control center (§7): whitelist/blacklist + categorize chats. */
async function renderSources() {
  teardownStream();
  setView("ama"); // reuse the single-pane slot
  paneMain.innerHTML = `<div class="sources-panel"><p class="thread-loading">טוען צ׳אטים…</p></div>`;
  try {
    const [scopes, categories] = await Promise.all([getScopes(), getScopeCategories()]);
    sourcesState.scopes = scopes;
    sourcesState.categories = categories;
  } catch {
    paneMain.innerHTML = `<div class="sources-panel"><p class="error-state">שגיאה בטעינת הצ׳אטים.</p></div>`;
    return;
  }
  paintSources();
}

function paintSources() {
  const { scopes, categories, query, segment } = sourcesState;
  const { removed } = partitionRemoved(scopes);
  const counts = activeCount(scopes);
  const filtered = filterScopes(scopes, { query, segment });
  const sections = groupByCategory(filtered, categories);

  paneMain.innerHTML = `
    <div class="sources-panel">
      <div class="sources-head">
        <button class="back-btn" id="sources-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="sources-head__title">צ׳אטים</div>
      </div>
      <p class="sources-callout">אתם בוחרים מה CatchApp רואה ·
        <span class="mono" dir="ltr">${counts.active}/${counts.total}</span> פעילים</p>
      <div class="sources-toolbar">
        <input id="sources-search" class="src-search" type="search" placeholder="🔍  חיפוש צ׳אט…"
          aria-label="חיפוש צ׳אט" value="${escHtml(query)}" autocomplete="off" />
        <div class="src-seg" role="group" aria-label="סינון">
          ${["all", "included", "excluded"]
            .map(
              (seg) =>
                `<button class="src-seg__btn${segment === seg ? " is-active" : ""}" data-seg="${seg}" type="button">${SEG_LABEL[seg]}</button>`,
            )
            .join("")}
        </div>
        <button class="src-addcat" id="sources-addcat" type="button">+ קבוצה</button>
      </div>
      ${sections.map(buildSourcesSection).join("")}
      ${filtered.length === 0 ? `<p class="empty-state">לא נמצאו צ׳אטים תואמים.</p>` : ""}
      ${removed.length ? buildRemovedSection(removed) : ""}
    </div>`;
  wireSources();
}

function buildSourcesSection(section) {
  const title = section.category ? escHtml(section.category.name) : "ללא קטגוריה";
  const n = sectionCount(section.scopes);
  const anyIncluded = section.scopes.some((s) => s.included);
  const bulkLabel = anyIncluded ? "כבה הכול" : "הפעל הכול";
  return `
    <div class="src-section">
      <div class="src-section__head">
        <span class="src-section__title">${title} <span class="src-section__count mono" dir="ltr">${n}</span></span>
        ${section.scopes.length ? `<button class="src-bulk" data-bulk="${anyIncluded ? "off" : "on"}" data-cat="${section.category?.id ?? ""}" type="button">${bulkLabel}</button>` : ""}
      </div>
      ${section.scopes.map(buildSourceRow).join("") || `<p class="src-empty-cat">אין צ׳אטים בקטגוריה זו</p>`}
    </div>`;
}

function buildSourceRow(s) {
  const cats = sourcesState.categories
    .map(
      (c) =>
        `<option value="${c.id}"${s.categoryId === c.id ? " selected" : ""}>${escHtml(c.name)}</option>`,
    )
    .join("");
  return `
    <div class="src-row" data-group="${escHtml(s.group)}">
      <button class="src-switch${s.included ? " is-on" : ""}" data-act="toggle" type="button"
        role="switch" aria-checked="${s.included}" aria-label="${s.included ? "מוזן" : "מוחרג"}">
        <span class="src-switch__knob"></span>
      </button>
      <div class="src-row__body">
        <div class="src-row__name">${escHtml(formatGroupName(s.group))}</div>
        <div class="src-row__meta mono" dir="ltr">${s.messageCount}</div>
      </div>
      <select class="src-cat" data-act="cat" aria-label="קטגוריה">
        <option value=""${s.categoryId == null ? " selected" : ""}>ללא</option>
        ${cats}
      </select>
      <button class="src-remove" data-act="remove" type="button" aria-label="הסר">✕</button>
    </div>`;
}

function buildRemovedSection(removed) {
  return `
    <div class="src-section src-section--removed">
      <div class="src-section__head"><span class="src-section__title">הוסרו <span class="mono" dir="ltr">${removed.length}</span></span></div>
      ${removed
        .map(
          (s) => `
        <div class="src-row src-row--removed" data-group="${escHtml(s.group)}">
          <div class="src-row__name">${escHtml(formatGroupName(s.group))}</div>
          <button class="src-restore" data-act="restore" type="button">שחזר</button>
        </div>`,
        )
        .join("")}
    </div>`;
}

/** Apply a scope change locally + persist, then repaint. Optimistic. */
async function applyScopeChange(updates) {
  for (const u of updates) {
    const row = sourcesState.scopes.find((s) => s.group === u.group);
    if (!row) continue;
    if (u.included !== undefined) row.included = u.included;
    if (u.categoryId !== undefined) row.categoryId = u.categoryId;
    if (u.removed !== undefined) row.removed = u.removed;
  }
  paintSources();
  try {
    await putScopes(updates);
  } catch {
    // Refetch to resync if the write failed.
    renderSources();
  }
}

function wireSources() {
  document.getElementById("sources-back")?.addEventListener("click", () => history.back());

  const search = document.getElementById("sources-search");
  if (search) {
    search.addEventListener("input", () => {
      sourcesState.query = search.value;
      paintSources();
      document.getElementById("sources-search")?.focus();
    });
  }
  for (const btn of document.querySelectorAll(".src-seg__btn")) {
    btn.addEventListener("click", () => {
      sourcesState.segment = btn.dataset.seg;
      paintSources();
    });
  }
  document.getElementById("sources-addcat")?.addEventListener("click", async () => {
    const name = (prompt("שם הקבוצה החדשה:") || "").trim();
    if (!name) return;
    try {
      await createScopeCategory(name);
      sourcesState.categories = await getScopeCategories();
      paintSources();
    } catch {
      /* ignore */
    }
  });
  for (const btn of document.querySelectorAll(".src-bulk")) {
    btn.addEventListener("click", () => {
      const on = btn.dataset.bulk === "on";
      const catId = btn.dataset.cat === "" ? null : Number(btn.dataset.cat);
      const updates = sourcesState.scopes
        .filter((s) => !s.removed && (s.categoryId ?? null) === catId)
        .map((s) => ({ group: s.group, included: on }));
      if (updates.length) applyScopeChange(updates);
    });
  }
  for (const row of document.querySelectorAll(".src-row[data-group]")) {
    const group = row.dataset.group;
    row.querySelector('[data-act="toggle"]')?.addEventListener("click", () => {
      const s = sourcesState.scopes.find((x) => x.group === group);
      applyScopeChange([{ group, included: !s.included }]);
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: true }]),
    );
    row.querySelector('[data-act="restore"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: false }]),
    );
    row.querySelector('[data-act="cat"]')?.addEventListener("change", (e) => {
      const val = e.target.value;
      applyScopeChange([{ group, categoryId: val === "" ? null : Number(val) }]);
    });
  }
}

/* ── 7d. Settings (preferences §8) ───────────────────────── */

const settingsState = { prefs: null };

/** The Settings screen (§8): privacy callout, daily digest, display mode,
 *  and the experimental suggestion-engine config. Fetch-on-entry, then paint. */
async function renderSettings() {
  teardownStream();
  setView("ama"); // reuse the single-pane slot, like Sources
  paneMain.innerHTML = `<div class="settings-panel"><p class="thread-loading">טוען הגדרות…</p></div>`;
  if (DEMO) {
    settingsState.prefs = {
      digestTimes: "08:00",
      morningNotification: true,
      engineConfig: {},
      theme: currentTheme,
    };
    paintSettings();
    return;
  }
  try {
    settingsState.prefs = await getPreferences();
  } catch {
    paneMain.innerHTML = `<div class="settings-panel"><p class="error-state">שגיאה בטעינת ההגדרות.</p></div>`;
    return;
  }
  paintSettings();
}

/** Apply a preferences patch locally + persist in the background (optimistic).
 *  On failure we refetch to resync — mirrors applyScopeChange. */
async function applyPrefChange(patch) {
  Object.assign(settingsState.prefs, patch);
  paintSettings();
  try {
    await putPreferences(patch);
  } catch {
    renderSettings();
  }
}

function paintSettings() {
  const prefs = settingsState.prefs;
  const engine = normalizeEngineConfig(prefs.engineConfig);

  const digestChips = DIGEST_CHOICES.map((t) => {
    const on = isDigestSelected(prefs.digestTimes, t);
    return `<button class="set-chip${on ? " is-on" : ""}" data-act="digest" data-val="${t}" type="button"
      role="switch" aria-checked="${on}"><span class="mono" dir="ltr">${t}</span></button>`;
  }).join("");

  const themeSeg = [
    ["light", "בהיר"],
    ["dark", "כהה"],
  ]
    .map(
      ([val, label]) =>
        `<button class="set-seg__btn${currentTheme === val ? " is-active" : ""}" data-act="theme" data-val="${val}" type="button">${label}</button>`,
    )
    .join("");

  const kindChips = ENGINE_KINDS.map(
    ([k, label]) =>
      `<button class="set-chip${engine.kinds[k] ? " is-on" : ""}" data-act="kind" data-val="${k}" type="button"
        role="switch" aria-checked="${!!engine.kinds[k]}">${engine.kinds[k] ? icon("check", { size: 13 }) : ""}${label}</button>`,
  ).join("");

  const proactSeg = PROACT_LEVELS.map(
    (lvl) =>
      `<button class="set-seg__btn${engine.proact === lvl ? " is-active" : ""}" data-act="proact" data-val="${lvl}" type="button">${lvl}</button>`,
  ).join("");

  paneMain.innerHTML = `
    <div class="settings-panel">
      <div class="settings-head">
        <button class="back-btn" id="settings-back" aria-label="חזרה">
          <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
        </button>
        <div class="settings-head__title">הגדרות</div>
      </div>

      <div class="set-callout">
        <span class="set-callout__ico" aria-hidden="true">${icon("shield", { size: 22 })}</span>
        <div>
          <b class="set-callout__title">המידע שלך נשאר אצלך</b>
          <p class="set-callout__text">הכול מאוחסן ומעובד על המכשיר הזה. אתה השולט היחיד במידע.</p>
        </div>
      </div>

      <h2 class="set-sec">פרטיות ונתונים</h2>
      <div class="set-card">
        <div class="setrow">
          ${icon("lock", { cls: "set-ico" })}
          <div class="setrow__body"><h4>אחסון מקומי בלבד</h4><p>שמירת ההודעות והסיכומים על המכשיר</p></div>
          <span class="set-switch is-on" role="img" aria-label="פעיל"><span class="set-switch__knob"></span></span>
        </div>
        <div class="set-divide"></div>
        <div class="setrow">
          ${icon("cloud", { cls: "set-ico" })}
          <div class="setrow__body"><h4>גיבוי לענן</h4><p>כבוי כברירת מחדל — שום דבר לא יוצא בלי אישורך</p></div>
          <span class="set-switch is-disabled" role="img" aria-label="כבוי (לא זמין)"><span class="set-switch__knob"></span></span>
        </div>
        <div class="set-divide"></div>
        <div class="setrow">
          ${icon("trash", { cls: "set-ico" })}
          <div class="setrow__body"><h4>נתק וואטסאפ ומחק הכול</h4><p>הסרה מלאה של הנתונים מהמכשיר</p></div>
          <button class="set-btn set-btn--danger" type="button" disabled>מחיקה</button>
        </div>
      </div>

      <h2 class="set-sec">הסיכום היומי</h2>
      <div class="set-card">
        <div class="setrow">
          ${icon("bell", { cls: "set-ico" })}
          <div class="setrow__body"><h4>התראת בוקר</h4><p>תזכורת עדינה כשהסיכום מוכן</p></div>
          <button class="set-switch${prefs.morningNotification ? " is-on" : ""}" data-act="morning" type="button"
            role="switch" aria-checked="${prefs.morningNotification}" aria-label="התראת בוקר"><span class="set-switch__knob"></span></button>
        </div>
        <div class="set-divide"></div>
        <div class="setrow setrow--stack">
          ${icon("clock", { cls: "set-ico" })}
          <div class="setrow__body"><h4>שעות הסיכום</h4><p>מתי להכין את הסיכום היומי</p></div>
        </div>
        <div class="set-chips" role="group" aria-label="שעות הסיכום">${digestChips}</div>
      </div>

      <h2 class="set-sec">תצוגה</h2>
      <div class="set-card">
        <div class="setrow">
          ${icon("sliders", { cls: "set-ico" })}
          <div class="setrow__body"><h4>מצב תצוגה</h4><p>בהיר או כהה — נשמר במכשיר</p></div>
          <div class="set-seg" role="group" aria-label="מצב תצוגה">${themeSeg}</div>
        </div>
      </div>

      <h2 class="set-sec">מנוע ההצעות <span class="beta">ניסיוני</span></h2>
      <div class="set-card">
        <div class="setrow">
          ${icon("sparkle", { cls: "set-ico" })}
          <div class="setrow__body"><h4>הצעות חכמות בסיכום</h4><p>זיהוי משימות, פגישות ופולואו-אפים מהשיחות. בשלב ניסיוני — בשליטתך המלאה.</p></div>
          <button class="set-switch${engine.on ? " is-on" : ""}" data-act="engine-on" type="button"
            role="switch" aria-checked="${engine.on}" aria-label="מנוע ההצעות"><span class="set-switch__knob"></span></button>
        </div>
        ${
          engine.on
            ? `
        <div class="set-divide"></div>
        <div class="setrow setrow--stack">
          <div class="setrow__body"><h4>אילו הצעות להציג</h4><p>כבו סוג כדי שלא יופיע בסיכום</p></div>
        </div>
        <div class="set-chips" role="group" aria-label="סוגי הצעות">${kindChips}</div>
        <div class="set-divide"></div>
        <div class="setrow">
          ${icon("bolt", { cls: "set-ico" })}
          <div class="setrow__body"><h4>רמת יוזמה</h4><p>כמה הצעות המנוע יציע ביום</p></div>
          <div class="set-seg" role="group" aria-label="רמת יוזמה">${proactSeg}</div>
        </div>
        <div class="set-divide"></div>
        <div class="setrow">
          ${icon("filter", { cls: "set-ico" })}
          <div class="setrow__body"><h4>צ׳אטים מוזנים</h4><p>בחרו אילו שיחות המנוע ינתח</p></div>
          <button class="set-btn" id="settings-manage" type="button">ניהול ${icon("chevL", { size: 16 })}</button>
        </div>`
            : ""
        }
      </div>
    </div>`;
  wireSettings();
}

function wireSettings() {
  document.getElementById("settings-back")?.addEventListener("click", () => history.back());
  document.getElementById("settings-manage")?.addEventListener("click", () => navigate("sources"));

  const prefs = settingsState.prefs;

  // Daily digest
  for (const btn of document.querySelectorAll('[data-act="digest"]')) {
    btn.addEventListener("click", () =>
      applyPrefChange({ digestTimes: toggleDigestTime(prefs.digestTimes, btn.dataset.val) }),
    );
  }
  document
    .querySelector('[data-act="morning"]')
    ?.addEventListener("click", () =>
      applyPrefChange({ morningNotification: !prefs.morningNotification }),
    );

  // Display mode — localStorage is the source of truth (lib/theme.js); we also
  // mirror the choice into prefs so a fresh device can pick it up.
  for (const btn of document.querySelectorAll('[data-act="theme"]')) {
    btn.addEventListener("click", () => {
      const val = btn.dataset.val;
      if (val !== currentTheme) setDisplayMode(val);
      applyPrefChange({ theme: val });
    });
  }

  // Experimental engine — read/normalize, mutate, write the whole opaque blob back.
  const engine = normalizeEngineConfig(prefs.engineConfig);
  document
    .querySelector('[data-act="engine-on"]')
    ?.addEventListener("click", () =>
      applyPrefChange({ engineConfig: { ...engine, on: !engine.on } }),
    );
  for (const btn of document.querySelectorAll('[data-act="kind"]')) {
    btn.addEventListener("click", () => {
      const k = btn.dataset.val;
      applyPrefChange({
        engineConfig: { ...engine, kinds: { ...engine.kinds, [k]: !engine.kinds[k] } },
      });
    });
  }
  for (const btn of document.querySelectorAll('[data-act="proact"]')) {
    btn.addEventListener("click", () =>
      applyPrefChange({ engineConfig: { ...engine, proact: btn.dataset.val } }),
    );
  }
}

/** Apply + persist a theme choice and keep the top-bar toggle icon in sync. */
function setDisplayMode(value) {
  currentTheme = value;
  setTheme(currentTheme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.outerHTML = themeToggleHtml();
    document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
  }
}

/* ── 7e. Today (suggestion deck §2) ───────────────────────── */

/**
 * Today-screen state. `deck` is the live card list (read-only info cards lead,
 * actionable suggestion cards follow); acting on a suggestion drops it from the
 * deck. `acted` (count of suggestion actions) distinguishes a cleared deck →
 * DoneState from an empty-on-load deck → EmptyToday. Pure transitions live in
 * lib/today.js; this layer is DOM assembly + delegated wiring only.
 */
const todayState = {
  deck: [],
  index: 0,
  leaving: null,
  tally: emptyTally(),
  acted: 0,
  counts: { task: 0, meeting: 0, followup: 0, recap: 0 },
  engineOn: true,
};

/** True when the user asked the OS to minimize motion. */
function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Fetch-on-entry: load the deck, then paint. A 404/empty/error → empty state. */
async function renderToday() {
  teardownStream();
  setView("ama"); // reuse the single-pane slot, like Sources / Settings
  markActiveRow(null);
  paneMain.innerHTML = `<div class="today"><p class="thread-loading">טוען את הסיכום…</p></div>`;

  let data = null;
  try {
    data = DEMO ? null : await getToday();
  } catch {
    data = null; // endpoint not built yet / network → render the empty state
  }

  todayState.deck = buildDeck(data);
  todayState.index = 0;
  todayState.leaving = null;
  todayState.tally = emptyTally();
  todayState.acted = 0;
  todayState.counts = tileCounts(data?.suggestions ?? []);
  todayState.engineOn = true;

  // Only the empty state needs the engine on/off hint — fetch it lazily.
  if (todayState.deck.length === 0 && !DEMO) {
    try {
      todayState.engineOn = normalizeEngineConfig((await getPreferences()).engineConfig).on;
    } catch {
      /* keep the optimistic default */
    }
  }
  paintToday();
}

function paintToday() {
  const total = todayState.deck.length;
  const hasSuggestionsLeft = todayState.deck.some(isSuggestion);

  let body;
  if (total === 0) {
    body = todayState.acted > 0 ? buildDoneState(todayState.tally) : buildEmptyToday(todayState.engineOn);
  } else if (!hasSuggestionsLeft && todayState.acted > 0) {
    body = buildDoneState(todayState.tally);
  } else {
    body = buildStoryStack();
  }

  paneMain.innerHTML = `
    <div class="today">
      ${buildTodayHeader(new Date())}
      <div class="today-note">${icon("sparkle", { size: 13 })}<span>הצעות חכמות שנבנות מהשיחות — ומתחדדות לפי הבחירות שלך</span></div>
      ${body}
      <div class="today-foot">${buildTodayFoot(total, hasSuggestionsLeft)}</div>
      ${buildTiles()}
    </div>`;
  wireToday();
}

function buildTodayHeader(now) {
  const greet = greeting(now.getHours());
  let dateStr = "";
  try {
    const wd = now.toLocaleDateString("he-IL", { weekday: "long" });
    dateStr = `${escHtml(wd)} · <span class="mono" dir="ltr">${now.getDate()}.${now.getMonth() + 1}</span>`;
  } catch {
    /* leave date blank if Intl is unavailable */
  }
  return `
    <nav class="detail-nav today-nav" aria-label="ניווט">
      <button class="back-btn" id="today-back" aria-label="חזרה">
        <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
      </button>
    </nav>
    <div class="today-head">
      <div>
        <div class="kicker">הסיכום היומי</div>
        <div class="greet">${escHtml(greet)}</div>
      </div>
      <div class="date">${dateStr}</div>
    </div>`;
}

/** The Stories stack: peek cards behind + the active card + the flash slot. */
function buildStoryStack() {
  const i = clampIndex(todayState.index, todayState.deck.length);
  const card = todayState.deck[i];
  const backs = peekCount(todayState.deck.length);
  const backCards = Array.from({ length: backs }, (_, k) => `<div class="story-back" style="--d:${backs - k}"></div>`).join("");
  const cardHtml = isSuggestion(card)
    ? buildSuggestionCard(card, i, todayState.deck.length)
    : buildInfoCard(card, i, todayState.deck.length);
  return `
    <div class="story-stack">
      ${backCards}
      ${cardHtml}
      <div class="story-flash" id="today-flash" role="status" aria-live="polite"></div>
    </div>`;
}

/** Shared card chrome: segment strip, nav tap-zones, body, footer. */
function buildCardChrome(index, total, kindCls, inner, footer) {
  const segs = segmentFills(index, total).map((on) => `<i>${on ? "<b></b>" : ""}</i>`).join("");
  return `
    <div class="story ${kindCls} entering">
      <div class="segs" aria-hidden="true">${segs}</div>
      <div class="nav-zone next" data-nav="next" aria-hidden="true"><div class="navhint l">${icon("chevL", { size: 18 })}</div></div>
      <div class="nav-zone prev" data-nav="prev" aria-hidden="true"><div class="navhint r">${icon("chevR", { size: 18 })}</div></div>
      ${inner}
      ${footer}
    </div>`;
}

function buildSuggestionCard(card, index, total) {
  const cfg = suggestionConfig(card.kind);
  const draftVal = card.draft ?? card.proposedText;
  let editor;
  if (cfg.editable) {
    editor = `<div class="cl-draft sg-draft">${icon("pencil", { size: 15 })}<input class="sg-draft__input" value="${escHtml(draftVal)}" aria-label="עריכת ההצעה" /></div>`;
  } else {
    const lines = String(card.proposedText).split("\n").map((s) => s.trim()).filter(Boolean);
    const items = (lines.length ? lines : [card.proposedText]).map((l) => `<li>${escHtml(l)}</li>`).join("");
    editor = `<div class="sg-recap"><ul>${items}</ul></div>`;
  }
  const inner = `
    <div class="scard">
      <div class="topline">
        <span class="sg-spark">${icon(cfg.icon, { size: 18 })}</span>
        <span class="kicker sg-kicker">${escHtml(cfg.kicker)}</span>
        <span class="sg-tag">${icon("sparkle", { size: 11 })}מותאם אישית</span>
      </div>
      <h3>${escHtml(cfg.title(formatGroupName(card.chat)))}</h3>
      <div class="body">${escHtml(cfg.prompt)}</div>
      ${editor}
      <div class="sg-reason">${icon("bolt", { size: 15 })}<span><b>למה הצעתי את זה:</b> ${escHtml(card.reason)}</span></div>
      <div class="metarow">${buildSrcChip(card)}</div>
    </div>
    <div class="sg-learn">${icon("sparkle", { size: 13 })}<span>אלמד מהבחירה שלך כדי לדייק הצעות בעתיד</span></div>`;
  const footer = `
    <div class="actions sg-actions sg-editfirst">
      <button class="btn btn-primary" type="button" data-act="commit" data-id="${card.id}">${icon(cfg.commitIcon)}${escHtml(cfg.commitLabel)}</button>
      <div class="sg-links">
        <button type="button" data-act="snooze" data-id="${card.id}">${icon("moon", { size: 14 })}נודניק</button>
        <span aria-hidden="true">·</span>
        <button type="button" data-act="discard" data-id="${card.id}">${icon("x", { size: 14 })}התעלם</button>
      </div>
    </div>`;
  return buildCardChrome(index, total, "s-suggest", inner, footer);
}

function buildInfoCard(card, index, total) {
  const isHi = card.variant === "highlights";
  const kicker = isHi ? "מבט על היום" : "סיכום צ׳אט";
  const title = isHi ? "עיקרי היום בכל הצ׳אטים" : formatGroupName(card.chat);
  const inner = `
    <div class="scard">
      <div class="topline">
        <span class="sg-spark">${icon(isHi ? "sparkle" : "message", { size: 18 })}</span>
        <span class="kicker">${escHtml(kicker)}</span>
        <span class="badge accent">מידע</span>
      </div>
      <h3>${escHtml(title)}</h3>
      <div class="body body--scroll">${escHtml(card.body)}</div>
    </div>`;
  // Read-only: no accept/snooze/discard — just a hint to swipe on.
  const footer = `<div class="actions info-actions"><span class="info-hint">${icon("sparkle", { size: 14 })}סקירה — החליקו להמשך</span></div>`;
  return buildCardChrome(index, total, "s-info", inner, footer);
}

/** Source chip — a button that jumps to the cited message (S2), or a plain
 *  label when the suggestion has no source message. */
function buildSrcChip(card) {
  const label = escHtml(formatGroupName(card.chat));
  if (card.sourceMessageId == null) {
    return `<span class="src">${icon("arrowL", { size: 13 })}<span>${label}</span></span>`;
  }
  return `<button type="button" class="src" data-src-jump="1" data-chat="${escHtml(card.chat)}" data-id="${card.sourceMessageId}">${icon("arrowL", { size: 13 })}<span>${label}</span></button>`;
}

function buildDoneState(tally) {
  const bits = tallyBits(tally);
  const suffix = bits.length ? `. ${bits.join(" · ")}.` : ".";
  return `
    <div class="done-state surface">
      <div>
        <div class="done-badge">${icon("check", { size: 30 })}</div>
        <h3>סיימת להיום ✦</h3>
        <p>עברת על כל היום שלך בפחות מדקה${escHtml(suffix)}</p>
        <div class="done-learn">${icon("sparkle", { size: 13 })}<span>ההצעות של מחר יתחדדו לפי מה שבחרת היום</span></div>
      </div>
    </div>`;
}

function buildEmptyToday(engineOn) {
  return `
    <div class="done-state surface">
      <div>
        <div class="done-badge">${icon(engineOn ? "check" : "sliders", { size: 28 })}</div>
        <h3>${engineOn ? "הכול נקי לבוקר" : "מנוע ההצעות כבוי"}</h3>
        <p>${engineOn ? "אין כרגע מה לעדכן בצ׳אטים שבחרת. ניהנה מהשקט ✦" : "הפעילו את ההצעות החכמות כדי לראות סיכום יומי."}</p>
        <button class="btn btn-soft" id="today-empty-cta" type="button">${icon(engineOn ? "filter" : "sliders")}${engineOn ? "ניהול הצ׳אטים" : "להגדרות המנוע"}</button>
      </div>
    </div>`;
}

function buildTodayFoot(total, hasSuggestionsLeft) {
  if (total === 0) {
    if (todayState.acted > 0) return `<span>${total} · הכול עודכן</span>`;
    return `<span>${todayState.engineOn ? "0 הצעות · הכול שקט" : "מנוע ההצעות כבוי"}</span>`;
  }
  if (!hasSuggestionsLeft) {
    return `<span>${todayState.acted > 0 ? "הכול עודכן · קריאה של דקה" : "סקירה יומית · קריאה של דקה"}</span>`;
  }
  return `<span>נשארו ${total} ${total === 1 ? "כרטיס" : "כרטיסים"} · קריאה של דקה</span>`;
}

/** Quick tiles (2×2): per-kind counts + an action tile linking to Ask. */
function buildTiles() {
  const meta = {
    task: { icon: "checks", lbl: "משימות להיום" },
    meeting: { icon: "calendar", lbl: "פגישות היום" },
    followup: { icon: "user", lbl: "פולואו-אפים" },
  };
  const tiles = TILE_KINDS.map((k) => {
    const m = meta[k];
    return `<div class="tile surface"><span class="tile__ico" aria-hidden="true">${icon(m.icon)}</span><div class="tnum">${todayState.counts[k]}</div><div class="tlbl">${escHtml(m.lbl)}</div></div>`;
  }).join("");
  const action = `<button class="tile tile-action surface" id="today-ask-tile" type="button"><span class="tile__ico" aria-hidden="true">${icon("sparkle")}</span><div class="taction">שאל את הצ׳אט${icon("chevL", { size: 15 })}</div><div class="tlbl">שאל על כל ההיסטוריה</div></button>`;
  return `<div class="today-divide" aria-hidden="true"></div><div class="tiles">${tiles}${action}</div>`;
}

function wireToday() {
  document.getElementById("today-back")?.addEventListener("click", () => history.back());
  document.getElementById("today-empty-cta")?.addEventListener("click", () => navigate(todayState.engineOn ? "sources" : "settings"));
  document.getElementById("today-ask-tile")?.addEventListener("click", () => navigate("ama"));

  const stack = document.querySelector(".today .story-stack");
  if (!stack) return;

  // Preserve a draft edit across navigation (re-render reads card.draft).
  stack.querySelector(".sg-draft__input")?.addEventListener("input", (e) => {
    const card = todayState.deck[clampIndex(todayState.index, todayState.deck.length)];
    if (card && isSuggestion(card)) card.draft = e.target.value;
  });

  // Tap zones — navigation only (Stories pattern), never an action.
  for (const zone of stack.querySelectorAll(".nav-zone")) {
    zone.addEventListener("click", () => {
      if (todayState.leaving) return;
      const len = todayState.deck.length;
      todayState.index =
        zone.dataset.nav === "next" ? clampIndex(todayState.index + 1, len) : clampIndex(todayState.index - 1, len);
      paintToday();
    });
  }

  // Source-jump chip → S2 thread view.
  stack.querySelector("[data-src-jump]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.currentTarget;
    const id = Number(chip.dataset.id);
    if (chip.dataset.chat && Number.isFinite(id)) navigate("thread", { chat: chip.dataset.chat, aroundId: id });
  });

  // Act buttons (commit / snooze / discard).
  for (const btn of stack.querySelectorAll("[data-act]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onTodayAct(btn.dataset.act, Number(btn.dataset.id));
    });
  }
}

/** Commit / snooze / discard a suggestion: PUT (best-effort), animate it out,
 *  drop it from the deck, then flash a confirmation toast. */
function onTodayAct(act, id) {
  if (todayState.leaving) return;
  const card = todayState.deck.find((c) => c.id === id);
  if (!card || !isSuggestion(card)) return;

  let action;
  let finalText;
  let flash;
  if (act === "commit") {
    const input = document.querySelector(".today .sg-draft__input");
    const draftValue = input ? input.value : (card.draft ?? card.proposedText);
    const res = commitActionFor(card, draftValue);
    action = res.action;
    finalText = res.finalText;
    flash = suggestionConfig(card.kind).flash;
  } else if (act === "snooze") {
    action = "snooze";
    flash = "נדחה למאוחר יותר";
  } else if (act === "discard") {
    action = "discard";
    flash = "הוסר — אלמד מזה";
  } else {
    return;
  }

  // Fire-and-forget — the engine endpoint may not exist yet; UI must not block.
  if (!DEMO) actOnSuggestion(id, action, action === "edit" ? finalText : undefined).catch(() => {});

  const removedIndex = todayState.deck.findIndex((c) => c.id === id);
  todayState.tally = recordTally(todayState.tally, action);
  todayState.acted += 1;

  const finishLeave = () => {
    const newDeck = removeCardById(todayState.deck, id);
    todayState.index = indexAfterRemoval(todayState.index, removedIndex, newDeck.length);
    todayState.deck = newDeck;
    todayState.leaving = null;
    paintToday();
    showTodayFlash(flash);
    // A committed recap opens the chat's summary once the card has left.
    if (act === "commit" && card.kind === "recap" && card.chat) navigate("detail", card.chat);
  };

  const storyEl = document.querySelector(".today .story");
  if (storyEl && !prefersReducedMotion()) {
    todayState.leaving = leavingVariant(action);
    storyEl.classList.remove("entering");
    storyEl.classList.add("leaving", leavingVariant(action));
    setTimeout(finishLeave, 300);
  } else {
    finishLeave();
  }
}

function showTodayFlash(text) {
  const el = document.getElementById("today-flash");
  if (!el || !text) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1100);
}

/* ── 7e. People (§5) ─────────────────────────────────────── */
//
// Two-pane (list + sticky detail) on desktop, stacks on mobile. Fetch-on-entry,
// then a thin paint. The People/CRM endpoint may not exist yet — any failure
// (404 / network) renders the empty state rather than crashing.

const peopleState = { people: [], selected: 0 };

/** A per-name tinted initials disc (oklch tint hashed from the name). */
function buildAvatarDisc(name, size = 42) {
  const t = avatarTint(name);
  return `<span class="entity-avatar" aria-hidden="true"
    style="--av-sz:${size}px;--av-bg:${t.bg};--av-fg:${t.fg};--av-fs:${Math.round(size * 0.36)}px">${escHtml(t.initials)}</span>`;
}

/** Source chip → S2 thread jump. Falls back to a plain label when the entity
 *  carries no jumpable `{chat, sourceMessageId}`. Shared by People + Agenda. */
function buildSrcJump({ chat, sourceMessageId, label }) {
  const text = escHtml(label ?? (chat ? formatGroupName(chat) : "מקור"));
  const id = Number(sourceMessageId);
  if (!chat || !Number.isFinite(id)) {
    return `<span class="srcchip">${icon("arrowL", { size: 13 })}<span>${text}</span></span>`;
  }
  return `<button type="button" class="srcchip" data-src-jump="1" data-chat="${escHtml(chat)}" data-id="${id}">${icon("arrowL", { size: 13 })}<span>${text}</span></button>`;
}

/** Delegate source-chip clicks within a container to the S2 thread jump. */
function wireSrcJumps(root) {
  for (const chip of root.querySelectorAll("[data-src-jump]")) {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(chip.dataset.id);
      if (chip.dataset.chat && Number.isFinite(id)) {
        navigate("thread", { chat: chip.dataset.chat, aroundId: id });
      }
    });
  }
}

/** A back-nav row (mobile shows it; the top-bar is hidden off-feed). */
function buildEntityNav(backId) {
  return `
    <nav class="detail-nav entity-nav" aria-label="ניווט">
      <button class="back-btn" id="${backId}" aria-label="חזרה">
        <span class="back-btn__arrow" aria-hidden="true">›</span> חזרה
      </button>
    </nav>`;
}

async function renderPeople() {
  teardownStream();
  setView("ama"); // reuse the single-pane slot, like Sources / Settings / Today
  markActiveRow(null);
  paneMain.innerHTML = `<div class="people"><p class="thread-loading">טוען אנשים…</p></div>`;
  let people = [];
  try {
    people = DEMO ? [] : await getPeople();
  } catch {
    people = []; // endpoint not built yet / network → empty state
  }
  peopleState.people = Array.isArray(people) ? people : [];
  peopleState.selected = 0;
  paintPeople();
}

function paintPeople() {
  const { people } = peopleState;
  if (people.length === 0) {
    paneMain.innerHTML = `
      <div class="people">
        ${buildEntityNav("people-back")}
        <div class="entity-head">
          <div class="entity-head__title">${icon("users", { size: 18 })} אנשים</div>
        </div>
        ${buildEntityEmpty("users", "אין עדיין אנשים", "כשתתחילו לשוחח, CatchApp יזהה לידים ואנשי קשר שמחכים לתשובה — והם יופיעו כאן.")}
      </div>`;
    document.getElementById("people-back")?.addEventListener("click", () => history.back());
    return;
  }

  const sel = Math.max(0, Math.min(peopleState.selected, people.length - 1));
  peopleState.selected = sel;
  const warmWaiting = people.filter((p) => p.openThreads > 0).length;

  paneMain.innerHTML = `
    <div class="people">
      ${buildEntityNav("people-back")}
      <div class="entity-head">
        <div class="entity-head__title">${icon("users", { size: 18 })} אנשים</div>
        <span class="entity-count mono" dir="ltr">${warmWaiting}/${people.length}</span>
      </div>
      <div class="split">
        <div class="ppl-list" role="list">
          ${people.map((p, i) => buildPersonRow(p, i === sel)).join("")}
        </div>
        ${buildPersonDetail(people[sel])}
      </div>
    </div>`;
  wirePeople();
}

function buildPersonRow(p, isSel) {
  const meta = peopleStatusMeta(p.status);
  const last = formatAgo(p.lastContactAt) ?? "אין קשר עדיין";
  const note = p.nextStep ? escHtml(p.nextStep) : "אין צעד פתוח";
  const open = p.openThreads > 0
    ? ` · <span class="mono" dir="ltr">${p.openThreads}</span> שיחות פתוחות`
    : "";
  return `
    <button type="button" class="ppl-row${isSel ? " is-sel" : ""}" role="listitem" data-idx="${p.id}">
      ${buildAvatarDisc(p.name, 42)}
      <div class="ppl-row__body">
        <div class="ppl-row__name">${escHtml(p.name)}
          <span class="entity-badge${meta.warn ? " is-warn" : ""}">${escHtml(meta.label)}</span>
        </div>
        <p class="ppl-row__note">${note}</p>
        <div class="ppl-row__meta">קשר אחרון · ${escHtml(last)}${open}</div>
      </div>
    </button>`;
}

function buildPersonDetail(p) {
  const meta = peopleStatusMeta(p.status);
  const last = formatAgo(p.lastContactAt) ?? "אין קשר עדיין";
  const chip = buildSrcJump({ chat: p.chat, sourceMessageId: p.sourceMessageId, label: "מההודעה" });
  const openChat = p.chat
    ? `<button class="btn btn-primary" id="ppl-open-chat" type="button">${icon("message")}פתח צ׳אט</button>`
    : `<button class="btn btn-primary" type="button" disabled>${icon("message")}פתח צ׳אט</button>`;
  return `
    <aside class="ppl-detail surface" aria-label="פרטי איש קשר">
      <div class="ppl-detail__head">
        ${buildAvatarDisc(p.name, 56)}
        <div class="ppl-detail__id">
          <div class="ppl-detail__name">${escHtml(p.name)}</div>
          <span class="entity-badge${meta.warn ? " is-warn" : " is-accent"}">${escHtml(meta.label)}</span>
        </div>
      </div>
      <div class="ppl-detail__divide"></div>
      <div class="ppl-detail__rows">
        <div class="ppl-detail__row">${icon("clock", { size: 16 })}<span>קשר אחרון</span><b>${escHtml(last)}</b></div>
        <div class="ppl-detail__row">${icon("message", { size: 16 })}<span>שיחות פתוחות</span><b class="mono" dir="ltr">${p.openThreads}</b></div>
      </div>
      <div class="ppl-detail__divide"></div>
      <div class="ppl-next__kicker">${icon("target", { size: 13 })} הצעד הבא</div>
      <div class="ppl-next surface">
        <span>${p.nextStep ? escHtml(p.nextStep) : "אין צעד פתוח כרגע"}</span>
        ${p.nextStep ? chip : ""}
      </div>
      <div class="ppl-detail__actions">
        ${openChat}
        <button class="btn btn-ghost" id="ppl-add-task" type="button">${icon("plus")}משימה</button>
      </div>
    </aside>`;
}

function wirePeople() {
  document.getElementById("people-back")?.addEventListener("click", () => history.back());
  const root = paneMain.querySelector(".people");
  if (!root) return;
  for (const row of root.querySelectorAll(".ppl-row")) {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.idx);
      const idx = peopleState.people.findIndex((p) => p.id === id);
      if (idx >= 0) {
        peopleState.selected = idx;
        paintPeople();
      }
    });
  }
  const sel = peopleState.people[peopleState.selected];
  document.getElementById("ppl-open-chat")?.addEventListener("click", () => {
    if (sel?.chat) navigate("detail", sel.chat);
  });
  // "+ משימה" is intentionally static for this UI-only slice.
  wireSrcJumps(root);
}

/* ── 7f. Meetings & To-dos (§6) ──────────────────────────── */
//
// Two visually-distinct columns (`.duo`): a month calendar + day-grouped agenda
// timeline on the left, and a checklist with a progress bar on the right.
// Local-only — no Google-Calendar connect banner (that's the S8 gated work).
// Both endpoints may be absent; any failure renders empty columns, never crashes.

const agendaState = { meetings: [], todos: [], monthOffset: 0 };
const DOW_HE = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

async function renderAgenda() {
  teardownStream();
  setView("ama");
  markActiveRow(null);
  paneMain.innerHTML = `<div class="agenda-view"><p class="thread-loading">טוען פגישות ומשימות…</p></div>`;
  let meetings = [];
  let todos = [];
  if (!DEMO) {
    [meetings, todos] = await Promise.all([
      getMeetings().catch(() => []),
      getTodos().catch(() => []),
    ]);
  }
  agendaState.meetings = Array.isArray(meetings) ? meetings : [];
  agendaState.todos = Array.isArray(todos) ? todos : [];
  agendaState.monthOffset = 0;
  paintAgenda();
}

function paintAgenda() {
  paneMain.innerHTML = `
    <div class="agenda-view">
      ${buildEntityNav("agenda-back")}
      <div class="entity-head">
        <div class="entity-head__title">${icon("calendar", { size: 18 })} פגישות ומשימות</div>
      </div>
      <div class="duo">
        <section class="duo__col">
          <div class="duo__sechead">
            <h2 class="duo__sec">${icon("calendar", { size: 15 })} פגישות שנאספו</h2>
            <a class="ics-export" href="/api/meetings.ics" download="catchapp.ics"
               title="ייצוא הפגישות לקובץ יומן מקומי — שום דבר לא יוצא מהמכשיר">ייצוא ליומן (.ics)</a>
          </div>
          ${buildCalendar()}
          ${buildAgendaTimeline()}
        </section>
        <section class="duo__col" id="agenda-todos">
          ${buildTodosColumn()}
        </section>
      </div>
    </div>`;
  wireAgenda();
}

/** Month calendar (today highlighted, event dots). Prev/next shift the month. */
function buildCalendar() {
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + agendaState.monthOffset);
  const year = base.getFullYear();
  const monthIndex = base.getMonth();
  const isCurrent = agendaState.monthOffset === 0;
  const todayDay = isCurrent ? new Date().getDate() : null;
  const events = eventDaySet(agendaState.meetings, year, monthIndex);
  const cells = buildMonthGrid(year, monthIndex, { today: todayDay, events });
  let monthLabel = `${year}`;
  try {
    monthLabel = base.toLocaleDateString("he-IL", { month: "long", year: "numeric" });
  } catch {
    /* leave numeric fallback */
  }
  const dow = DOW_HE.map((d) => `<span>${d}</span>`).join("");
  const grid = cells
    .map((c) => {
      if (c == null) return `<div class="cal-cell is-empty"></div>`;
      const dots = c.hasEvent ? `<span class="cal-dot" aria-hidden="true"></span>` : "";
      return `<div class="cal-cell${c.isToday ? " is-today" : ""}"><span class="cal-n mono" dir="ltr">${c.day}</span>${dots}</div>`;
    })
    .join("");
  return `
    <div class="cal surface">
      <div class="cal-head">
        <b>${escHtml(monthLabel)}</b>
        <div class="cal-nav">
          <button class="cal-navbtn" data-cal-nav="prev" type="button" aria-label="חודש קודם">${icon("chevR", { size: 16 })}</button>
          <button class="cal-navbtn" data-cal-nav="next" type="button" aria-label="חודש הבא">${icon("chevL", { size: 16 })}</button>
        </div>
      </div>
      <div class="cal-grid cal-dow" aria-hidden="true">${dow}</div>
      <div class="cal-grid" role="grid">${grid}</div>
    </div>`;
}

/** Hebrew day-group heading from the pure group's relative classification. */
function agendaDayLabel(group) {
  switch (group.relative) {
    case "today":
      return "היום";
    case "tomorrow":
      return "מחר";
    case "yesterday":
      return "אתמול";
    case "none":
      return "ללא תאריך";
    default:
      try {
        return new Date(`${group.key}T00:00:00Z`).toLocaleDateString("he-IL", {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
      } catch {
        return group.key ?? "";
      }
  }
}

/** Day-grouped agenda timeline (rail + dots). Grouping is the pure lib's. */
function buildAgendaTimeline() {
  const groups = groupMeetingsByDay(agendaState.meetings, new Date().toISOString());
  if (groups.length === 0) {
    return `<div class="agenda-timeline">${buildEntityEmpty("calendar", "אין פגישות", "פגישות שיזוהו בשיחות יופיעו כאן, מקובצות לפי יום.")}</div>`;
  }
  return `
    <div class="agenda-timeline">
      ${groups
        .map(
          (g) => `
        <div class="day-group">
          <div class="day-group__head">
            <span class="day-pill">${escHtml(agendaDayLabel(g))}</span>
            <span class="day-group__count"><span class="mono" dir="ltr">${g.items.length}</span> פגישות</span>
          </div>
          <div class="tl">
            ${g.items.map(buildMeetingItem).join("")}
          </div>
        </div>`,
        )
        .join("")}
    </div>`;
}

function buildMeetingItem(m) {
  let time = "";
  if (m.startsAt) {
    try {
      time = new Date(m.startsAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    } catch {
      time = "";
    }
  }
  const owner = m.owner ? `<span class="tl-owner">${icon("user", { size: 13 })}${escHtml(formatGroupName(m.owner))}</span>` : "";
  const chip = buildSrcJump({ chat: m.chat, sourceMessageId: m.sourceMessageId });
  return `
    <div class="tl-item">
      <div class="tl-time mono" dir="ltr">${escHtml(time) || "—"}</div>
      <div class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></div>
      <div class="tl-card surface">
        <h4>${escHtml(m.title)}</h4>
        <div class="tl-card__meta">${owner}${chip}</div>
      </div>
    </div>`;
}

/** To-dos checklist column: progress bar + round-checkbox rows. */
function buildTodosColumn() {
  const todos = agendaState.todos;
  const inner =
    todos.length === 0
      ? buildEntityEmpty("checks", "אין משימות פתוחות", "משימות שיחולצו מהשיחות יופיעו כאן, עם מקור ותאריך יעד.")
      : buildChecklist(todos);
  return `<h2 class="duo__sec">${icon("checks", { size: 15 })} משימות שחולצו</h2>${inner}`;
}

function buildChecklist(todos) {
  const p = todoProgress(todos);
  const rows = todos.map(buildTodoRow).join("");
  return `
    <div class="checklist surface">
      <div class="checklist__head">
        <b><span class="mono" dir="ltr">${p.done}</span> מתוך <span class="mono" dir="ltr">${p.total}</span> הושלמו</b>
        <span class="entity-badge is-accent"><span class="mono" dir="ltr">${p.open}</span> פתוחות</span>
      </div>
      <div class="checklist__bar" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100">
        <b style="inline-size:${p.pct}%"></b>
      </div>
      <div class="checklist__rows">${rows}</div>
    </div>`;
}

function buildTodoRow(t) {
  const chip = buildSrcJump({ chat: t.chat, sourceMessageId: t.sourceMessageId });
  const due = dueLabel(t.dueAt);
  const dueBadge = due ? `<span class="entity-badge">${escHtml(due)}</span>` : "";
  return `
    <div class="cl-row${t.done ? " is-done" : ""}" data-todo="${t.id}">
      <button class="cl-box${t.done ? " is-on" : ""}" type="button" data-todo-toggle="${t.id}"
        role="checkbox" aria-checked="${t.done}" aria-label="סימון כהושלם">${icon("check", { size: 14 })}</button>
      <div class="cl-row__body">
        <div class="cl-row__title">${escHtml(t.title)}</div>
        <div class="cl-row__meta">${chip}${dueBadge}</div>
      </div>
    </div>`;
}

/** Short Hebrew due-date label from an ISO `dueAt` (null → no badge). */
function dueLabel(dueAt) {
  if (!dueAt) return "";
  const rel = relativeDay(String(dueAt).slice(0, 10), new Date().toISOString());
  if (rel === "today") return "להיום";
  if (rel === "tomorrow") return "עד מחר";
  if (rel === "yesterday") return "היה אתמול";
  try {
    return `עד ${new Date(`${String(dueAt).slice(0, 10)}T00:00:00Z`).toLocaleDateString("he-IL", { weekday: "long" })}`;
  } catch {
    return "";
  }
}

function paintTodos() {
  const col = document.getElementById("agenda-todos");
  if (!col) return;
  col.innerHTML = buildTodosColumn();
  for (const btn of col.querySelectorAll("[data-todo-toggle]")) {
    btn.addEventListener("click", () => onTodoToggle(Number(btn.dataset.todoToggle)));
  }
  wireSrcJumps(col);
}

/** Optimistic checkbox toggle; reverts + repaints on a failed PATCH. */
async function onTodoToggle(id) {
  const t = agendaState.todos.find((x) => x.id === id);
  if (!t) return;
  const next = !t.done;
  t.done = next;
  paintTodos();
  if (DEMO) return;
  try {
    await setTodoDone(id, next);
  } catch {
    t.done = !next; // revert
    paintTodos();
  }
}

function wireAgenda() {
  document.getElementById("agenda-back")?.addEventListener("click", () => history.back());
  const root = paneMain.querySelector(".agenda-view");
  if (!root) return;
  for (const btn of root.querySelectorAll("[data-cal-nav]")) {
    btn.addEventListener("click", () => {
      agendaState.monthOffset += btn.dataset.calNav === "next" ? 1 : -1;
      paintAgenda();
    });
  }
  for (const btn of root.querySelectorAll("[data-todo-toggle]")) {
    btn.addEventListener("click", () => onTodoToggle(Number(btn.dataset.todoToggle)));
  }
  wireSrcJumps(root);
}

/** Shared empty-state card for People + Agenda columns. */
function buildEntityEmpty(iconName, title, text) {
  return `
    <div class="entity-empty surface">
      <div class="entity-empty__ico">${icon(iconName, { size: 24 })}</div>
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(text)}</p>
    </div>`;
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
  if (hash === "#today") {
    history.replaceState({ view: "today" }, "", hash);
    return { view: "today" };
  }
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
  if (hash === "#sources") {
    history.replaceState({ view: "sources" }, "", hash);
    return { view: "sources" };
  }
  if (hash === "#settings") {
    history.replaceState({ view: "settings" }, "", hash);
    return { view: "settings" };
  }
  if (hash === "#people") {
    history.replaceState({ view: "people" }, "", hash);
    return { view: "people" };
  }
  if (hash === "#agenda") {
    history.replaceState({ view: "agenda" }, "", hash);
    return { view: "agenda" };
  }
  history.replaceState({ view: "feed" }, "", location.pathname);
  return { view: "feed" };
}

// ── T2 auth gate (multi-tenant mode) ─────────────────────────────────────────
// Single-user local mode: /api/* is open → the gate is a no-op. Multi-tenant mode
// (MULTI_TENANT=true server-side): /api/* returns 401 without a session → show the
// login/register pane. /verify + /reset are the emailed-link landing pages.

async function authGate() {
  const token = new URLSearchParams(location.search).get("token");
  if (location.pathname === "/verify" && token) {
    await renderVerifyResult(token);
    return false;
  }
  if (location.pathname === "/reset" && token) {
    renderResetForm(token);
    return false;
  }
  const me = await fetch("/api/auth/me").catch(() => null);
  if (me && me.ok) {
    // Authenticated (multi-tenant): the tenant must have a linked WhatsApp session
    // before the app is useful. Gate on onboarding status; show the QR pane if not.
    const ob = await fetch("/api/onboarding/status").catch(() => null);
    if (ob && ob.ok) {
      const { status } = await ob.json();
      if (status !== "connected") {
        renderOnboarding(status);
        return false;
      }
    }
    return true;
  }
  // No session. Distinguish single-user (APIs open) from multi-tenant (gated).
  const probe = await fetch("/api/status").catch(() => null);
  if (probe && probe.status !== 401) return true;
  renderAuthPane("login");
  return false;
}

/**
 * T4 onboarding pane: link a WhatsApp account by scanning a QR. Opens the
 * /api/onboarding/qr SSE stream (server renders the QR to a data URL); when the
 * session reports "connected" we reload into the app.
 */
function renderOnboarding(initialStatus) {
  authShell(`
    <p class="auth-card__sub">כדי להתחיל, חברו את חשבון הוואטסאפ שלכם.</p>
    <div id="qr-box" class="qr-box" aria-live="polite">
      <div class="qr-spinner" aria-hidden="true"></div>
      <p id="qr-hint" class="qr-hint">מכינים קוד QR…</p>
    </div>
    <ol class="qr-steps">
      <li>פתחו וואטסאפ בטלפון → הגדרות → מכשירים מקושרים</li>
      <li>הקישו "קישור מכשיר" וסרקו את הקוד שלמעלה</li>
    </ol>
    <p id="qr-status" class="qr-status"></p>
    <button type="button" id="auth-logout" class="auth-link">התנתקות</button>
  `);
  const logout = document.getElementById("auth-logout");
  if (logout)
    logout.onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/";
    };

  if (initialStatus === "logged-out" || initialStatus === "failed") {
    setOnboardingStatus(
      initialStatus === "logged-out"
        ? "החיבור נותק. סרקו שוב כדי לקשר מחדש."
        : "החיבור נכשל. מנסים שוב…",
    );
  }

  const es = new EventSource("/api/onboarding/qr");
  activeEventSource = es;
  es.addEventListener("qr", (e) => {
    const { dataUrl } = JSON.parse(e.data);
    const box = document.getElementById("qr-box");
    if (box && dataUrl) {
      box.innerHTML = `<img class="qr-img" src="${dataUrl}" alt="קוד QR לקישור וואטסאפ" width="264" height="264" />`;
    }
  });
  es.addEventListener("connected", () => {
    es.close();
    setOnboardingStatus("✅ מחובר! טוען את האפליקציה…");
    setTimeout(() => location.reload(), 800);
  });
  es.addEventListener("logged-out", () => {
    setOnboardingStatus("הקישור נדחה. רעננו ונסו שוב.");
  });
  es.onerror = () => setOnboardingStatus("שגיאת חיבור לשרת. רעננו את הדף.");
}

function setOnboardingStatus(text) {
  const el = document.getElementById("qr-status");
  if (el) el.textContent = text;
}

/* ── T5 operator dashboard (/admin) ──────────────────────────────────────── */

/** Coarse session-status → Hebrew label + CSS modifier. */
function sessionBadge(status) {
  const map = {
    connected: ["מחובר", "ok"],
    connecting: ["מתחבר…", "warn"],
    disconnected: ["מנותק", "warn"],
    "logged-out": ["נותק — דרוש קישור", "bad"],
    failed: ["נכשל", "bad"],
    offline: ["לא פעיל", "off"],
    stopped: ["הופסק", "off"],
  };
  const [label, kind] = map[status] || [status, "off"];
  return `<span class="adm-badge adm-badge--${kind}">${label}</span>`;
}

async function renderAdminDashboard() {
  const layout = document.getElementById("layout");
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmtAgo = (iso) => (iso ? formatAgo(new Date(iso)) : "—");

  layout.innerHTML = `
    <div class="admin-pane">
      <header class="admin-head">
        <h1 class="admin-title">לוח בקרה — מנהל מערכת</h1>
        <a class="auth-link" href="/">← חזרה לאפליקציה</a>
      </header>
      <div id="admin-health" class="admin-health"></div>
      <div id="admin-body"><p class="admin-loading">טוען נתוני דיירים…</p></div>
      <h2 class="admin-subtitle">יומן ביקורת</h2>
      <div id="admin-audit"><p class="admin-loading">טוען יומן…</p></div>
    </div>
  `;

  const [healthRes, tenantsRes] = await Promise.all([
    fetch("/api/admin/health").catch(() => null),
    fetch("/api/admin/tenants").catch(() => null),
  ]);

  if (!tenantsRes || tenantsRes.status === 401) {
    location.href = "/"; // not logged in → bounce to login
    return;
  }
  if (tenantsRes.status === 403) {
    document.getElementById("admin-body").innerHTML =
      `<p class="admin-denied">אין לך הרשאת מנהל מערכת.</p>`;
    return;
  }

  const health = healthRes && healthRes.ok ? await healthRes.json() : null;
  if (health) {
    document.getElementById("admin-health").innerHTML = `
      <div class="admin-stat"><span class="admin-stat__n">${health.tenantCount}</span><span class="admin-stat__l">דיירים</span></div>
      <div class="admin-stat"><span class="admin-stat__n">${health.activeTenants}</span><span class="admin-stat__l">פעילים</span></div>
      <div class="admin-stat"><span class="admin-stat__n">${health.connectedSessions}</span><span class="admin-stat__l">חיבורים פעילים</span></div>
      <div class="admin-stat"><span class="admin-stat__n">${health.failedSessions}</span><span class="admin-stat__l">חיבורים תקולים</span></div>
      <div class="admin-stat"><span class="admin-stat__n">${health.totalMessages.toLocaleString("he")}</span><span class="admin-stat__l">הודעות סה״כ</span></div>
    `;
  }

  const tenants = await tenantsRes.json();
  const rows = tenants
    .map(
      (t) => `
      <tr>
        <td>${escape(t.name)} ${t.status !== "active" ? `<span class="adm-badge adm-badge--off">${escape(t.status)}</span>` : ""}</td>
        <td>${sessionBadge(t.sessionStatus)}</td>
        <td class="num">${t.groupCount}</td>
        <td class="num">${Number(t.messageCount).toLocaleString("he")}</td>
        <td>${fmtAgo(t.lastSummaryAt)}</td>
      </tr>`,
    )
    .join("");

  document.getElementById("admin-body").innerHTML = `
    <table class="admin-table">
      <thead><tr><th>דייר</th><th>חיבור וואטסאפ</th><th>קבוצות</th><th>הודעות</th><th>סיכום אחרון</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // ── Audit trail ──
  const AUDIT_LABELS = {
    "auth.register": "הרשמה",
    "auth.login": "התחברות",
    "auth.login_failed": "התחברות נכשלה",
    "auth.logout": "התנתקות",
    "auth.verify": "אימות אימייל",
    "auth.reset": "איפוס סיסמה",
    "onboarding.link": "קישור וואטסאפ",
    "operator.access": "גישת מנהל",
    "tenant.deleted": "דייר נמחק",
    "tenant.purged": "נתוני דייר נמחקו",
  };
  const auditRes = await fetch("/api/admin/audit?limit=50").catch(() => null);
  const auditBox = document.getElementById("admin-audit");
  if (!auditRes || !auditRes.ok) {
    auditBox.innerHTML = `<p class="admin-loading">לא ניתן לטעון את היומן.</p>`;
    return;
  }
  const events = await auditRes.json();
  if (events.length === 0) {
    auditBox.innerHTML = `<p class="admin-loading">אין אירועים עדיין.</p>`;
    return;
  }
  auditBox.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>מתי</th><th>אירוע</th><th>מי</th></tr></thead>
      <tbody>${events
        .map(
          (e) => `<tr>
            <td>${fmtAgo(e.at)}</td>
            <td>${AUDIT_LABELS[e.action] || escape(e.action)}</td>
            <td>${escape(e.actorEmail || "—")}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
  `;
}

function authShell(innerHtml) {
  document.getElementById("layout").innerHTML = `
    <div class="auth-pane">
      <div class="auth-card">
        <h1 class="auth-card__title">סיכום וואטסאפ</h1>
        ${innerHtml}
      </div>
    </div>
  `;
}

function renderAuthPane(mode) {
  const isLogin = mode === "login";
  authShell(`
    <div class="auth-tabs">
      <button id="tab-login" class="auth-tab ${isLogin ? "auth-tab--active" : ""}">התחברות</button>
      <button id="tab-register" class="auth-tab ${isLogin ? "" : "auth-tab--active"}">הרשמה</button>
    </div>
    <form id="auth-form" class="auth-form">
      <label class="auth-label">אימייל
        <input id="auth-email" class="auth-input" type="email" required autocomplete="email" />
      </label>
      <label class="auth-label">סיסמה (8 תווים לפחות)
        <input id="auth-password" class="auth-input" type="password" required minlength="8"
               autocomplete="${isLogin ? "current-password" : "new-password"}" />
      </label>
      ${
        isLogin
          ? `<button type="button" id="auth-forgot" class="auth-link">שכחתי סיסמה</button>`
          : `<label class="auth-consent"><input id="auth-consent" type="checkbox" required />
               אני מסכים/ה לתנאי השימוש: ההודעות שלי (כולל של אנשי הקשר שלי) יאוחסנו ויעובדו
               בשרת המופעל ע"י מנהל המערכת לצורך סיכומים. ניתן לבקש מחיקה מלאה בכל עת.</label>`
      }
      <p id="auth-error" class="auth-error" hidden></p>
      <button type="submit" class="auth-submit">${isLogin ? "התחברות" : "הרשמה"}</button>
    </form>
  `);
  document.getElementById("tab-login").onclick = () => renderAuthPane("login");
  document.getElementById("tab-register").onclick = () => renderAuthPane("register");
  const forgot = document.getElementById("auth-forgot");
  if (forgot) forgot.onclick = () => renderForgotForm();
  document.getElementById("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      email: document.getElementById("auth-email").value.trim(),
      password: document.getElementById("auth-password").value,
    };
    if (!isLogin) body.consent = document.getElementById("auth-consent").checked;
    const r = await fetch(`/api/auth/${isLogin ? "login" : "register"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r && (r.status === 200 || r.status === 201)) {
      location.href = "/";
      return;
    }
    const err = document.getElementById("auth-error");
    err.textContent = r ? ((await r.json().catch(() => ({}))).error ?? "שגיאה") : "שגיאת רשת";
    err.hidden = false;
  };
}

function renderForgotForm() {
  authShell(`
    <form id="auth-form" class="auth-form">
      <p>נשלח קישור לאיפוס סיסמה אם האימייל רשום אצלנו (חפשו בלוג של השרת בהתקנה עצמית).</p>
      <label class="auth-label">אימייל
        <input id="auth-email" class="auth-input" type="email" required />
      </label>
      <button type="submit" class="auth-submit">שליחת קישור איפוס</button>
      <button type="button" id="auth-back" class="auth-link">חזרה להתחברות</button>
    </form>
  `);
  document.getElementById("auth-back").onclick = () => renderAuthPane("login");
  document.getElementById("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    await fetch("/api/auth/request-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("auth-email").value.trim() }),
    }).catch(() => null);
    authShell(`<p>אם האימייל רשום — נשלח קישור איפוס.</p><a class="auth-link" href="/">חזרה</a>`);
  };
}

async function renderVerifyResult(token) {
  const r = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  const ok = r && r.ok;
  authShell(`
    <p>${ok ? "✅ האימייל אומת בהצלחה!" : "❌ קישור האימות לא תקין או שפג תוקפו."}</p>
    <a class="auth-submit auth-submit--link" href="/">המשך לאפליקציה</a>
  `);
}

function renderResetForm(token) {
  authShell(`
    <form id="auth-form" class="auth-form">
      <label class="auth-label">סיסמה חדשה (8 תווים לפחות)
        <input id="auth-password" class="auth-input" type="password" required minlength="8"
               autocomplete="new-password" />
      </label>
      <p id="auth-error" class="auth-error" hidden></p>
      <button type="submit" class="auth-submit">איפוס סיסמה</button>
    </form>
  `);
  document.getElementById("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/auth/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: document.getElementById("auth-password").value }),
    }).catch(() => null);
    if (r && r.ok) {
      authShell(`<p>✅ הסיסמה אופסה. התחברו מחדש.</p><a class="auth-submit auth-submit--link" href="/">להתחברות</a>`);
      return;
    }
    const err = document.getElementById("auth-error");
    err.textContent = "קישור האיפוס לא תקין או שפג תוקפו.";
    err.hidden = false;
  };
}

async function boot() {
  // T5 operator dashboard lives at /admin — a separate top-level view, gated server-side.
  if (location.pathname === "/admin") {
    await renderAdminDashboard();
    return;
  }
  if (!(await authGate())) return;
  renderShell();
  if (DEMO) applyHealth(true);
  else startHealthPolling();
  wireCopyButton();

  const route = resolveInitialRoute();
  await loadGroupsIntoList();

  if (route.view === "today") {
    renderToday();
  } else if (route.view === "detail") {
    renderDetail(route.group, true);
  } else if (route.view === "total") {
    renderTotal(true);
  } else if (route.view === "ama") {
    renderAma(route.scope ?? null);
  } else if (route.view === "sources") {
    renderSources();
  } else if (route.view === "settings") {
    renderSettings();
  } else if (route.view === "people") {
    renderPeople();
  } else if (route.view === "agenda") {
    renderAgenda();
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
