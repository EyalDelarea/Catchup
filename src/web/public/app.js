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

import { actOnSuggestion, askStream, createScopeCategory, getGroups, getMeetings, getMessages, getPeople, getPreferences, getScopeCategories, getScopes, getStatus, getSummaries, getToday, getTodos, putPreferences, putScopes, resetSuggestionLearning, setTodoDone, summarizeStream } from "./lib/api.js";
import { avatarTint, buildMonthGrid, eventDaySet, groupMeetingsByDay, peopleStatusMeta, relativeDay, todoProgress } from "./lib/agenda.js";
import { activeCount, filterScopes, groupByCategory, partitionRemoved, sectionCount } from "./lib/scopes.js";
import { DIGEST_CHOICES, ENGINE_KINDS, PROACT_LEVELS, isDigestSelected, normalizeEngineConfig, toggleDigestTime } from "./lib/prefs.js";
import { buildDeck, clampIndex, commitActionFor, emptyTally, greeting, indexAfterRemoval, isSuggestion, leavingVariant, peekCount, recordTally, removeCardById, segmentFills, suggestionConfig, tallyBits, tileCounts, TILE_KINDS } from "./lib/today.js";
import { formatAgo, presetToSince, validateRangeInput } from "./lib/time.js";
import { renderInline, renderMarkdown } from "./lib/markdown.js";
import { deriveHealth } from "./lib/health.js";
import { shouldStartBackgroundRefresh } from "./lib/open-state.js";
import { scanFill } from "./lib/phase-loader.js";
import { appendToken, beginQuestion, createConversation, failAnswer, finishAnswer, loadConversation, saveConversation, setPhase } from "./lib/ama-conversation.js";
import { addJob, createJobStore, findJob, markAllRead, markRead, markScopeRead, readyNewestFirst, settleJob, unreadCount, workingForScope } from "./lib/ask-jobs.js";
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
const botNav = document.getElementById("botnav");
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
/** Updates (§3) category filter + the category list backing its chips. */
let catchupFilter = "הכול";
let catchupCategories = [];
/** Active AMA conversation (restored from sessionStorage when the panel opens). */
let amaConversation = createConversation();
/** Scope of the active AMA conversation, for persistence keying. */
let amaScope = null;
/** Async Ask jobs — survive in-session navigation (notifications read from this). */
const askStore = createJobStore();
/** Per-job runtime (not serialized): id → { es, conv, reply, stallTimer }. */
const askRuntime = new Map();
/** Canonical in-memory conversation for any scope with a live job. */
const liveConvByScope = new Map();
/** Monotonic ask id counter. */
let askSeq = 0;

/** Scope → persistence/registry key (mirrors ama-conversation convKey). */
function scopeKey(scope) {
  return scope ?? "*all*";
}
/** True if the Ask screen is currently showing this scope. */
function onAskScreen(scope) {
  return layout?.dataset.view === "ama" && (amaScope ?? null) === (scope ?? null);
}

/** sessionStorage, or null if the browser blocks access (private mode, etc.). */
function amaStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/* ── 2. Routing & nav model ──────────────────────────────── */

/** The "me" card shown in the nav rail. Single-user has no real profile, so this
 *  is a neutral, privacy-consistent placeholder mirroring the prototype card. */
const ME = { name: "החשבון שלי", sub: "מחובר · וואטסאפ", hue: 280 };

/** Vertical nav rail items (prototype order). `count` badges are filled lazily
 *  by the screen loaders via setNavCount(); omit when unknown. */
const NAV = [
  { id: "today", label: "היום", icon: "sun" },
  { id: "catchup", label: "עדכונים", icon: "inbox" },
  { id: "people", label: "אנשים", icon: "users" },
  { id: "meetings", label: "פגישות", icon: "calendar" },
  { id: "todos", label: "משימות", icon: "checks" },
  { id: "ask", label: "שאל", icon: "sparkle" },
  { id: "sources", label: "צ׳אטים", icon: "filter" },
  { id: "settings", label: "הגדרות", icon: "sliders" },
];

/** Mobile bottom-nav: the five most-used surfaces. */
const BOTNAV = ["today", "catchup", "ask", "people", "settings"];

/** Appbar title + subtitle per screen. `sub` may be a function (dynamic date). */
const META = {
  today: { title: "היום", sub: () => todayDateSub() },
  catchup: { title: "עדכונים", sub: "מה פספסת — סיכומים במקום גלילה" },
  detail: { title: "עדכונים", sub: "מה פספסת — סיכומים במקום גלילה" },
  thread: { title: "השיחה המלאה", sub: "ההודעה שהסיכום הצביע עליה" },
  people: { title: "אנשים ולידים", sub: "CRM קליל שנבנה מהשיחות" },
  meetings: { title: "פגישות", sub: "סדר היום — כל פגישה מקושרת למקור" },
  todos: { title: "משימות", sub: "מה שצריך לעשות — מחולץ מהשיחות" },
  ask: { title: "שאל את הוואטסאפ שלך", sub: "תשובות עם מקור — בלי לנחש" },
  sources: { title: "צ׳אטים מוזנים", sub: "בחרו אילו שיחות מזינות את CatchApp" },
  settings: { title: "הגדרות", sub: "פרטיות קודם כול" },
  total: { title: "סיכום כללי", sub: "מה קרה בכל הצ׳אטים" },
};

/** Which nav item is highlighted for a given view. */
function navIdForView(view) {
  if (view === "detail") return "catchup";
  if (view === "thread") return "catchup";
  return view;
}

/** Set the visible-pane hint for CSS (mobile pane visibility / residual styling). */
function setView(view) {
  if (layout) layout.dataset.view = view;
  setActiveNav(navIdForView(view));
}

/**
 * Navigate to a view, pushing a history entry.
 * @param {"today"|"catchup"|"detail"|"total"|"ama"|"ask"|"thread"|"sources"|"settings"|"people"|"meetings"|"todos"} view
 * @param {string|object} [arg] — group name (detail) or AMA scope (ama) or {chat,aroundId} (thread)
 */
function navigate(view, arg) {
  if (view === "ask") view = "ama";
  if (view === "today") {
    history.pushState({ view: "today" }, "", "#today");
    renderToday();
  } else if (view === "catchup") {
    history.pushState({ view: "catchup" }, "", "#catchup");
    renderCatchup();
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
  } else if (view === "meetings") {
    history.pushState({ view: "meetings" }, "", "#meetings");
    renderMeetings();
  } else if (view === "todos") {
    history.pushState({ view: "todos" }, "", "#todos");
    renderTodos();
  } else {
    history.pushState({ view: "today" }, "", "#today");
    renderToday();
  }
}

window.addEventListener("popstate", (e) => {
  teardownStream();
  const state = e.state;
  if (state?.view === "catchup") {
    renderCatchup();
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
  } else if (state?.view === "meetings") {
    renderMeetings();
  } else if (state?.view === "todos") {
    renderTodos();
  } else if (state?.view === "ama") {
    renderAma(state.scope ?? null);
  } else if (state?.view === "thread" && state.chat) {
    renderThread(state.chat, state.aroundId);
  } else {
    renderToday();
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

/* ── 4. Shell: nav rail + appbar + mobile bottom nav ─────── */

/** The CatchApp brand mark — "זינוק" (swoosh): a speech bubble with motion
 *  lines ("catch up fast"), the logo the team locked in. `d3` adds the 3D
 *  app-icon treatment used on large/login surfaces. */
function brandGlyph(size = 34, { d3 = false } = {}) {
  const r = Math.round(size * 0.29);
  return (
    `<div class="bglyph v-swoosh${d3 ? " d3" : ""}" style="width:${size}px;height:${size}px;border-radius:${r}px;font-size:${size}px">`
    + `<svg class="lg-svg" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="M2.5 8.6 H6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".42"/>`
    + `<path d="M1.6 12.6 H5.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".42"/>`
    + `<path d="M10 5 h8.4 a2.8 2.8 0 0 1 2.8 2.8 v5 a2.8 2.8 0 0 1 -2.8 2.8 h-4.4 l-4 3 v-3 a2.8 2.8 0 0 1 -2.8 -2.8 V7.8 A2.8 2.8 0 0 1 10 5 z" fill="currentColor"/>`
    + `</svg></div>`
  );
}

/** Initials + per-entity oklch tint disc (matches the prototype Avatar). */
function avatarHtml(name, hue = 150, size = 36) {
  const initials = (name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("");
  return (
    `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.36)}px;`
    + `background:oklch(0.93 0.045 ${hue});color:oklch(0.42 0.09 ${hue})">${escHtml(initials)}</div>`
  );
}

/** Render the persistent shell once at boot: nav rail + bottom nav. */
function renderShell() {
  paneList.innerHTML = navRailHtml();
  topBar.innerHTML = "";
  if (botNav) botNav.innerHTML = botnavHtml();
  for (const el of paneList.querySelectorAll("[data-nav-id]")) {
    el.addEventListener("click", () => navigate(el.dataset.navId));
  }
  for (const el of botNav?.querySelectorAll("[data-nav-id]") ?? []) {
    el.addEventListener("click", () => navigate(el.dataset.navId));
  }
}

function navRailHtml() {
  const links = NAV.map((n) => `
    <button class="navlink" type="button" data-nav-id="${n.id}" aria-label="${escHtml(n.label)}">
      ${icon(n.icon, { size: 20 })}
      <span>${escHtml(n.label)}</span>
      <span class="count" data-count="${n.id}" hidden></span>
    </button>`).join("");
  return `
    <div class="side-brand">
      ${brandGlyph(34)}
      <div class="wordmark"><b style="font-size:16px">CatchApp</b><small>וואטסאפ, בלי הרעש</small></div>
    </div>
    ${links}
    <div class="side-foot">
      <div class="privacy-card">
        ${icon("lock", { size: 18 })}
        <div><b>הכול נשאר אצלך</b><p>מאוחסן במכשיר · לא נשלח החוצה</p></div>
      </div>
      <div class="side-user">
        ${avatarHtml(ME.name, ME.hue, 36)}
        <div style="min-width:0">
          <div style="font-weight:700;font-size:14px">${escHtml(ME.name)}</div>
          <div class="mono" dir="ltr" style="font-size:11px;color:var(--muted)">${escHtml(ME.sub)}</div>
        </div>
      </div>
    </div>`;
}

function botnavHtml() {
  return BOTNAV.map((id) => {
    const n = NAV.find((x) => x.id === id);
    return `<button type="button" data-nav-id="${id}" aria-label="${escHtml(n.label)}">${icon(n.icon, { size: 21 })}<span>${escHtml(n.label)}</span></button>`;
  }).join("");
}

/** Highlight the active nav item (rail + bottom nav). */
function setActiveNav(id) {
  for (const el of document.querySelectorAll("#pane-list .navlink")) {
    el.classList.toggle("on", el.dataset.navId === id);
  }
  for (const el of document.querySelectorAll("#botnav button")) {
    el.classList.toggle("on", el.dataset.navId === id);
  }
}

/** Fill or clear a nav count badge. */
function setNavCount(id, n) {
  for (const el of document.querySelectorAll(`.count[data-count="${id}"]`)) {
    if (n && n > 0) {
      el.textContent = String(n);
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  }
}

/** Appbar header for the current screen: title + subtitle + action icons + optional back. */
function setAppbar(view, { back, title, sub: subOverride } = {}) {
  const m = META[view] || { title: "", sub: "" };
  const resolvedTitle = title ?? m.title;
  const sub = subOverride ?? (typeof m.sub === "function" ? m.sub() : m.sub);
  const backBtn = back
    ? `<button class="iconbtn" id="appbar-back" type="button" aria-label="חזרה">${icon("chevR", { size: 19 })}</button>`
    : "";
  topBar.innerHTML = `
    ${backBtn}
    <div>
      <h1>${escHtml(resolvedTitle)}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
    <div class="acts">
      <button class="iconbtn" id="appbar-search" type="button" aria-label="חיפוש">${icon("search", { size: 19 })}</button>
      <button class="iconbtn" id="appbar-bell" type="button" aria-label="התראות">${icon("bell", { size: 19 })}</button>
      <button class="iconbtn" id="appbar-theme" type="button" aria-label="החלפת ערכת צבעים">${icon(currentTheme === "dark" ? "sun" : "moon", { size: 19 })}</button>
    </div>`;
  document.getElementById("appbar-back")?.addEventListener("click", () => history.back());
  document.getElementById("appbar-search")?.addEventListener("click", () => navigate("catchup"));
  document.getElementById("appbar-bell")?.addEventListener("click", toggleNotifPanel);
  document.getElementById("appbar-theme")?.addEventListener("click", toggleTheme);
  updateBellBadge();
}

/** Hebrew "weekday, D Month" for the Today appbar subtitle. */
function todayDateSub() {
  try {
    return escHtml(new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" }));
  } catch {
    return "";
  }
}

/** Flip + persist the theme; refresh the appbar toggle icon in place. */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  setTheme(currentTheme);
  const btn = document.getElementById("appbar-theme");
  if (btn) btn.innerHTML = icon(currentTheme === "dark" ? "sun" : "moon", { size: 19 });
}

/** Fetch groups (scope-filtered) into the cache + the עדכונים nav badge. */
async function loadGroupsIntoList() {
  if (DEMO) {
    cachedGroups = DEMO_GROUPS;
    setNavCount("catchup", cachedGroups.length);
    return;
  }
  let groups;
  try {
    groups = await getGroups();
  } catch {
    return;
  }
  // Scope filter (S4 §3): hide excluded/removed chats. Resilient — on any scope
  // failure, fall back to showing all groups (default-on).
  try {
    const byName = new Map((await getScopes()).map((s) => [s.group, s]));
    groups = groups
      .filter((g) => {
        const s = byName.get(g.name);
        return s ? s.included && !s.removed : false;
      })
      .map((g) => ({ ...g, categoryId: byName.get(g.name)?.categoryId ?? null }));
  } catch {
    /* show all on scope-load failure */
  }
  cachedGroups = groups;
  setNavCount("catchup", cachedGroups.length);
}

/** True if the group had activity within the last 24h. */
function isFreshGroup(group) {
  return group.lastMessageAt
    ? Date.now() - new Date(group.lastMessageAt).getTime() < 24 * 60 * 60 * 1000
    : false;
}

/** No-op kept for callers that cleared the old sidebar row highlight. */
function markActiveRow() {}

/** Deterministic per-name avatar hue (stable across renders). */
function hueFromName(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/* ── 4b. Updates (עדכונים) — list-first catch-up ─────────── */
//
// The catch-up surface: a list of fed chats, each a card with a one-line
// summary. Tapping a card opens the structured summary-first chat (renderDetail).

async function renderCatchup() {
  teardownStream();
  setView("catchup");
  setAppbar("catchup");
  paneMain.innerHTML = `<div class="content"><p class="thread-loading">טוען עדכונים…</p></div>`;

  if (cachedGroups.length === 0 && !DEMO) await loadGroupsIntoList();
  if (!DEMO && catchupCategories.length === 0) {
    try {
      catchupCategories = await getScopeCategories();
    } catch {
      /* chips fall back to just "הכול" */
    }
  }
  const groups = cachedGroups;

  if (!groups.length) {
    paneMain.innerHTML = `
      <div class="content">
        <div class="empty">
          <div class="empty-ic">${icon("filter", { size: 26 })}</div>
          <h3>אין צ׳אטים מוזנים</h3>
          <p>בחרו אילו שיחות יזינו את CatchApp כדי לקבל עדכונים.</p>
          <button class="btn btn-soft" id="catchup-manage" type="button">${icon("filter", { size: 15 })}ניהול צ׳אטים</button>
        </div>
      </div>`;
    document.getElementById("catchup-manage")?.addEventListener("click", () => navigate("sources"));
    return;
  }

  // Category chips: "הכול" + any category that has at least one included chat.
  const usedCatIds = new Set(groups.map((g) => g.categoryId).filter((id) => id != null));
  const catChips = catchupCategories
    .filter((c) => usedCatIds.has(c.id))
    .map((c) => ({ name: c.name, id: c.id }));
  const filterNames = ["הכול", ...catChips.map((c) => c.name)];
  if (!filterNames.includes(catchupFilter)) catchupFilter = "הכול";

  const visible =
    catchupFilter === "הכול"
      ? groups
      : groups.filter((g) => catChips.find((c) => c.name === catchupFilter)?.id === g.categoryId);

  const chips = filterNames
    .map((n) => `<span class="chip${n === catchupFilter ? " on" : ""}" data-filter="${escHtml(n)}">${escHtml(n)}</span>`)
    .join("");

  const listOrEmpty =
    visible.length === 0
      ? `<div class="empty">
          <div class="empty-ic">${icon("inbox", { size: 26 })}</div>
          <h3>אין עדכונים בקטגוריה זו</h3>
          <p>נסו קטגוריה אחרת, או הוסיפו עוד צ׳אטים לקבוצה הזו.</p>
        </div>`
      : `<div class="list">${visible.map((g) => buildUpdateCard(g)).join("")}</div>`;

  paneMain.innerHTML = `
    <div class="content">
      <div class="filters">
        <span class="muted" style="font-size:13px;font-weight:700">קבץ לפי:</span>
        ${chips}
        <span class="chip cat-manage" id="catchup-manage">${icon("filter", { size: 14 })}נהל צ׳אטים</span>
      </div>
      ${listOrEmpty}
    </div>`;
  document.getElementById("catchup-manage")?.addEventListener("click", () => navigate("sources"));
  paneMain.querySelector(".filters")?.addEventListener("click", (e) => {
    const ch = e.target.closest(".chip[data-filter]");
    if (!ch) return;
    catchupFilter = ch.dataset.filter;
    renderCatchup();
  });
  for (const card of paneMain.querySelectorAll(".itemcard[data-group]")) {
    card.addEventListener("click", () => navigate("detail", card.dataset.group));
  }
}

function buildUpdateCard(g) {
  const name = formatGroupName(g.name);
  const hue = g.hue ?? hueFromName(g.name);
  const sum = g.sum || "הקישו לסיכום מה שפספסתם בשיחה הזו.";
  const n = g.newCount ?? g.n;
  const newBadge = n ? `<span class="badge accent">${n} חדשות</span>` : "";
  const ago = g.lastMessageAt ? formatAgo(g.lastMessageAt) : "";
  return `
    <div class="itemcard surface" data-group="${escHtml(g.name)}" role="button" tabindex="0">
      ${avatarHtml(name, hue, 40)}
      <div class="grow">
        <h4>${escHtml(name)}${newBadge}</h4>
        <p>${escHtml(sum)}</p>
        ${ago ? `<div class="meta"><span class="muted" style="font-size:12px;font-weight:600">${escHtml(ago)}</span></div>` : ""}
      </div>
      <span class="btn btn-soft" style="align-self:center">פתח ${icon("chevL", { size: 15 })}</span>
    </div>`;
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

  paneMain.innerHTML = buildDetailShell(group);
  setView("detail");
  setAppbar("detail", {
    back: true,
    title: formatGroupName(group),
    sub: fresh
      ? `<span class="dot-live"></span>פעיל${ago ? ` · ${escHtml(ago)}` : ""}`
      : escHtml(ago),
  });
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

function buildDetailShell(group) {
  // The chat identity (avatar/name/live/back) lives in the appbar (set in
  // renderDetail) — here we render the design's summary-first body: time-range
  // chips (.sum-ranges) + the structured .sum-card region + history + ask bar.
  const ranges = [
    ["catchup", "מה שפספסתי"],
    ["24h", "24 שעות"],
    ["3d", "3 ימים"],
    ["week", "שבוע"],
    ["month", "חודש"],
    ["range", "טווח…"],
  ];
  const chips = ranges
    .map(
      ([k, l]) =>
        `<span class="chip${k === "catchup" ? " on" : ""}" data-chip="${k}" role="button" tabindex="0" aria-pressed="${k === "catchup"}">${l}</span>`,
    )
    .join("");
  return `
    <div class="detail-view">
      <div class="sum-ranges" role="group" aria-label="בחירת טווח זמן" id="mode-chips">${chips}</div>

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
    btn.classList.toggle("on", isActive);
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
 * The playful "summarizing" loader (.sumload): a bobbing brand glyph in a
 * pulsing ring, orbiting dots, rising chat bubbles, twinkling sparkles and an
 * indeterminate bar. All motion is CSS and gated behind prefers-reduced-motion.
 */
function buildSumLoader(title, quip, compact = false) {
  return `
    <div class="sumload${compact ? " sumload--compact" : ""}" role="status" aria-live="polite" aria-label="${escHtml(title)}">
      <div class="sumload-scene" aria-hidden="true">
        <div class="sumload-floats"><i></i><i></i><i></i></div>
        <div class="sumload-orbit"><i></i><i></i><i></i></div>
        <div class="sumload-ring"></div>
        <div class="sumload-core">${brandGlyph(compact ? 30 : 38)}</div>
        <span class="sumload-spark s1">${icon("sparkle", { size: 13 })}</span>
        <span class="sumload-spark s2">${icon("sparkle", { size: 11 })}</span>
        <span class="sumload-spark s3">${icon("sparkle", { size: 12 })}</span>
      </div>
      <div class="sumload-title">${escHtml(title)}</div>
      <div class="sumload-quip">${escHtml(quip)}</div>
      <div class="sumload-bar"><b></b></div>
    </div>`;
}

/**
 * Summarize loader (phase-aware copy). Name + signature are kept so existing
 * call sites — and the now no-op tube updaters — need no change; the retired
 * Glacier "phase tube" is replaced by the designed .sumload scene.
 * @param {{ phase?: string }} opts
 */
function buildPhaseTube({ phase = "sync" } = {}) {
  const copy = {
    sync: ["מתחבר לוואטסאפ…", "טוען את ההודעות האחרונות…"],
    read: ["קורא את ההודעות…", "עובר על מה שפספסת…"],
    summarize: ["בונה את הסיכום…", "מתמצת לכמה שורות ✦"],
    done: ["מסיים…", "כמעט שם ✦"],
  };
  const [title, quip] = copy[phase] || copy.sync;
  return buildSumLoader(title, quip);
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
      // Inline markdown (bold label + chat tags), citation markers stripped —
      // the source-jump button carries the real messageId for attribution.
      const text = renderInline(b.text);
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
  setAppbar("total", { back: true });

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
  // Reuse the live in-memory conversation while a job is streaming into this
  // scope, so a background answer and the visible thread can't diverge.
  amaConversation = liveConvByScope.get(scopeKey(amaScope)) ?? loadConversation(amaStorage(), amaScope);
  paneMain.innerHTML = `
    <div class="ama2">
      <div class="ama-scroll" id="ama-scroll">
        <div class="content">
          <div class="chat" id="ama-messages" aria-live="polite">
            <div class="empty">
              <div class="empty-ic">${icon("sparkle", { size: 26 })}</div>
              <p>${scope ? "שאל כל שאלה על הצ׳אט הזה ✨" : "שאל כל שאלה על השיחות שלך ✨"}</p>
            </div>
          </div>
          ${amaSuggestHtml(scope)}
        </div>
      </div>
      <form class="askbar" id="ama-form">
        <label class="field">${icon("message", { size: 18 })}<input id="ama-q" type="text"
          placeholder="${scope ? "שאל על הצ׳אט הזה…" : "שאל על כל ההיסטוריה שלך…"}" aria-label="שאלה" autocomplete="off" /></label>
        <button class="btn btn-primary" type="submit" aria-label="שלח">${icon("arrowL", { size: 18 })}שלח</button>
      </form>
    </div>`;
  setView("ama");
  setAppbar("ask");
  // Viewing a scope clears its unread answers + refreshes the bell badge.
  markScopeRead(askStore, amaScope);
  updateBellBadge();

  // Replace the empty-state hint with the restored thread, if there is one.
  if (amaConversation.messages.length) renderAmaMessages();

  document.getElementById("ama-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAmaQuestion(scope);
  });

  // Delegate citation clicks (chips are re-rendered on every token) → source jump.
  document.getElementById("ama-messages")?.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".src[data-chat]");
    if (!chip) return;
    const chat = chip.dataset.chat;
    const id = Number(chip.dataset.id);
    if (chat && Number.isFinite(id)) navigate("thread", { chat, aroundId: id });
  });

  // Suggestion chips fill the box and submit.
  for (const chip of document.querySelectorAll(".suggrow .chip")) {
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
  "סכם את כל הקבוצות מהשבוע",
  "למי עדיין לא חזרתי?",
];

/** Suggestion-chip row — only on the global Ask with an empty thread. */
function amaSuggestHtml(scope) {
  if (scope || amaConversation.messages.length) return "";
  const chips = AMA_SUGGESTIONS.map(
    (q) => `<button type="button" class="chip" data-q="${escHtml(q)}">${escHtml(q)}</button>`,
  ).join("");
  return `<div class="suggrow">${chips}</div>`;
}

/** No SSE activity for this long → treat the request as stuck and surface it. */
const AMA_STALL_MS = 120_000;

/**
 * Send the typed question to /api/ask as a background job that survives
 * in-session navigation: each job owns its EventSource (never the shared
 * `activeEventSource`, so `teardownStream()` won't kill it) and streams into the
 * scope's conversation. When it lands while the user is elsewhere, a toast +
 * bell badge bring them back to the answer.
 */
function submitAmaQuestion(scope) {
  const sc = scope ?? null;
  if (workingForScope(askStore, sc)) return; // one in-flight question per scope
  const input = document.getElementById("ama-q");
  const q = (input?.value || "").trim();
  const conv = amaConversation; // we're on the Ask screen for this scope
  const reply = beginQuestion(conv, q);
  if (!reply) return;
  if (input) input.value = "";
  document.querySelector(".suggrow")?.remove();

  const id = `ask${++askSeq}`;
  reply.id = id;
  liveConvByScope.set(scopeKey(sc), conv);
  addJob(askStore, { id, q, scope: sc, ts: Date.now() });
  renderAmaMessages();
  saveConversation(amaStorage(), sc, conv);

  const rt = { es: null, conv, reply, stallTimer: null };
  askRuntime.set(id, rt);
  const rerender = () => { if (onAskScreen(sc)) renderAmaMessages(); };

  const settle = () => {
    if (rt.stallTimer) { clearTimeout(rt.stallTimer); rt.stallTimer = null; }
    if (rt.es) { rt.es.close(); rt.es = null; }
    askRuntime.delete(id);
    liveConvByScope.delete(scopeKey(sc));
    saveConversation(amaStorage(), sc, conv);
    const read = onAskScreen(sc);
    const status = reply.error ? "error" : "ready";
    settleJob(askStore, id, { status, answer: reply.text, citations: reply.citations, read });
    rerender();
    updateBellBadge();
    if (status === "ready" && !read) showAskToast(id);
  };
  // Reset on every event; if the server goes silent for too long (a hung or
  // overloaded model), fail visibly instead of spinning "חושב…" forever.
  const armStall = () => {
    if (rt.stallTimer) clearTimeout(rt.stallTimer);
    rt.stallTimer = setTimeout(() => {
      if (reply.pending) failAnswer(reply, "אין תגובה מהשרת. נסה שוב.");
      settle();
    }, AMA_STALL_MS);
  };
  armStall();

  rt.es = askStream({ q, chat: sc ?? undefined }, {
    phase: (d) => {
      armStall();
      setPhase(reply, d.phase);
      rerender();
    },
    token: (d) => {
      armStall();
      appendToken(reply, d.delta);
      rerender();
      saveConversation(amaStorage(), sc, conv);
    },
    citations: (d) => finishAnswer(reply, d.citations),
    done: (d) => {
      // Show the designed "no results" surface when the answer cited nothing AND
      // either retrieval was empty or the model returned its no-relevant-info
      // marker — an answer that actually found something always carries citations.
      const noCites = !(reply.citations && reply.citations.length);
      const noInfo = /אין הודעות רלוונט|אין מידע/.test(reply.text || "");
      if (noCites && (d?.candidateCount === 0 || noInfo)) {
        reply.noResults = true;
        reply.pending = false;
      }
      settle();
    },
    error: (d) => {
      // A dropped connection after the answer completed is not a failure.
      if (reply.pending) failAnswer(reply, d.message);
      settle();
    },
  });
}

/** AI-answer avatar disc (accent-tinted sparkle), matching the prototype. */
function amaAiAvatar() {
  return `<div class="avatar" style="width:34px;height:34px;flex:none;background:var(--accent-weak);color:var(--accent-ink)">${icon("sparkle", { size: 17 })}</div>`;
}

function renderAmaMessages() {
  const el = document.getElementById("ama-messages");
  if (!el) return;
  el.innerHTML = amaConversation.messages.map((m) => {
    if (m.role === "user") {
      return `<div class="msg me"><div class="bubble">${escHtml(m.text)}</div></div>`;
    }
    if (m.pending && !m.text) {
      const [title, sub] =
        m.phase === "synthesizing"
          ? ["מנסח תשובה…", "מסכם את מה שנמצא"]
          : m.phase === "searching"
            ? ["מחפש בכל ההיסטוריה…", "קורא הודעות רלוונטיות"]
            : ["חושב…", ""];
      return `<div class="msg ai"><div class="ask-state"><span class="sg-spark">${icon("sparkle", { size: 16 })}</span><div><b>${title}</b>${sub ? `<div class="ask-sub">${sub}</div>` : ""}</div><span class="ob-dots"><i></i><i></i><i></i></span></div></div>`;
    }
    if (m.noResults) {
      return `<div class="msg ai" data-msg-id="${escHtml(m.id || "")}"><div class="empty err"><div class="empty-ic err-ic err-ic--wiggle">${icon("search", { size: 26 })}<span class="err-ring"></span></div><h3>לא מצאתי על זה כלום</h3><p>לא נמצאו הודעות רלוונטיות בשיחות שבחרת. נסו לנסח אחרת או להרחיב את טווח הצ׳אטים.</p></div></div>`;
    }
    if (m.error) {
      return `<div class="msg ai" data-msg-id="${escHtml(m.id || "")}">${amaAiAvatar()}<div><div class="bubble" style="color:var(--warn-ink)">${escHtml(m.error)}</div></div></div>`;
    }
    return `<div class="msg ai" data-msg-id="${escHtml(m.id || "")}">${amaAiAvatar()}<div><div class="bubble">${escHtml(m.text)}</div>${renderAmaSources(m.citations)}</div></div>`;
  }).join("");
  const scroller = document.getElementById("ama-scroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

/** Render the resolved [n] citations under an answer bubble as source chips.
 *  Each chip is a button that jumps to the cited message in its chat thread. */
function renderAmaSources(citations) {
  if (!citations?.length) return "";
  const items = citations.map((c) =>
    `<button type="button" class="src" data-chat="${escHtml(c.chat)}" data-id="${c.messageId}">` +
    `${icon("source", { size: 13 })}<span><span dir="ltr">[${c.n}]</span> ${escHtml(formatGroupName(c.chat))}</span>` +
    `<span class="src-date" dir="ltr"> · ${escHtml(fmtTime(c.sentAt))}</span></button>`
  ).join("");
  return `<div class="cites">${items}</div>`;
}

/* ── 7a. Async-ask notifications (bell badge · panel · toast · flash) ── */

/** A fixed host for app-level ask overlays (panel + toast + clearbar), mounted once. */
function askOverlayHost() {
  let host = document.getElementById("ask-overlays");
  if (!host) {
    host = document.createElement("div");
    host.id = "ask-overlays";
    document.body.appendChild(host);
  }
  return host;
}

/** Reflect the unread count on the appbar bell (badge hidden at 0). */
function updateBellBadge() {
  const bell = document.getElementById("appbar-bell");
  if (!bell) return;
  bell.classList.add("notif-bell");
  const n = unreadCount(askStore);
  let badge = bell.querySelector(".notif-badge");
  if (n > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "notif-badge";
      bell.appendChild(badge);
    }
    badge.textContent = String(n);
  } else if (badge) {
    badge.remove();
  }
}

let notifPanelOpen = false;
function toggleNotifPanel() {
  if (notifPanelOpen) closeNotifPanel();
  else openNotifPanel();
}
function closeNotifPanel() {
  notifPanelOpen = false;
  document.getElementById("notif-panel")?.remove();
  document.getElementById("notif-back")?.remove();
}

/** Open the notifications panel: ready answers newest-first. */
function openNotifPanel() {
  notifPanelOpen = true;
  const host = askOverlayHost();
  const items = readyNewestFirst(askStore);
  const anyUnread = items.some((j) => !j.read);
  const list = items.length
    ? items
        .map(
          (j) => `
      <button type="button" class="notif-item${j.read ? "" : " unread"}" data-job="${escHtml(j.id)}">
        <span class="notif-ic">${icon("sparkle", { size: 16 })}</span>
        <span class="notif-body">
          <span class="notif-title">התשובה מוכנה</span>
          <span class="notif-q">${escHtml(j.q)}</span>
          <span class="notif-scope">${icon("filter", { size: 12 })}${escHtml(scopeLabel(j.scope))}</span>
        </span>
        ${j.read ? "" : `<span class="notif-dot"></span>`}
      </button>`,
        )
        .join("")
    : `<div class="notif-empty">${icon("bell", { size: 26 })}<span>אין התראות כרגע</span></div>`;
  host.insertAdjacentHTML(
    "beforeend",
    `<div id="notif-back" class="notif-back"></div>
     <div id="notif-panel" class="notif-panel surface" role="dialog" aria-label="התראות">
       <div class="notif-head"><b>התראות</b>${anyUnread ? `<button type="button" class="notif-clear" id="notif-markall">סמן הכל כנקרא</button>` : ""}</div>
       <div class="notif-list">${list}</div>
     </div>`,
  );
  document.getElementById("notif-back")?.addEventListener("click", closeNotifPanel);
  document.getElementById("notif-markall")?.addEventListener("click", () => {
    markAllRead(askStore);
    updateBellBadge();
    closeNotifPanel();
  });
  for (const it of document.querySelectorAll("#notif-panel .notif-item")) {
    it.addEventListener("click", () => openAskJob(it.dataset.job));
  }
}

let askToastTimer = null;
function dismissAskToast() {
  if (askToastTimer) {
    clearTimeout(askToastTimer);
    askToastTimer = null;
  }
  document.getElementById("ask-toast")?.remove();
}

/** Slide up a toast when an answer lands while the user is elsewhere. */
function showAskToast(id) {
  const job = findJob(askStore, id);
  if (!job) return;
  dismissAskToast();
  askOverlayHost().insertAdjacentHTML(
    "beforeend",
    `<div id="ask-toast" class="asktoast surface" role="status" data-job="${escHtml(id)}">
       <span class="asktoast-ic">${icon("sparkle", { size: 18 })}</span>
       <span class="asktoast-body"><span class="asktoast-title">התשובה מוכנה ✦</span><span class="asktoast-q">${escHtml(job.q)}</span></span>
       <button type="button" class="btn btn-primary" id="ask-toast-view">צפה</button>
       <button type="button" class="asktoast-x" id="ask-toast-x" aria-label="סגור">${icon("x", { size: 16 })}</button>
     </div>`,
  );
  document.getElementById("ask-toast-view")?.addEventListener("click", () => openAskJob(id));
  document.getElementById("ask-toast-x")?.addEventListener("click", dismissAskToast);
}

/** Open a job's answer: clear its unread, dismiss chrome, navigate to its scope, flash it. */
function openAskJob(id) {
  const job = findJob(askStore, id);
  if (!job) return;
  markRead(askStore, id);
  closeNotifPanel();
  dismissAskToast();
  navigate("ama", job.scope ?? undefined);
  requestAnimationFrame(() => flashAskMsg(id));
}

/** Briefly highlight an answer bubble (reduced-motion: CSS no-ops the animation). */
function flashAskMsg(id) {
  const node = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  const bubble = node?.querySelector(".bubble") || node;
  if (!bubble) return;
  bubble.classList.add("flash");
  setTimeout(() => bubble.classList.remove("flash"), 1800);
}

/** Scope → human label for notifications + the scope picker. */
function scopeLabel(scope) {
  return scope == null ? "כל הצ׳אטים" : formatGroupName(scope);
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
  setView("thread");
  setAppbar("thread", { back: true });
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
let sourcesMenuWired = false;

/** Close every open per-row ⋯ overflow menu in Sources. */
function closeAllSourceMenus() {
  for (const m of document.querySelectorAll(".src-row .cl-menu")) m.hidden = true;
  for (const b of document.querySelectorAll('.src-row [data-act="menu"]')) {
    b.setAttribute("aria-expanded", "false");
  }
}

/** The Sources control center (§7): whitelist/blacklist + categorize chats. */
async function renderSources() {
  teardownStream();
  setView("sources");
  setAppbar("sources");
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
      <div class="sources-callout">
        <span class="sources-callout__ico">${icon("filter", { size: 22 })}</span>
        <div class="grow">
          <b>אתם בוחרים מה CatchApp רואה</b>
          <p>רק צ׳אטים מסומנים מוזנים לסיכום, לעדכונים ולהצעות. תייגו לפי הקשר כדי לכוון את המערכת.</p>
        </div>
        <span class="badge accent" dir="ltr">${counts.active}/${counts.total} פעילים</span>
      </div>
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
      <p class="src-legend">מתג = הכללה/החרגה · ✕ = הסרה · ירח = השתקת הצעות · ״קבוצה״ ליצירת קטגוריה</p>
    </div>`;
  wireSources();
}

function buildSourcesSection(section) {
  const title = section.category ? escHtml(section.category.name) : "ללא קטגוריה";
  const n = sectionCount(section.scopes);
  const anyIncluded = section.scopes.some((s) => s.included);
  const bulkLabel = anyIncluded ? "כבה הכול" : "הפעל הכול";
  const rows = section.scopes.map((s, i) => (i ? '<div class="divide"></div>' : "") + buildSourceRow(s)).join("");
  return `
    <div class="src-section">
      <div class="src-section__head">
        <span class="src-section__title">${title} <span class="src-section__count mono" dir="ltr">${n}</span></span>
        ${section.scopes.length ? `<button class="src-bulk" data-bulk="${anyIncluded ? "off" : "on"}" data-cat="${section.category?.id ?? ""}" type="button">${bulkLabel}</button>` : ""}
      </div>
      ${section.scopes.length ? `<div class="src-card surface">${rows}</div>` : `<p class="src-empty-cat">אין צ׳אטים בקטגוריה זו</p>`}
    </div>`;
}

function buildSourceRow(s) {
  const name = formatGroupName(s.group);
  const catName = sourcesState.categories.find((c) => c.id === s.categoryId)?.name;
  const status = !s.included ? "מוחרג — לא ינוטר" : s.muted ? "מושתק · עדכונים בלבד" : "מוזן ל-CatchApp";
  const statusLine = catName ? `${escHtml(status)} · ${escHtml(catName)}` : escHtml(status);
  const moveItems = sourcesState.categories
    .filter((c) => c.id !== s.categoryId)
    .map((c) => `<button data-act="cat" data-cat="${c.id}" type="button">${escHtml(c.name)}${icon("chevL", { size: 13 })}</button>`)
    .join("");
  const toNone = s.categoryId != null ? `<button data-act="cat" data-cat="" type="button">ללא קטגוריה${icon("chevL", { size: 13 })}</button>` : "";
  return `
    <div class="src-row${s.included ? "" : " src-row--off"}" data-group="${escHtml(s.group)}">
      ${avatarHtml(name, hueFromName(s.group), 38)}
      <div class="src-row__body">
        <div class="src-row__name">${escHtml(name)}</div>
        <div class="src-row__status">${statusLine}</div>
      </div>
      ${
        s.included
          ? `<button class="src-mute${s.muted ? " is-on" : ""}" data-act="mute" type="button"
        aria-pressed="${s.muted ? "true" : "false"}"
        aria-label="${s.muted ? "בטל השתקת הצעות" : "השתק הצעות"}"
        title="${s.muted ? "ההצעות מושתקות — הצ׳אט עדיין מופיע בעדכונים" : "השתק הצעות (הצ׳אט עדיין מופיע בעדכונים)"}">${icon("moon", { size: 15 })}</button>`
          : ""
      }
      <div class="src-actions-wrap">
        <button class="cl-ico" data-act="menu" type="button" aria-haspopup="true" aria-expanded="false" aria-label="פעולות">${icon("more", { size: 18 })}</button>
        <div class="cl-menu surface" hidden>
          <button data-act="toggle" type="button">${s.included ? "הסר מהסיכום" : "כלול בסיכום"}${icon(s.included ? "x" : "check", { size: 14 })}</button>
          <div class="cl-menu-label">העבר לקבוצה</div>
          ${moveItems}${toNone}
          <div class="divide"></div>
          <button class="danger" data-act="remove" type="button">הסר מהרשימה${icon("trash", { size: 14 })}</button>
        </div>
      </div>
      <button class="src-switch${s.included ? " is-on" : ""}" data-act="toggle" type="button"
        role="switch" aria-checked="${s.included}" aria-label="${s.included ? "מוזן" : "מוחרג"}">
        <span class="src-switch__knob"></span>
      </button>
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
    if (u.muted !== undefined) row.muted = u.muted;
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
    // The include switch AND the menu's "כלול/הסר מהסיכום" item both toggle inclusion.
    for (const t of row.querySelectorAll('[data-act="toggle"]')) {
      t.addEventListener("click", () => {
        const s = sourcesState.scopes.find((x) => x.group === group);
        applyScopeChange([{ group, included: !s.included }]);
      });
    }
    row.querySelector('[data-act="mute"]')?.addEventListener("click", () => {
      const s = sourcesState.scopes.find((x) => x.group === group);
      applyScopeChange([{ group, muted: !s.muted }]);
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: true }]),
    );
    row.querySelector('[data-act="restore"]')?.addEventListener("click", () =>
      applyScopeChange([{ group, removed: false }]),
    );
    for (const cb of row.querySelectorAll('[data-act="cat"]')) {
      cb.addEventListener("click", () => {
        const val = cb.dataset.cat;
        applyScopeChange([{ group, categoryId: val === "" ? null : Number(val) }]);
      });
    }
    // ⋯ overflow menu (move-to-group + remove): open one at a time.
    const menuBtn = row.querySelector('[data-act="menu"]');
    const menu = row.querySelector(".cl-menu");
    if (menuBtn && menu) {
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        closeAllSourceMenus();
        menu.hidden = !willOpen;
        menuBtn.setAttribute("aria-expanded", String(willOpen));
      });
      menu.addEventListener("click", (e) => e.stopPropagation());
    }
  }
  // Close any open ⋯ menu on an outside click (wired once).
  if (!sourcesMenuWired) {
    sourcesMenuWired = true;
    document.addEventListener("click", closeAllSourceMenus);
  }
}

/* ── 7d. Settings (preferences §8) ───────────────────────── */

const settingsState = { prefs: null };

/** Morning-notification preview (§8): a lock-screen push mock overlaid on the
 *  main column. Dismiss by tapping the backdrop, the "סגירה" button, or Esc. */
function showNotifPreview() {
  const host = document.querySelector(".main");
  if (!host || document.getElementById("notif-preview")) return;
  const el = document.createElement("div");
  el.className = "notif-preview";
  el.id = "notif-preview";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "תצוגה מקדימה של התראת הבוקר");
  el.innerHTML = `
    <div>
      <div class="notif-card">
        <span class="notif-app">${brandGlyph(38)}</span>
        <div class="notif-body">
          <div class="notif-head">CatchApp<span class="when">עכשיו</span></div>
          <div class="notif-title">הסיכום של היום מוכן ✦</div>
          <div class="notif-text">5 דברים מחכים לך · קריאה של דקה.</div>
        </div>
      </div>
      <button class="notif-dismiss" type="button">סגירה</button>
    </div>`;
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  // Backdrop click or "סגירה" closes; clicks inside the card do not.
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest(".notif-dismiss")) close();
  });
  document.addEventListener("keydown", onKey);
  host.appendChild(el);
}

/** A centered warn-tinted confirm dialog (§8 delete-everything). Calls onConfirm
 *  when the danger button is pressed; dismisses on backdrop / cancel / Esc. */
function showConfirm({ title, body, confirmLabel, onConfirm }) {
  const host = document.querySelector(".main");
  if (!host || document.getElementById("confirm-overlay")) return;
  const el = document.createElement("div");
  el.className = "notif-preview";
  el.id = "confirm-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", title);
  el.innerHTML = `
    <div class="confirm-card surface">
      <div class="confirm-ic">${icon("trash", { size: 22 })}</div>
      <b>${escHtml(title)}</b>
      <p>${escHtml(body)}</p>
      <div class="confirm-row">
        <button class="btn btn-ghost" type="button" data-confirm="cancel">ביטול</button>
        <button class="btn btn-danger" type="button" data-confirm="ok">${escHtml(confirmLabel)}</button>
      </div>
    </div>`;
  const close = () => {
    el.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest('[data-confirm="cancel"]')) return close();
    if (e.target.closest('[data-confirm="ok"]')) {
      close();
      onConfirm?.();
    }
  });
  document.addEventListener("keydown", onKey);
  host.appendChild(el);
}

/** The Settings screen (§8): privacy callout, daily digest, display mode,
 *  and the experimental suggestion-engine config. Fetch-on-entry, then paint. */
async function renderSettings() {
  teardownStream();
  setView("settings");
  setAppbar("settings");
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
        </div>
        <div class="set-divide"></div>
        <div class="setrow">
          ${icon("sparkle", { cls: "set-ico" })}
          <div class="setrow__body"><h4>איפוס למידה</h4><p>אפסו את ההעדפות שנלמדו והתחילו מחדש</p></div>
          <button class="set-btn" data-act="engine-reset" type="button">אפס</button>
        </div>`
            : ""
        }
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
          <button class="set-btn set-btn--danger" data-act="wipe" type="button">מחיקה</button>
        </div>
      </div>

      <h2 class="set-sec">הסיכום היומי</h2>
      <div class="set-card">
        <div class="setrow">
          ${icon("bell", { cls: "set-ico" })}
          <div class="setrow__body"><h4>התראת בוקר</h4><p>תזכורת עדינה כשהסיכום מוכן</p></div>
          <button class="btn btn-ghost btn-sm" data-act="notif-preview" type="button" style="margin-inline-end:8px">תצוגה מקדימה</button>
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
  document
    .querySelector('[data-act="notif-preview"]')
    ?.addEventListener("click", showNotifPreview);

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
  document.querySelector('[data-act="engine-reset"]')?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    resetSuggestionLearning()
      .then(() => {
        btn.textContent = "אופס ✓";
      })
      .catch(() => {
        btn.textContent = "לא הצליח";
      })
      .finally(() => setTimeout(() => { btn.textContent = "אפס"; btn.disabled = false; }, 1800));
  });
  document.querySelector('[data-act="wipe"]')?.addEventListener("click", () => {
    showConfirm({
      title: "למחוק הכול?",
      body: "ניתוק וואטסאפ ומחיקת כל ההודעות, הסיכומים והנתונים מהמכשיר. אי אפשר לבטל.",
      confirmLabel: "מחק הכול",
      // No server-side wipe endpoint yet — be honest rather than fake success.
      onConfirm: () => showMainToast("המחיקה עדיין לא זמינה — נתקו ידנית בהגדרות וואטסאפ"),
    });
  });
}

/** A transient toast pinned to the bottom of the main column (reuses .dg-flash). */
function showMainToast(text) {
  const host = document.querySelector(".main");
  if (!host) return;
  const t = document.createElement("div");
  t.className = "dg-flash show";
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/** Apply + persist a theme choice and keep the appbar toggle icon in sync. */
function setDisplayMode(value) {
  currentTheme = value;
  setTheme(currentTheme);
  const btn = document.getElementById("appbar-theme");
  if (btn) btn.innerHTML = icon(currentTheme === "dark" ? "sun" : "moon", { size: 19 });
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
  side: { meetings: [], todos: [], people: [] },
};

/** Command-center side-rail demo fixtures (mirror the prototype). */
const DEMO_SIDE = {
  meetings: [
    { title: "קפה עם יוסי", where: "קפה לנדוור, רוטשילד", time: "14:00" },
    { title: "שיחה עם הקבלן", where: "טלפון", time: "17:30" },
  ],
  todos: [
    { title: "להחזיר מחיר לרונית", done: false },
    { title: "לאשר תקציב לצוות", done: false },
    { title: "לשלם על הטיול השנתי", done: false },
  ],
  people: [
    { name: "משה לוי", hue: 40, status: "מתקרר", warn: true, note: "אין קשר 9 ימים" },
    { name: "דנה כהן", hue: 20, status: "ממתינה", warn: true, note: "שאלה על הדירה" },
  ],
};

/** Today story-deck demo payload (matches the /api/suggestions contract). */
const DEMO_TODAY = {
  info: {
    highlights: "42 הודעות חדשות בצוות העבודה, דנה מחכה לתשובה על הדירה, ובכיתת הילדים נפתח תשלום לטיול עד יום ראשון.",
    perChat: [{ chat: "צוות עבודה", summary: "סוכם דדליין ליום חמישי; נשאר רק לאשר את התקציב." }],
  },
  suggestions: [
    { id: 1, kind: "task", chat: "צוות עבודה", proposedText: "להכין מצגת לישיבת הסטטוס", reason: "זוהו 4 הודעות על המצגת שעדיין לא נענו", sourceMessageId: null },
    { id: 2, kind: "meeting", chat: "יוסי טל", proposedText: "פגישת סטטוס · יום ה׳ 10:00", reason: "מנסים לתאם כבר 3 הודעות בלי לסגור מועד", sourceMessageId: null },
    { id: 3, kind: "followup", chat: "דנה כהן", proposedText: "לחזור לדנה לגבי הדירה", reason: "לא ענית 3 ימים — השיחה נשארה פתוחה", sourceMessageId: null },
    { id: 4, kind: "recap", chat: "כיתת הילדים", proposedText: "תשלום לטיול עד יום ראשון\nדרושים 2 מלווים נוספים\nלהחזיר אישור חתום", reason: "31 הודעות חדשות סוכמו לעיקר", sourceMessageId: null },
  ],
};

/** ISO timestamp → "HH:MM" (Latin, for the mono time column). */
function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

/** True when the user asked the OS to minimize motion. */
function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Fetch-on-entry: load the deck, then paint. A 404/empty/error → empty state. */
async function renderToday() {
  teardownStream();
  setView("today");
  setAppbar("today");
  // Re-paint Today when the viewport crosses the board/stack breakpoint (once).
  if (!todayState.mediaWired && window.matchMedia) {
    todayState.mediaWired = true;
    window.matchMedia("(min-width: 780px)").addEventListener("change", () => {
      if (layout?.dataset.view === "today") paintToday();
    });
  }
  paneMain.innerHTML = `<div class="content wide"><div class="dg-loading surface">${buildSumLoader("בונה את הסיכום היומי…", "עובר על הצ׳אטים שבחרת ✦")}</div></div>`;

  let data = null;
  try {
    data = DEMO ? DEMO_TODAY : await getToday();
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
  todayState.side = await loadTodaySide();

  // Only the empty state needs the engine on/off hint — fetch it lazily.
  if (todayState.deck.length === 0 && !DEMO) {
    try {
      todayState.engineOn = normalizeEngineConfig((await getPreferences()).engineConfig).on;
    } catch {
      /* keep the optimistic default */
    }
  }
  setNavCount("today", todayState.deck.filter(isSuggestion).length);
  paintToday();
}

/** Command-center side-rail data: today's meetings, open to-dos, follow-up
 *  people. Best-effort against the live endpoints; demo uses small fixtures. */
async function loadTodaySide() {
  if (DEMO) return { ...DEMO_SIDE, discover: [] };
  const [meetings, todos, people, scopes] = await Promise.all([
    getMeetings().catch(() => []),
    getTodos().catch(() => []),
    getPeople().catch(() => []),
    getScopes().catch(() => []),
  ]);
  // "שיחות שאולי פיספת": chats with recent activity that aren't included yet
  // (default-OFF) and weren't removed — the design's discover/miss nudge. Top 3.
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const discover = (Array.isArray(scopes) ? scopes : [])
    .filter((s) => !s.included && !s.removed && s.messageCount > 0 && s.lastMessageAt && new Date(s.lastMessageAt).getTime() > weekAgo)
    .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
    .slice(0, 3)
    .map((s) => ({ name: s.group, hue: hueFromName(s.group), why: `${s.messageCount} הודעות · פעילה לאחרונה` }));
  return { meetings, todos, people, discover };
}

function paintToday() {
  const total = todayState.deck.length;
  const hasSuggestionsLeft = todayState.deck.some(isSuggestion);

  // Desktop ≥780px = the web-native digest board (v2); narrower = the v1 phone
  // Stories stack. Both share the deck + onTodayAct; only the hero markup differs.
  let hero;
  if (isBoardLayout()) {
    hero = buildDigestBoard(total, hasSuggestionsLeft);
  } else {
    let body;
    if (total === 0) {
      body = todayState.acted > 0 ? buildDoneState(todayState.tally) : buildEmptyToday(todayState.engineOn);
    } else if (!hasSuggestionsLeft && todayState.acted > 0) {
      body = buildDoneState(todayState.tally);
    } else {
      body = buildStoryStack();
    }
    hero = `
      <div class="today">
        ${buildTodayHeader(new Date())}
        <div class="today-note">${icon("sparkle", { size: 13 })}<span>הצעות חכמות שנבנות מהשיחות — ומתחדדות לפי הבחירות שלך</span></div>
        ${body}
        <div class="today-foot">${buildTodayFoot(total, hasSuggestionsLeft)}</div>
        ${buildTiles()}
      </div>`;
  }

  paneMain.innerHTML = `
    <div class="content wide">
      <div class="cc">
        <div class="cc-hero">${hero}</div>
        <aside class="cc-side">${buildCommandSide()}</aside>
      </div>
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
    <div class="today-head">
      <div>
        <div class="kicker">הסיכום היומי</div>
        <div class="greet">${escHtml(greet)}</div>
      </div>
      <div class="date">${dateStr}</div>
    </div>`;
}

/** The desktop command-center side rail: meetings today · open to-dos ·
 *  follow-up people · an Ask shortcut. Each row links to its full screen. */
function buildCommandSide() {
  const side = todayState.side || { meetings: [], todos: [], people: [], discover: [] };
  const meetings = (side.meetings || []).slice(0, 3);
  const openTodos = (side.todos || []).filter((t) => !t.done).slice(0, 4);
  const followups = (side.people || []).filter((p) => p.warn || p.status?.includes("מתקרר")).slice(0, 3);
  const discover = (side.discover || []).slice(0, 3);

  const meetingRows = meetings.length
    ? meetings.map((m) => `
        <div class="cc-row" data-go="meetings">
          <div class="grow"><div class="cc-row-t">${escHtml(m.title || "")}</div>
          <div class="cc-row-s">${escHtml(m.where || m.chat || "")}</div></div>
          <div class="cc-row-time mono" dir="ltr">${escHtml(m.time || (m.startsAt ? formatTime(m.startsAt) : ""))}</div>
        </div>`).join("")
    : `<div class="cc-empty">אין פגישות היום ✦</div>`;

  const todoRows = openTodos.length
    ? openTodos.map((t) => `
        <div class="cc-todo" data-go="todos"><span class="cc-check"></span><span>${escHtml(t.title || "")}</span></div>`).join("")
    : `<div class="cc-empty">אין משימות פתוחות</div>`;

  const followRows = followups.length
    ? followups.map((p) => `
        <div class="cc-row" data-go="people">
          ${avatarHtml(p.name, p.hue ?? 40, 30)}
          <div class="grow"><div class="cc-row-t">${escHtml(p.name || "")}<span class="badge warn" style="margin-inline-start:6px">${escHtml(p.status || "מתקרר")}</span></div>
          <div class="cc-row-s">${escHtml(p.note || p.next || "")}</div></div>
        </div>`).join("")
    : `<div class="cc-empty">אין מה לעקוב כרגע</div>`;

  return `
    <div class="cc-panel surface">
      <div class="cc-panel-h" data-go="meetings">
        <span class="cc-panel-ic">${icon("calendar", { size: 16 })}</span>
        <b>פגישות היום</b><span class="cc-count">${meetings.length}</span>
        <span class="cc-more">${icon("chevL", { size: 15 })}</span>
      </div>
      <div class="cc-panel-body">${meetingRows}</div>
    </div>
    <div class="cc-panel surface">
      <div class="cc-panel-h" data-go="todos">
        <span class="cc-panel-ic">${icon("checks", { size: 16 })}</span>
        <b>משימות פתוחות</b><span class="cc-count">${openTodos.length}</span>
        <span class="cc-more">${icon("chevL", { size: 15 })}</span>
      </div>
      <div class="cc-panel-body">${todoRows}</div>
    </div>
    <div class="cc-panel cc-panel--accent surface">
      <div class="cc-panel-h" data-go="people">
        <span class="cc-panel-ic">${icon("flame", { size: 16 })}</span>
        <b>דורש מעקב</b><span class="cc-count">${followups.length}</span>
        <span class="cc-more">${icon("chevL", { size: 15 })}</span>
      </div>
      <div class="cc-panel-body">${followRows}</div>
    </div>
    ${
      discover.length
        ? `<div class="cc-panel surface">
      <div class="cc-panel-h" data-go="sources">
        <span class="cc-panel-ic">${icon("filter", { size: 16 })}</span>
        <b>שיחות שאולי פיספת</b><span class="cc-count">${discover.length}</span>
        <span class="cc-more">${icon("chevL", { size: 15 })}</span>
      </div>
      <div class="cc-panel-body">${discover
        .map(
          (d) => `
        <div class="cc-row">
          ${avatarHtml(formatGroupName(d.name), d.hue, 30)}
          <div class="grow"><div class="cc-row-t">${escHtml(formatGroupName(d.name))}</div><div class="cc-row-s">${escHtml(d.why)}</div></div>
          <button class="btn btn-soft btn-sm" data-add-chat="${escHtml(d.name)}" type="button">${icon("plus", { size: 14 })}הוסף</button>
        </div>`,
        )
        .join("")}</div>
    </div>`
        : ""
    }
    <div class="cc-ask surface" data-go="ama">
      <span class="cc-ask-ic">${icon("sparkle", { size: 18 })}</span>
      <div class="grow"><b>שאל את הצ׳אטים שלך</b><small>״מה הכי דחוף היום?״</small></div>
      ${icon("chevL", { size: 16 })}
    </div>`;
}

/** True when the viewport is wide enough for the desktop digest board (v2). */
function isBoardLayout() {
  return window.matchMedia?.("(min-width: 780px)").matches ?? true;
}

/** The v2 board header: kicker, greeting, an inline date + remaining-count
 *  subline, and the personalization note pill. */
function buildDigestHead(now, left) {
  let dateStr = "";
  try {
    const wd = now.toLocaleDateString("he-IL", { weekday: "long" });
    dateStr = `<span class="dg-date">${escHtml(wd)} · <span class="mono" dir="ltr">${now.getDate()}.${now.getMonth() + 1}</span></span>`;
  } catch {
    /* leave the date blank if Intl is unavailable */
  }
  const countBit =
    left > 0
      ? `<span class="dg-bull">·</span><span>${left} ${left === 1 ? "כרטיס" : "כרטיסים"} להתעדכן · קריאה של דקה</span>`
      : "";
  return `
    <div class="dg-head">
      <div class="kicker" style="margin-bottom:5px">הסיכום היומי</div>
      <div class="dg-greet">${escHtml(greeting(now.getHours()))}</div>
      <div class="dg-subline">${dateStr}${countBit}</div>
      <div class="dg-note">${icon("sparkle", { size: 13 })}<span>הצעות חכמות שנבנות מהשיחות — ומתחדדות לפי הבחירות שלך</span></div>
    </div>`;
}

/** One wide digest-board row — a suggestion (edit-first + act buttons) or a
 *  read-only info card. Acted on in place via onTodayAct (shared with the stack). */
function buildDigestCard(card) {
  if (isSuggestion(card)) {
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
    return `
      <div class="dg-card surface s-suggest" data-card-id="${card.id}">
        <div class="dgc-top">
          <span class="sg-spark">${icon(cfg.icon, { size: 18 })}</span>
          <div class="dgc-head">
            <div class="kicker sg-kicker">${escHtml(cfg.kicker)} · מותאם אישית</div>
            <h3 class="dgc-title">${escHtml(cfg.title(formatGroupName(card.chat)))}</h3>
          </div>
          <span class="sg-tag">${icon("sparkle", { size: 11 })}טיוטה</span>
        </div>
        ${editor}
        <div class="dgc-reason">${icon("bolt", { size: 15 })}<span>${escHtml(card.reason)}</span></div>
        <div class="dgc-foot">
          ${buildSrcChip(card)}
          <div class="dgc-actions">
            <button class="btn btn-quiet btn-sm" type="button" data-act="discard" data-id="${card.id}">${icon("x", { size: 15 })}התעלם</button>
            <button class="btn btn-quiet btn-sm" type="button" data-act="snooze" data-id="${card.id}">${icon("moon", { size: 15 })}נודניק</button>
            <button class="btn btn-primary btn-sm" type="button" data-act="commit" data-id="${card.id}">${icon(cfg.commitIcon, { size: 15 })}${escHtml(cfg.commitLabel)}</button>
          </div>
        </div>
      </div>`;
  }
  const isHi = card.variant === "highlights";
  const title = isHi ? "עיקרי היום בכל הצ׳אטים" : formatGroupName(card.chat);
  const kicker = isHi ? "מבט על היום" : "סיכום צ׳אט";
  return `
    <div class="dg-card surface" data-card-id="${card.id}">
      <div class="dgc-top">
        <span class="sg-spark">${icon(isHi ? "sparkle" : "message", { size: 18 })}</span>
        <div class="dgc-head">
          <div class="kicker">${escHtml(kicker)}</div>
          <h3 class="dgc-title">${escHtml(title)}</h3>
        </div>
        <span class="badge accent">מידע</span>
      </div>
      <div class="dgc-body">${renderMarkdown(card.body)}</div>
      <div class="dgc-foot">${buildSrcChip(card)}</div>
    </div>`;
}

/** The desktop digest board (v2): head + a flat column of wide cards (or the
 *  done / empty state), plus the flash slot. */
function buildDigestBoard(total, hasSuggestionsLeft) {
  let body;
  if (total === 0) {
    body = todayState.acted > 0 ? buildDoneState(todayState.tally) : buildEmptyToday(todayState.engineOn);
  } else if (!hasSuggestionsLeft && todayState.acted > 0) {
    body = buildDoneState(todayState.tally);
  } else {
    body = `<div class="dg-grid">${todayState.deck.map(buildDigestCard).join("")}</div>`;
  }
  return `
    <div class="dg-board">
      ${buildDigestHead(new Date(), total)}
      ${body}
      <div class="dg-flash" id="today-flash"></div>
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
      <div class="body body--scroll">${renderMarkdown(card.body)}</div>
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
    return `<span class="src">${icon("source", { size: 13 })}<span>${label}</span></span>`;
  }
  return `<button type="button" class="src" data-src-jump="1" data-chat="${escHtml(card.chat)}" data-id="${card.sourceMessageId}">${icon("source", { size: 13 })}<span>${label}</span></button>`;
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
  document.getElementById("today-empty-cta")?.addEventListener("click", () => navigate(todayState.engineOn ? "sources" : "settings"));
  document.getElementById("today-ask-tile")?.addEventListener("click", () => navigate("ama"));

  // Command-center side rail: every panel/row links to its full screen.
  for (const el of paneMain.querySelectorAll("[data-go]")) {
    el.addEventListener("click", () => navigate(el.dataset.go));
  }

  // "שיחות שאולי פיספת" → one-tap add to scope, then drop the row + flash.
  for (const btn of paneMain.querySelectorAll("[data-add-chat]")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const group = btn.dataset.addChat;
      btn.disabled = true;
      await putScopes([{ group, included: true }]).catch(() => {});
      if (todayState.side?.discover) {
        todayState.side.discover = todayState.side.discover.filter((d) => d.name !== group);
      }
      cachedGroups = []; // force the Updates list to re-fetch with the new chat
      paintToday();
      showTodayFlash("נוסף לצ׳אטים המוזנים ✓");
    });
  }

  // Desktop digest board: act buttons (commit/snooze/discard), per-card draft
  // preservation, and source-chip jumps. Shares onTodayAct with the stack.
  const board = document.querySelector(".dg-board");
  if (board) {
    for (const card of board.querySelectorAll(".dg-card[data-card-id]")) {
      const id = Number(card.dataset.cardId);
      card.querySelector(".sg-draft__input")?.addEventListener("input", (e) => {
        const c = todayState.deck.find((x) => x.id === id);
        if (c && isSuggestion(c)) c.draft = e.target.value;
      });
    }
    for (const btn of board.querySelectorAll("[data-act]")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onTodayAct(btn.dataset.act, Number(btn.dataset.id));
      });
    }
    for (const chip of board.querySelectorAll("[data-src-jump]")) {
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const cid = Number(chip.dataset.id);
        if (chip.dataset.chat && Number.isFinite(cid)) navigate("thread", { chat: chip.dataset.chat, aroundId: cid });
      });
    }
    return;
  }

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
    const input =
      document.querySelector(`[data-card-id="${id}"] .sg-draft__input`) ||
      document.querySelector(".today .sg-draft__input");
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
    return `<span class="srcchip">${icon("source", { size: 13 })}<span>${text}</span></span>`;
  }
  return `<button type="button" class="srcchip" data-src-jump="1" data-chat="${escHtml(chat)}" data-id="${id}">${icon("source", { size: 13 })}<span>${text}</span></button>`;
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
  setView("people");
  setAppbar("people");
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
  paneMain.innerHTML = `
    <div class="people">
      ${buildEntityNav("people-back")}
      <div class="entity-head">
        <div class="entity-head__title">${icon("users", { size: 18 })} אנשים</div>
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
        <div class="ppl-row__meta"><span class="muted">${escHtml(last)}</span>${open}</div>
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
      <div class="ppl-next__kicker">הצעד הבא</div>
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
// Two separate screens (matching the design). Meetings: a day-grouped agenda
// timeline with a month-calendar + .ics-export aside. To-dos: a standalone
// checklist with a progress bar. Local-only — no Google-Calendar connect banner
// (that's the S8 gated work). Either endpoint may be absent; any failure renders
// an empty state, never crashes.

const agendaState = { meetings: [], todos: [], monthOffset: 0 };
const DOW_HE = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

// ── Meetings screen ─────────────────────────────────────────

async function renderMeetings() {
  teardownStream();
  setView("meetings");
  setAppbar("meetings");
  paneMain.innerHTML = `<div class="mt-view"><p class="thread-loading">טוען פגישות…</p></div>`;
  let meetings = [];
  if (!DEMO) meetings = await getMeetings().catch(() => []);
  agendaState.meetings = Array.isArray(meetings) ? meetings : [];
  agendaState.monthOffset = 0;
  setNavCount("meetings", agendaState.meetings.length);
  paintMeetings();
}

function paintMeetings() {
  const total = agendaState.meetings.length;
  paneMain.innerHTML = `
    <div class="mt-view">
      ${buildEntityNav("meetings-back")}
      <div class="split mt-split">
        <section>
          <h2 class="sec">${icon("calendar", { size: 15 })} סדר היום · <span class="mono" dir="ltr">${total}</span> פגישות שנאספו</h2>
          ${buildAgendaTimeline()}
        </section>
        <aside class="mt-aside">
          <div class="surface gcal">${buildCalendar()}</div>
          <div class="surface gcal-export">
            <span class="gcal-ic">${icon("calendar", { size: 20 })}</span>
            <div class="grow">
              <b>ייצוא ליומן</b>
              <p>הורד קובץ <span class="mono" dir="ltr">.ics</span> — נפתח בכל יומן, בלי לחבר חשבון. הכול נשאר על המכשיר.</p>
            </div>
            <a class="btn btn-soft btn-sm" href="/api/meetings.ics" download="catchapp.ics"
               title="ייצוא הפגישות לקובץ יומן מקומי — שום דבר לא יוצא מהמכשיר">${icon("download", { size: 15 })}הורד</a>
          </div>
        </aside>
      </div>
    </div>`;
  wireMeetings();
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
      if (c == null) return `<div class="cal-cell empty"></div>`;
      const evt = c.hasEvent ? `<span class="cal-evt"><i></i></span>` : "";
      return `<div class="cal-cell${c.isToday ? " today" : ""}"><span class="cal-n mono" dir="ltr">${c.day}</span>${evt}</div>`;
    })
    .join("");
  return `
    <div class="cal">
      <div class="cal-head">
        <b>${escHtml(monthLabel)}</b>
        <div class="cal-nav">
          <button class="iconbtn sm" data-cal-nav="prev" type="button" aria-label="חודש קודם">${icon("chevR", { size: 16 })}</button>
          <button class="iconbtn sm" data-cal-nav="next" type="button" aria-label="חודש הבא">${icon("chevL", { size: 16 })}</button>
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
    return buildEntityEmpty("calendar", "אין פגישות", "פגישות שיזוהו בשיחות יופיעו כאן, מקובצות לפי יום.");
  }
  return `
    <div class="agenda">
      ${groups
        .map(
          (g) => `
        <div class="day-group">
          <div class="day-head">
            <span class="pill">${escHtml(agendaDayLabel(g))}</span>
            <span><span class="mono" dir="ltr">${g.items.length}</span> פגישות</span>
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
  const who = m.owner ? `<p>${escHtml(formatGroupName(m.owner))}</p>` : "";
  const chip = buildSrcJump({ chat: m.chat, sourceMessageId: m.sourceMessageId });
  return `
    <div class="tl-item">
      <div class="tl-time mono" dir="ltr">${escHtml(time) || "—"}</div>
      <div class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></div>
      <div class="tl-card surface">
        <h4>${escHtml(m.title)}</h4>
        ${who}
        <div class="meta">${chip}</div>
      </div>
    </div>`;
}

function wireMeetings() {
  document.getElementById("meetings-back")?.addEventListener("click", () => history.back());
  const root = paneMain.querySelector(".mt-view");
  if (!root) return;
  for (const btn of root.querySelectorAll("[data-cal-nav]")) {
    btn.addEventListener("click", () => {
      agendaState.monthOffset += btn.dataset.calNav === "next" ? 1 : -1;
      paintMeetings();
    });
  }
  wireSrcJumps(root);
}

// ── To-dos screen ───────────────────────────────────────────

async function renderTodos() {
  teardownStream();
  setView("todos");
  setAppbar("todos");
  paneMain.innerHTML = `
    <div class="todos-wrap">
      ${buildEntityNav("todos-back")}
      <h2 class="sec">${icon("checks", { size: 15 })} משימות שחולצו מהשיחות</h2>
      <div id="todos-body"><p class="thread-loading">טוען משימות…</p></div>
    </div>`;
  document.getElementById("todos-back")?.addEventListener("click", () => history.back());
  let todos = [];
  if (!DEMO) todos = await getTodos().catch(() => []);
  agendaState.todos = Array.isArray(todos) ? todos : [];
  setNavCount("todos", agendaState.todos.filter((t) => !t.done).length);
  paintTodosBody();
}

/** (Re)render the to-dos list region in place — first paint + after a toggle. */
function paintTodosBody() {
  const body = document.getElementById("todos-body");
  if (!body) return;
  const todos = agendaState.todos;
  body.innerHTML =
    todos.length === 0
      ? buildEntityEmpty("checks", "אין משימות פתוחות", "משימות שיחולצו מהשיחות יופיעו כאן, עם מקור ותאריך יעד.")
      : buildChecklist(todos);
  for (const btn of body.querySelectorAll("[data-todo-toggle]")) {
    btn.addEventListener("click", () => onTodoToggle(Number(btn.dataset.todoToggle)));
  }
  wireSrcJumps(body);
}

function buildChecklist(todos) {
  const p = todoProgress(todos);
  const rows = todos.map(buildTodoRow).join("");
  return `
    <div class="surface checklist">
      <div class="cl-head">
        <b><span class="mono" dir="ltr">${p.done}</span> מתוך <span class="mono" dir="ltr">${p.total}</span> הושלמו</b>
        <span class="badge accent"><span class="mono" dir="ltr">${p.open}</span> פתוחות</span>
      </div>
      <div class="cl-progress" role="progressbar" aria-valuenow="${p.pct}" aria-valuemin="0" aria-valuemax="100">
        <b style="width:${p.pct}%"></b>
      </div>
      <div class="cl-rows">${rows}</div>
    </div>`;
}

function buildTodoRow(t) {
  const chip = buildSrcJump({ chat: t.chat, sourceMessageId: t.sourceMessageId });
  const due = dueLabel(t.dueAt);
  const dueBadge = due ? `<span class="badge">${escHtml(due)}</span>` : "";
  return `
    <div class="cl-row${t.done ? " is-done" : ""}" data-todo="${t.id}">
      <button class="cbox${t.done ? " on" : ""}" type="button" data-todo-toggle="${t.id}"
        role="checkbox" aria-checked="${t.done}" aria-label="סימון כהושלם">${icon("check", { size: 14 })}</button>
      <div class="grow">
        <div class="cl-title">${escHtml(t.title)}</div>
        <div class="meta">${chip}${dueBadge}</div>
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

/** Optimistic checkbox toggle; reverts + repaints on a failed PATCH. */
async function onTodoToggle(id) {
  const t = agendaState.todos.find((x) => x.id === id);
  if (!t) return;
  const next = !t.done;
  t.done = next;
  setNavCount("todos", agendaState.todos.filter((x) => !x.done).length);
  paintTodosBody();
  if (DEMO) return;
  try {
    await setTodoDone(id, next);
  } catch {
    t.done = !next; // revert
    setNavCount("todos", agendaState.todos.filter((x) => !x.done).length);
    paintTodosBody();
  }
}

/** Shared empty-state card for People, Meetings, and To-dos screens. */
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
  if (hash === "#meetings" || hash === "#agenda") {
    history.replaceState({ view: "meetings" }, "", "#meetings");
    return { view: "meetings" };
  }
  if (hash === "#todos") {
    history.replaceState({ view: "todos" }, "", hash);
    return { view: "todos" };
  }
  if (hash === "#catchup") {
    history.replaceState({ view: "catchup" }, "", hash);
    return { view: "catchup" };
  }
  // Default landing surface is the daily summary (היום), per the prototype.
  history.replaceState({ view: "today" }, "", "#today");
  return { view: "today" };
}

// ── T2 auth gate (multi-tenant mode) ─────────────────────────────────────────
// Single-user local mode: /api/* is open → the gate is a no-op. Multi-tenant mode
// (MULTI_TENANT=true server-side): /api/* returns 401 without a session → show the
// login/register pane. /verify + /reset are the emailed-link landing pages.

async function authGate() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (location.pathname === "/verify" && token) {
    await renderVerifyResult(token);
    return false;
  }
  if (location.pathname === "/reset" && token) {
    renderResetForm(token);
    return false;
  }
  // Review the guided onboarding any time (even when already linked).
  if (params.get("onboarding") === "preview") {
    renderOnboardingFlow({ preview: true });
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
  if (probe && probe.status !== 401) {
    // Single-user: run the guided first-run flow once — only when a WhatsApp
    // link is actually pending (the onboarding registry is mounted AND not yet
    // connected) and the user hasn't already completed/skipped it.
    let onboarded = false;
    try {
      onboarded = localStorage.getItem("catchapp-onboarded") === "1";
    } catch {
      /* ignore */
    }
    if (!onboarded) {
      const ob = await fetch("/api/onboarding/status").catch(() => null);
      if (ob?.ok) {
        const { status } = await ob.json();
        if (status && status !== "connected") {
          renderOnboardingFlow({ initialStatus: status });
          return false;
        }
      }
    }
    return true;
  }
  renderAuthPane("login");
  return false;
}

/* ── §1 Onboarding — guided 5-step first-run flow ────────────
 *
 * welcome → connect (QR) → scanning → choose chats → digest time → ready.
 * Seeds the suggestion engine's scopes so the very first digest is already
 * focused. Reuses the real /api/onboarding/qr + /progress SSE streams and
 * getGroups/putScopes/putPreferences. Runs on first-run (single-user OR the
 * multi-tenant gate) and is reachable any time via ?onboarding=preview.
 */
const OB_STEPS = ["ברוכים הבאים", "חיבור", "סריקה", "צ׳אטים", "סיום"];
const OB_WIDTHS = { 0: 560, 1: 660, 2: 520, 3: 680, 4: 540 };
const OB_TIMES = ["07:00", "08:00", "09:00", "20:00"];
const obState = {
  step: 0,
  preview: false,
  initialStatus: null,
  chats: [],
  loadedChats: false,
  digestTime: "08:00",
  morningNotif: true,
  timers: [],
};

/** Entry point. The multi-tenant gate passes the link status; ?onboarding=preview
 *  passes {preview:true} so the flow can be reviewed even when already linked. */
function renderOnboarding(initialStatus) {
  renderOnboardingFlow({ initialStatus });
}

function renderOnboardingFlow({ initialStatus = null, preview = false } = {}) {
  obState.step = 0;
  obState.preview = preview;
  obState.initialStatus = initialStatus;
  obState.chats = [];
  obState.loadedChats = false;
  obState.digestTime = "08:00";
  obState.morningNotif = true;
  obTeardown();
  obPaint();
}

/** Stop the active SSE + any scan timers (called on every step change). */
function obTeardown() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  for (const t of obState.timers) {
    clearInterval(t);
    clearTimeout(t);
  }
  obState.timers = [];
}

function obGo(step) {
  obTeardown();
  obState.step = step;
  obPaint();
}

function obProgressHtml(step) {
  return `<div class="ob-prog">${OB_STEPS.map((l, k) => {
    const cls = k < step ? " done" : k === step ? " on" : "";
    const dot = k < step ? icon("check", { size: 13 }) : String(k + 1);
    const bar = k < OB_STEPS.length - 1 ? '<span class="ob-prog-bar"></span>' : "";
    return `<div class="ob-prog-step${cls}"><span class="ob-prog-dot">${dot}</span><span class="ob-prog-lbl">${escHtml(l)}</span></div>${bar}`;
  }).join("")}</div>`;
}

function obPaint() {
  const step = obState.step;
  const back =
    step > 0 && step < 4
      ? `<button class="ob-back" id="ob-back" type="button">${icon("chevR", { size: 16 })}חזרה</button>`
      : "";
  const card =
    step === 0
      ? obWelcomeHtml()
      : step === 1
        ? obConnectHtml()
        : step === 2
          ? obScanHtml()
          : step === 3
            ? obChatsHtml()
            : obReadyHtml();
  document.getElementById("layout").innerHTML = `
    <div class="ob ob-flow ob-takeover">
      <div style="width:min(${OB_WIDTHS[step]}px,100%)">
        ${obProgressHtml(step >= 4 ? 4 : step)}
        ${back}
        ${card}
      </div>
    </div>`;
  document.getElementById("ob-back")?.addEventListener("click", () => obGo(step - 1));
  obWire(step);
}

function obWelcomeHtml() {
  return `
    <div class="ob-card surface shadow-sm ob-center">
      <div style="display:grid;place-items:center;margin-bottom:22px">${brandGlyph(84, { d3: true })}</div>
      <h2 class="ob-h">CatchApp</h2>
      <p class="ob-p">סיכום יומי, מעקב אנשים, פגישות ומשימות — הכול מתוך הצ׳אטים שלך.<b> והכול נשאר אצלך בלבד.</b></p>
      <div class="ob-bullets">
        <div><span class="ob-bi">${icon("sparkle", { size: 16 })}</span>סיכום יומי שמתמצת את היום בדקה</div>
        <div><span class="ob-bi">${icon("filter", { size: 16 })}</span>אתם בוחרים אילו צ׳אטים נכנסים</div>
        <div><span class="ob-bi">${icon("lock", { size: 16 })}</span>הכול מעובד ונשמר על המכשיר</div>
      </div>
      <button class="btn btn-primary btn-lg btn-block" id="ob-welcome-cta" type="button">${icon("phone")}התחברות עם וואטסאפ</button>
      <div class="trust-line">${icon("lock")}שום דבר לא עולה לענן בלי אישורך</div>
    </div>`;
}

/** A deterministic QR-ish placeholder grid (13×13) shown until the real
 *  server-rendered QR data-URL arrives over SSE. */
function obQrCellsHtml() {
  let cells = "";
  for (let i = 0; i < 169; i++) {
    const on = (Math.imul(i + 1, 2654435761) >>> 27) & 1;
    cells += `<i class="${on ? "" : "off"}"></i>`;
  }
  return cells;
}

function obConnectHtml() {
  return `
    <div class="ob-card surface shadow-sm" style="text-align:start;padding:34px">
      <div class="ob-qr-grid">
        <div>
          <h2 class="ob-h" style="font-size:23px;text-align:start">חברו את הוואטסאפ שלכם</h2>
          <p class="ob-p" style="font-size:14.5px;text-align:start;margin:0 0 18px">סריקה חד-פעמית. החיבור נשאר על המכשיר הזה.</p>
          <ol class="steps">
            <li><span class="sn">1</span><div>פתחו וואטסאפ בטלפון</div></li>
            <li><span class="sn">2</span><div>היכנסו ל<b>הגדרות ← מכשירים מקושרים</b></div></li>
            <li><span class="sn">3</span><div>הקישו <b>קישור מכשיר</b> וכוונו את המצלמה לקוד</div></li>
          </ol>
          <div class="trust-line" style="margin-top:20px">${icon("lock")}חיבור מוצפן מקצה לקצה · אנחנו לא רואים את ההודעות</div>
        </div>
        <div style="text-align:center">
          <div class="qr" id="ob-qr">${obQrCellsHtml()}</div>
          <p class="ob-p" id="ob-qr-hint" style="font-size:12px;margin:10px 0 0">${obState.preview ? "תצוגה מקדימה — קוד לדוגמה" : "מכינים קוד…"}</p>
        </div>
      </div>
      <div class="divide" style="margin:24px 0 18px"></div>
      <button class="btn btn-primary btn-block" id="ob-connect-cta" type="button">${icon("check")}סרקתי — המשך</button>
    </div>`;
}

function obScanItems() {
  return [
    { t: "מתחבר לוואטסאפ", icon: "phone" },
    { t: "קורא את 3 הימים האחרונים", icon: "message" },
    { t: "מזהה אנשים, פגישות ומשימות", icon: "users" },
    { t: "מחלץ משימות ופגישות", icon: "checks" },
    { t: "בונה את הסיכום הראשון", icon: "sun" },
  ];
}

function obScanHtml() {
  const floats = [
    ["12%", "0s", "2.6s", 150, 26],
    ["26%", ".5s", "3.1s", 20, 20],
    ["44%", "1.1s", "2.4s", 230, 30],
    ["62%", ".3s", "3.4s", 60, 22],
    ["78%", "1.4s", "2.8s", 330, 26],
    ["88%", ".8s", "3.2s", 200, 18],
  ]
    .map(
      ([l, d, dur, hue, s]) =>
        `<span class="ob-float" style="inset-inline-start:${l};animation-delay:${d};animation-duration:${dur};--fh:${hue};width:${s}px;height:${s}px">${icon("message", { size: Math.round(s * 0.5) })}</span>`,
    )
    .join("");
  const list = obScanItems()
    .map(
      (it, k) =>
        `<div class="ob-scan-item" data-k="${k}"><span class="ob-scan-ic">${icon(it.icon, { size: 15 })}</span><span>${escHtml(it.t)}</span></div>`,
    )
    .join("");
  return `
    <div class="ob-card surface shadow-sm ob-center ob-scan">
      <div class="ob-scan-stage">
        <div class="ob-floats">${floats}</div>
        <div class="ob-orbit"><i></i><i></i><i></i></div>
        <div class="ob-scan-ring" id="ob-ring" style="--p:0">
          <div class="ob-scan-inner">${brandGlyph(46)}<span class="ob-scan-pct mono" id="ob-pct" dir="ltr">0%</span></div>
        </div>
        <span class="ob-spark s1">${icon("sparkle", { size: 16 })}</span>
        <span class="ob-spark s2">${icon("sparkle", { size: 12 })}</span>
        <span class="ob-spark s3">${icon("sparkle", { size: 14 })}</span>
      </div>
      <h2 class="ob-h" style="font-size:22px">מכינים בשבילך הכול…</h2>
      <p class="ob-quip" id="ob-quip">ממיין הודעות חשובות מרעש…</p>
      <div class="ob-scan-list">${list}</div>
    </div>`;
}

function obChatsHtml() {
  const on = obState.chats.filter((c) => c.included).length;
  const body = !obState.loadedChats
    ? `<p class="ob-p" style="text-align:center">טוען את הצ׳אטים שלך…</p>`
    : obState.chats.length === 0
      ? `<p class="ob-p" style="text-align:center">לא נמצאו צ׳אטים עדיין — אפשר להמשיך ולבחור אחר כך.</p>`
      : `<div class="ob-cat"><div class="ob-cat-head"><b>הצ׳אטים הפעילים שלך</b><button class="src-bulk" id="ob-bulk" type="button">${on === obState.chats.length ? "כבה הכול" : "הפעל הכול"}</button></div>
          <div class="ob-chat-grid">${obState.chats
            .map(
              (c, i) =>
                `<button class="ob-chat-pill${c.included ? " on" : ""}" data-i="${i}" type="button">${avatarHtml(formatGroupName(c.name), c.hue, 30)}<span class="ob-chat-name">${escHtml(formatGroupName(c.name))}</span><span class="ob-chat-check">${c.included ? icon("check", { size: 14 }) : icon("plus", { size: 14 })}</span></button>`,
            )
            .join("")}</div></div>`;
  return `
    <div class="ob-card surface shadow-sm ob-chats" style="text-align:start">
      <div class="ob-chats-head">
        <div>
          <h2 class="ob-h" style="font-size:22px;text-align:start;margin:0 0 4px">אילו צ׳אטים שווה לעקוב אחריהם?</h2>
          <p class="ob-p" style="font-size:14px;text-align:start;margin:0">בחרו את הצ׳אטים שיוזנו ל-CatchApp. תמיד אפשר לשנות אחר כך.</p>
        </div>
        <span class="badge accent ob-count" id="ob-count">${on} נבחרו</span>
      </div>
      <div class="ob-chip-hint">${icon("sparkle", { size: 13 })}רק המסומנים יוזנו לסיכום, לעדכונים ולהצעות</div>
      <div class="ob-chats-scroll">${body}</div>
      <div class="ob-foot">
        <button class="btn btn-primary btn-block" id="ob-chats-cta" type="button"${on === 0 ? " disabled" : ""}>המשך עם ${on} צ׳אטים</button>
        <button class="ob-skip" id="ob-chats-skip" type="button">אבחר אחר כך</button>
      </div>
    </div>`;
}

function obReadyHtml() {
  const times = OB_TIMES.map(
    (t) =>
      `<button class="chip ob-time${t === obState.digestTime ? " on" : ""}" data-t="${t}" type="button"><span class="mono" dir="ltr">${t}</span></button>`,
  ).join("");
  return `
    <div class="ob-card surface shadow-sm ob-center">
      <div class="done-badge" style="width:60px;height:60px;margin-bottom:16px">${icon("check", { size: 30 })}</div>
      <h2 class="ob-h">הכול מוכן ✦</h2>
      <p class="ob-p">הסיכום הראשון שלך מחכה. מתי תרצו לקבל אותו כל בוקר?</p>
      <div class="ob-times">${times}</div>
      <button class="ob-notif" id="ob-notif" type="button" aria-pressed="${obState.morningNotif}">
        <span><b>התראת בוקר עדינה</b><small>נזכיר לכם כשהסיכום מוכן</small></span>
        <span class="switch${obState.morningNotif ? " on" : ""}"></span>
      </button>
      <button class="btn btn-primary btn-lg btn-block" id="ob-finish" type="button">${icon("sun")}כניסה לסיכום</button>
      <div class="trust-line">${icon("lock")}הנתונים נשארים על המכשיר · בשליטתכם המלאה</div>
    </div>`;
}

/** Per-step event wiring. */
function obWire(step) {
  if (step === 0) {
    document.getElementById("ob-welcome-cta")?.addEventListener("click", () => obGo(1));
    return;
  }
  if (step === 1) {
    document.getElementById("ob-connect-cta")?.addEventListener("click", () => obGo(2));
    if (obState.preview) return; // placeholder QR only — no live link in preview
    const es = new EventSource("/api/onboarding/qr");
    activeEventSource = es;
    es.addEventListener("qr", (e) => {
      const { dataUrl } = JSON.parse(e.data);
      const box = document.getElementById("ob-qr");
      const hint = document.getElementById("ob-qr-hint");
      if (box && dataUrl) box.outerHTML = `<img class="qr-img" id="ob-qr" src="${dataUrl}" alt="קוד QR לקישור וואטסאפ" width="208" height="208" />`;
      if (hint) hint.textContent = "סרקו עם הטלפון";
    });
    es.addEventListener("connected", () => obGo(2));
    es.onerror = () => {}; // graceful: the manual "סרקתי — המשך" still advances
    return;
  }
  if (step === 2) {
    obRunScan();
    return;
  }
  if (step === 3) {
    if (!obState.loadedChats) {
      obLoadChats().then(() => {
        if (obState.step === 3) obPaint();
      });
      return;
    }
    obWireChats();
    return;
  }
  if (step === 4) {
    for (const btn of document.querySelectorAll(".ob-time")) {
      btn.addEventListener("click", () => {
        obState.digestTime = btn.dataset.t;
        obPaint();
      });
    }
    document.getElementById("ob-notif")?.addEventListener("click", () => {
      obState.morningNotif = !obState.morningNotif;
      obPaint();
    });
    document.getElementById("ob-finish")?.addEventListener("click", obFinish);
  }
}

/** Drive the scan ring + checklist with a timed simulation, overridden by real
 *  /api/onboarding/progress events when a live sync is streaming. Advances to
 *  the chat picker on completion. */
function obRunScan() {
  let pct = 0;
  const quips = [
    "ממיין הודעות חשובות מרעש…",
    "מאתר מה מחכה לתשובה…",
    "מחבר נקודות בין שיחות…",
    "כמעט שם — מסדר את הבוקר שלך ✦",
  ];
  let q = 0;
  const items = obScanItems().length;
  const apply = (p) => {
    pct = Math.max(0, Math.min(100, p));
    const ring = document.getElementById("ob-ring");
    const pctEl = document.getElementById("ob-pct");
    if (ring) ring.style.setProperty("--p", String(pct));
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    const active = Math.min(items - 1, Math.floor(pct / (100 / items)));
    for (const el of document.querySelectorAll(".ob-scan-item")) {
      const k = Number(el.dataset.k);
      const ok = pct >= (k + 1) * (100 / items);
      el.classList.toggle("ok", ok);
      el.classList.toggle("active", !ok && k === active);
      let dots = el.querySelector(".ob-dots");
      if (!ok && k === active && !dots) {
        dots = document.createElement("span");
        dots.className = "ob-dots";
        dots.innerHTML = "<i></i><i></i><i></i>";
        el.appendChild(dots);
      } else if ((ok || k !== active) && dots) {
        dots.remove();
      }
      if (ok && !el.querySelector(".ob-scan-tick")) {
        const tick = document.createElement("span");
        tick.className = "ob-scan-tick";
        tick.innerHTML = icon("check", { size: 13 });
        el.appendChild(tick);
      }
    }
  };
  const finish = () => {
    obTeardown();
    if (obState.step === 2) obGo(3);
  };
  // Live link: let the REAL history-sync progress drive completion. The simulated
  // fill only animates up to a cap, then waits for the real `done` — so we never
  // advance to the chat picker before the user's chats have actually synced. A safety
  // timeout still advances if no progress/`done` ever arrives (already-synced account,
  // or a stream error). Preview keeps filling to 100 on its own.
  const live = !obState.preview;
  const simCap = live ? 90 : 100;
  const tick = setInterval(() => {
    if (pct < simCap) apply(Math.min(pct + 1, simCap));
    if (pct >= 100) {
      clearInterval(tick);
      setTimeout(finish, 600);
    }
  }, 55);
  const quipTimer = setInterval(() => {
    q = (q + 1) % quips.length;
    const el = document.getElementById("ob-quip");
    if (el) el.textContent = quips[q];
  }, 1700);
  obState.timers.push(tick, quipTimer);
  if (live) {
    const es = new EventSource("/api/onboarding/progress");
    activeEventSource = es;
    es.addEventListener("progress", (e) => {
      const { progress } = JSON.parse(e.data);
      if (typeof progress === "number") apply(Math.max(pct, progress));
    });
    es.addEventListener("done", () => {
      apply(100);
      finish();
    });
    es.onerror = () => {}; // the safety timeout below still advances the flow
    // Safety net: never stall on the scan step if no progress/`done` arrives.
    obState.timers.push(
      setTimeout(() => {
        apply(100);
        finish();
      }, 45000),
    );
  }
}

/** Load the user's most-active chats into the picker (default all included). */
async function obLoadChats() {
  let groups = [];
  try {
    groups = await getGroups();
  } catch {
    groups = [];
  }
  obState.chats = groups
    .slice(0, 40)
    .map((g) => ({ name: g.name, hue: hueFromName(g.name), included: true }));
  obState.loadedChats = true;
}

function obWireChats() {
  const recount = () => {
    const on = obState.chats.filter((c) => c.included).length;
    const cnt = document.getElementById("ob-count");
    if (cnt) cnt.textContent = `${on} נבחרו`;
    const cta = document.getElementById("ob-chats-cta");
    if (cta) {
      cta.textContent = `המשך עם ${on} צ׳אטים`;
      cta.disabled = on === 0;
    }
    const bulk = document.getElementById("ob-bulk");
    if (bulk) bulk.textContent = on === obState.chats.length ? "כבה הכול" : "הפעל הכול";
  };
  for (const pill of document.querySelectorAll(".ob-chat-pill")) {
    pill.addEventListener("click", () => {
      const i = Number(pill.dataset.i);
      obState.chats[i].included = !obState.chats[i].included;
      pill.classList.toggle("on", obState.chats[i].included);
      pill.querySelector(".ob-chat-check").innerHTML = obState.chats[i].included
        ? icon("check", { size: 14 })
        : icon("plus", { size: 14 });
      recount();
    });
  }
  document.getElementById("ob-bulk")?.addEventListener("click", () => {
    const allOn = obState.chats.every((c) => c.included);
    for (const c of obState.chats) c.included = !allOn;
    obPaint();
  });
  document.getElementById("ob-chats-cta")?.addEventListener("click", () => obCommitChats(true));
  document.getElementById("ob-chats-skip")?.addEventListener("click", () => obCommitChats(false));
}

/** Persist the chat selection (seeding the engine's scopes) then advance. In
 *  preview mode we don't write — the flow is just being reviewed. */
async function obCommitChats(useSelection) {
  if (!obState.preview && obState.loadedChats && obState.chats.length) {
    const updates = obState.chats.map((c) => ({ group: c.name, included: useSelection ? c.included : false }));
    await putScopes(updates).catch(() => {});
  }
  obGo(4);
}

/** Save the digest preferences, mark onboarding done, and enter the app. */
async function obFinish() {
  if (!obState.preview) {
    await putPreferences({ digestTimes: obState.digestTime, morningNotification: obState.morningNotif }).catch(() => {});
    try {
      localStorage.setItem("catchapp-onboarded", "1");
    } catch {
      /* ignore storage failures */
    }
  }
  obTeardown();
  location.href = "/"; // drops ?onboarding=preview; boot loads the app
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

  if (route.view === "detail") {
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
  } else if (route.view === "meetings") {
    renderMeetings();
  } else if (route.view === "todos") {
    renderTodos();
  } else if (route.view === "catchup") {
    renderCatchup();
  } else {
    renderToday();
  }
}

boot();
