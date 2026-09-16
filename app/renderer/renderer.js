// AgentTerminal — renderer. No Node integration; everything PTY-related goes
// through the narrow contextBridge API exposed by preload.js.
//
// Session model (approved synthesis, 2026-08-15):
//   - Tabs are the primary unit. Each tab owns a .tab-field container inside
//     #pane-field; only the active tab's container is displayed.
//   - Inside a tab, the DOM is the split tree: a .tab-field holds one .pane or
//     one .split; a .split holds two children separated by a .divider.
//   - Hidden tabs keep their PTYs alive and are never resized while hidden
//     (fitPane skips hosts that measure ~0); they re-fit once on activation.
//   - Sessions are named by the opened folder, not by persona.

(function () {
  "use strict";

  const windowsBuildNumber =
    Number((agentTerminal.hostInfo?.osVersion || "").split(".")[2]) || 26100;

  const field = document.getElementById("pane-field");
  const tabStrip = document.getElementById("tab-strip");
  const workspaceTitle = document.getElementById("workspace-title");
  const workspaceId = document.getElementById("workspace-id");
  const workspaceMeta = document.getElementById("workspace-meta");
  const poolGroups = document.getElementById("pool-groups");
  document.getElementById("operator-mark").textContent = agentTerminal.hostInfo?.operatorInitials || "ME";

  /** paneId -> pane record */
  const panes = new Map();
  // records whose ptyCreate hasn't resolved yet still need to be findable
  const pending = [];
  /** ordered tab records: { uid, fieldEl, lastFocused } */
  const tabs = [];
  let activeTab = null;
  let focused = null;
  let layoutDragActive = false;
  let nextUid = 1;

  // Tier 1 — color as identity. The xterm background is transparent in every
  // theme so the pane's well (CSS) shows through the text; the palette carries
  // the theme's terminal colors plus the provider's cursor and selection.
  // Palettes live in themes.js beside their CSS token blocks in style.css.
  const THEME_KEY = "theme-v1";
  const OPACITY_KEY = "opacity-v1";
  let currentThemeId = NEXO_THEMES.DEFAULT_THEME;
  try { currentThemeId = localStorage.getItem(THEME_KEY) || currentThemeId; } catch {}
  if (!NEXO_THEMES.themes[currentThemeId]) currentThemeId = NEXO_THEMES.DEFAULT_THEME;

  function applyUiTheme(id) {
    if (!NEXO_THEMES.themes[id]) return;
    currentThemeId = id;
    if (id === NEXO_THEMES.DEFAULT_THEME) delete document.body.dataset.theme;
    else document.body.dataset.theme = id;
    for (const rec of panes.values()) {
      rec.term.options.theme = paneTermTheme(id, rec.runtimeHint);
      // A theme write clobbers a transparent (quiet) cursor; let the next
      // cursor tick decide again instead of leaving a ghost visible.
      rec.cursorQuiet = null;
    }
    try { localStorage.setItem(THEME_KEY, id); } catch {}
  }

  // Opacity moves only the body tint's alpha (0-100, user's explicit choice).
  // null = the theme's own default. The compositor never owns the wall by
  // default; going translucent is a deliberate, instantly reversible drag.
  function applyOpacity(pct) {
    if (pct == null) document.body.style.removeProperty("--base-alpha");
    else {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      document.body.style.setProperty("--base-alpha", String(clamped / 100));
    }
    try {
      if (pct == null) localStorage.removeItem(OPACITY_KEY);
      else localStorage.setItem(OPACITY_KEY, String(Math.round(pct)));
    } catch {}
  }

  function currentOpacityPct() {
    const alpha = Number(getComputedStyle(document.body).getPropertyValue("--base-alpha"));
    return Number.isFinite(alpha) ? Math.round(alpha * 100) : 88;
  }

  if (currentThemeId !== NEXO_THEMES.DEFAULT_THEME) document.body.dataset.theme = currentThemeId;
  try {
    const storedOpacity = Number(localStorage.getItem(OPACITY_KEY));
    if (Number.isFinite(storedOpacity) && storedOpacity >= 0 && storedOpacity <= 100) {
      document.body.style.setProperty("--base-alpha", String(storedOpacity / 100));
    }
  } catch {}

  // Turn-complete attention (see updateAttention at the foot of this file).
  const AGENT_QUIET_MS = 2500;   // agent pane silent this long = turn finished
  const TURN_MIN_MS = 2500;      // shorter bursts never raise attention
  const ATTENTION_PERIOD_MS = 2800; // must match the tab-attention keyframes
  const REPLY_ARM_MS = 10 * 60e3; // work starting long after your last submit
                                  // is not a reply to you

  const ICONS = {
    splitH: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><rect x="1" y="1.5" width="10" height="9"/><line x1="6" y1="1.5" x2="6" y2="10.5"/></svg>',
    splitV: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><rect x="1" y="1.5" width="10" height="9"/><line x1="1" y1="6" x2="11" y2="6"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>',
  };

  function cleanTitle(t) {
    if (!t) return "powershell";
    const base = t.split(/[\\/]/).pop().replace(/\.exe$/i, "");
    return base || t;
  }

  function basename(p) {
    if (!p) return "";
    return String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  }

  // Folder-name identity: session cwd (exact) beats a path seen in the shell
  // title beats the spawn cwd; the raw title is the last resort.
  function paneFolderName(rec) {
    return (
      basename(rec.session?.cwd) ||
      basename(rec.titlePath) ||
      basename(rec.spawnCwd) ||
      rec.title ||
      "shell"
    );
  }

  function panePath(rec) {
    return rec.session?.cwd || rec.titlePath || rec.spawnCwd || "";
  }

  function modelChip(model) {
    if (!model) return "";
    const m = String(model);
    if (/opus/i.test(m)) return "opus";
    if (/sonnet/i.test(m)) return "sonnet";
    if (/fable/i.test(m)) return "fable";
    if (/haiku/i.test(m)) return "haiku";
    const gpt = m.match(/gpt-?([\d.]+)/i);
    if (gpt) return `gpt-${gpt[1]}`;
    return m.length > 12 ? `${m.slice(0, 11)}…` : m;
  }

  function paneSource(rec) {
    return rec.session?.source || rec.runtimeHint || "shell";
  }

  // ------------------------------------------------------- GPU renderer ----
  // xterm's default DOM renderer builds one node per cell, so a full-screen
  // repaint costs a full-page layout — which is exactly what Codex does on
  // every frame (Claude mostly appends). The WebGL renderer uploads the grid
  // as a GPU texture instead. It must load after term.open(), and every
  // failure path here is silent: xterm falls straight back to the DOM
  // renderer, so a missing context or a driver reset degrades, never breaks.
  const QUERY = new URLSearchParams(location.search);
  const RENDERER_MODE = QUERY.get("renderer") || "webgl";
  // Render-probe knobs. customGlyphs draws box/block characters programmatically
  // instead of from the font; minimumContrastRatio lifts low-contrast ANSI
  // colors. Both are prime suspects when the GPU renderer paints text wrong,
  // so both stay switchable from the probe harness.
  const CUSTOM_GLYPHS = QUERY.get("glyphs") !== "off";
  const CONTRAST_RATIO = Number(QUERY.get("contrast")) || 3;
  // With a transparent xterm background the WebGL renderer has no real colour
  // to measure contrast against, so minimumContrastRatio stops lifting dim text
  // and low-contrast output sinks into the well. Painting the well colour into
  // the terminal itself restores it, at the cost of see-through glass behind
  // the text. This switch exists to compare the two honestly.
  // The terminal well carries the theme's own colour at 85%, NOT full
  // transparency. This is load-bearing, not decoration: with a fully
  // transparent background the GPU renderer has no colour to measure contrast
  // against, so minimumContrastRatio silently stops lifting dim text and
  // low-contrast output (Codex's `(v0.147.0)`, any 256-colour grey) sinks into
  // the well. Verified by capture — transparent renders it illegible, 85%
  // renders it as cleanly as fully opaque. The glass identity still comes from
  // the chrome, the rail, the strips and the window's acrylic.
  // themes.js keeps background "#00000000"; the alpha is applied here.
  // Fully opaque, by design decision: a half-transparent well read as neither
  // glass nor solid. Shipped code carries no author names (see the packaging
  // privacy allowlist in scripts/verify-package.mjs) — rationale for choices
  // like this one belongs in the ledger and the commit message, not here.
  const WELL_TINT_ALPHA = "";
  const OPAQUE_OVERRIDE = QUERY.get("opaque"); // probe knob: "0" | "1" | hex

  function paneTermTheme(id, hint) {
    const base = NEXO_THEMES.termTheme(id, hint);
    if (OPAQUE_OVERRIDE === "0") return base; // fully transparent, for comparison
    const well =
      getComputedStyle(document.body).getPropertyValue("--well").trim() || "#0c1013";
    const alpha = OPAQUE_OVERRIDE === "1" ? "" : OPAQUE_OVERRIDE || WELL_TINT_ALPHA;
    return { ...base, background: `${well}${alpha}` };
  }

  function attachWebglRenderer(rec) {
    if (RENDERER_MODE === "dom" || typeof WebglAddon === "undefined") return;
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => {
        // A driver reset must not leave the pane blank. Drop the addon and
        // force one repaint through the DOM renderer.
        try { addon.dispose(); } catch {}
        rec.webgl = null;
        try { rec.term.refresh(0, rec.term.rows - 1); } catch {}
      });
      rec.term.loadAddon(addon);
      rec.webgl = addon;
    } catch {
      rec.webgl = null;
    }
  }

  // ------------------------------------------------------------ panes ----
  function createPane(tab, cwd) {
    const ordinal = leavesIn(tab.fieldEl).length + 1;
    const el = document.createElement("section");
    el.className = "pane";
    el.innerHTML = `
      <div class="pane-head">
        <span class="id-tick"></span>
        <span class="pane-kicker">pane ${String(ordinal).padStart(2, "0")}</span>
        <span class="title">powershell</span>
        <span class="actions">
          <button data-act="split-h" title="Split right (Ctrl+Shift+D)">${ICONS.splitH}</button>
          <button data-act="split-v" title="Split down (Ctrl+Shift+E)">${ICONS.splitV}</button>
          <button data-act="close" title="Close pane (Ctrl+Shift+W)">${ICONS.close}</button>
        </span>
      </div>
      <div class="pane-term"></div>
      <button class="jump-bottom hidden" title="Go to latest message" aria-label="Go to latest message">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 2v7"/><path d="M2.8 6.2 6 9.4l3.2-3.2"/></svg>
        <span>Latest</span>
      </button>
      <div class="pane-status empty">
        <span class="tick"></span>
        <span class="model">shell</span>
        <span class="status-muted">instrumentation waiting</span>
      </div>`;

    const term = new Terminal({
      // Matches the user's Warp text settings: Cascadia Code, normal weight,
      // 13px, 1.2 line height, ligatures off (xterm has none by default).
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      // Glyphs are always painted fully opaque; this additionally lifts any
      // ANSI color that would sink into the translucent well ("enforce
      // minimum contrast", as in Warp).
      minimumContrastRatio: CONTRAST_RATIO,
      customGlyphs: CUSTOM_GLYPHS,
      theme: paneTermTheme(currentThemeId),
      windowsPty: { backend: "conpty", buildNumber: windowsBuildNumber },
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 5000,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(search);

    const rec = {
      uid: nextUid++,
      el,
      term,
      fit,
      search,
      tab,
      paneId: null,
      closed: false,
      title: "powershell",
      titlePath: null,
      spawnCwd: null,
      ordinal,
      runtimeHint: null,
      lastSentCols: null,
      lastSentRows: null,
      resetBeforeNextResize: false,
      lastDataAt: 0,
      lastKeyAt: 0,
      working: false,
      workingSince: 0,
      replyPendingAt: 0,
      turnArmed: false,
    };

    rec.mount = () => {
      term.open(el.querySelector(".pane-term"));
      attachWebglRenderer(rec);
      term.textarea?.addEventListener("focus", () => setFocusStyle(rec));
      rec.ro.observe(el.querySelector(".pane-term"));
      fitPane(rec);
    };

    term.onTitleChange((t) => {
      rec.title = cleanTitle(t);
      // Shells commonly put the cwd in the window title; harvest it. Default
      // PowerShell titles are the interpreter's own exe path — not a cwd.
      const pathMatch = String(t).match(/[A-Za-z]:\\[^"<>|?*\x00-\x1f]*/);
      if (pathMatch && !/\.(exe|com|bat|cmd)\s*$/i.test(pathMatch[0])) {
        rec.titlePath = pathMatch[0];
      }
      el.querySelector(".title").textContent = rec.title;
      const head = el.querySelector(".pane-head");
      head.classList.toggle("claude", /claude/i.test(t));
      head.classList.toggle("codex", /codex/i.test(t));
      // The CLI exited back to the shell: drop the provider identity so the
      // pane doesn't stay dressed as an agent. (A linked telemetry session
      // re-applies it if one is genuinely still bound.)
      if (rec.runtimeHint && !rec.session && /^(powershell|pwsh|cmd)$/i.test(rec.title)) {
        rec.runtimeHint = null;
        rec.el.classList.remove("claude", "codex");
        // Back to the theme's no-provider palette. This must go through
        // paneTermTheme (never NEXO_THEMES.termTheme) or the well loses its
        // background and the GPU renderer stops enforcing contrast —
        // CLM-terminal-well-tint-is-load-bearing.
        rec.term.options.theme = paneTermTheme(currentThemeId);
        rec.cursorQuiet = null; // re-decide the quiet cursor for a plain shell
      }
      renderAll();
    });

    term.onData((data) => {
      rec.lastKeyAt = Date.now();
      // "Unread" needs a message the user actually asked for. Submitting a line
      // arms this pane; work that starts without an arm (an agent continuing on
      // its own, a resumed session, plain command output) never blinks a tab.
      if (/[\r\n]/.test(data)) rec.replyPendingAt = Date.now();
      if (rec.paneId != null) agentTerminal.ptyInput(rec.paneId, data);
    });

    // Codex repaints its status line independently of telemetry. Re-evaluate
    // the hardware cursor after xterm applies each changed viewport range so
    // a cursor parked beside the cwd is suppressed without hiding the real
    // composer cursor.
    term.onRender(() => {
      updateCursorQuietFor(rec);
      updateJumpBottom(rec);
    });
    // Scrollback position drives the "Latest" pill; onScroll covers wheel and
    // keyboard scrolling, onRender covers new output arriving while parked.
    term.onScroll(() => updateJumpBottom(rec));

    const jumpBtn = el.querySelector(".jump-bottom");
    rec.jumpBtn = jumpBtn; // onRender runs per frame; don't re-query the DOM
    jumpBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    jumpBtn.addEventListener("click", () => {
      rec.term.scrollToBottom();
      updateJumpBottom(rec);
      focusPane(rec);
    });

    // Clipboard only — structural shortcuts live on the document (capture),
    // so they work regardless of where focus is.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
      const key = ev.key.toLowerCase();
      if (key === "c" && rec.term.hasSelection()) {
        navigator.clipboard.writeText(rec.term.getSelection()).catch(() => {});
        return false;
      }
      // Ctrl+V pastes, with or without Shift. Windows terminals (and Warp) all
      // paste on plain Ctrl+V; binding it to Ctrl+Shift+V only meant Ctrl+V
      // reached the PTY as a raw \x16, which agent TUIs silently swallow —
      // pasting into a Codex pane simply did nothing. term.paste() also emits
      // bracketed paste when the hosted app asked for it, which is what lets a
      // multi-line paste arrive as one block instead of a burst of Enters.
      if (key === "v") {
        navigator.clipboard.readText().then((t) => t && rec.term.paste(t)).catch(() => {});
        return false;
      }
      return true;
    });

    el.addEventListener("mousedown", () => focusPane(rec));

    const actions = el.querySelector(".actions");
    actions.addEventListener("mousedown", (ev) => ev.stopPropagation());
    actions.addEventListener("click", (ev) => {
      const act = ev.target.closest("button")?.dataset?.act;
      if (act === "split-h") splitPane(rec, "h");
      else if (act === "split-v") splitPane(rec, "v");
      else if (act === "close") closePane(rec);
    });

    let resizeTimer = null;
    rec.ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitPane(rec), 80);
    });

    agentTerminal
      .ptyCreate({ shell: "powershell.exe", cols: term.cols, rows: term.rows, cwd: cwd || undefined })
      .then(({ id, cols, rows, cwd }) => {
        if (rec.closed) {
          // The pane was closed before its shell finished spawning; without
          // this the PTY would outlive its tab and leak.
          agentTerminal.ptyKill(id);
          return;
        }
        rec.paneId = id;
        rec.lastSentCols = cols;
        rec.lastSentRows = rows;
        rec.spawnCwd = cwd || null;
        panes.set(id, rec);
        fitPane(rec);
        renderAll();
      })
      .catch((err) => term.writeln(`\r\n[agentterminal] failed to start shell: ${err.message}\r\n`));

    return rec;
  }

  function fitPane(rec) {
    if (rec.closed || layoutDragActive) return;
    const host = rec.el.querySelector(".pane-term");
    // hidden tabs measure 0 here — they are fitted once when re-activated
    if (host.clientWidth < 20 || host.clientHeight < 20) return;
    try {
      rec.fit.fit();
      if (rec.paneId == null) return;
      if (rec.lastSentCols === rec.term.cols && rec.lastSentRows === rec.term.rows) return;
      if (rec.resetBeforeNextResize && isAgentPane(rec)) {
        // Inline agent TUIs cannot erase rows that a width shrink pushed into
        // scrollback. Clear the old frame immediately before ConPTY receives
        // the final resize; the hosted CLI then paints one clean frame.
        rec.term.clear();
      }
      rec.resetBeforeNextResize = false;
      rec.lastSentCols = rec.term.cols;
      rec.lastSentRows = rec.term.rows;
      agentTerminal.ptyResize(rec.paneId, rec.term.cols, rec.term.rows);
    } catch {
      /* mid-layout fit can fail transiently; next observe pass retries */
    }
  }

  // "Go to latest message": the pill exists only while the viewport is parked
  // above the live edge. It is absolutely positioned inside the pane so showing
  // it never resizes .pane-term (a ConPTY resize mid-frame garbles agent TUIs).
  function updateJumpBottom(rec) {
    if (rec.closed) return;
    const btn = rec.jumpBtn;
    if (!btn) return;
    let away = false;
    try {
      const buffer = rec.term.buffer.active;
      away = buffer.baseY - buffer.viewportY > 1;
    } catch {
      away = false;
    }
    btn.classList.toggle("hidden", !away);
  }

  function isAgentPane(rec) {
    return rec.runtimeHint === "claude" ||
      rec.runtimeHint === "codex" ||
      rec.session?.source === "claude" ||
      rec.session?.source === "codex";
  }

  function markForAgentRedraw(records) {
    for (const rec of records) rec.resetBeforeNextResize = true;
  }

  function applyProviderTheme(rec) {
    if (!rec.runtimeHint) return;
    rec.term.options.theme = paneTermTheme(currentThemeId, rec.runtimeHint);
    rec.cursorQuiet = null; // as in applyUiTheme: re-decide the quiet cursor
  }

  function focusPane(rec) {
    if (rec.tab !== activeTab) activateTab(rec.tab);
    setFocusStyle(rec);
    rec.term.focus();
  }

  function setFocusStyle(rec) {
    rec.tab.lastFocused = rec;
    if (focused === rec) return;
    if (focused) focused.el.classList.remove("focused");
    focused = rec;
    rec.el.classList.add("focused");
    queueMicrotask(() => renderAll());
  }

  function leavesIn(container) {
    return [...container.querySelectorAll(".pane")]
      .map((el) => [...panes.values()].find((r) => r.el === el) || pending.find((r) => r.el === el))
      .filter(Boolean);
  }

  function allLeaves() {
    return tabs.flatMap((tab) => leavesIn(tab.fieldEl));
  }

  function renumberPanes(tab) {
    leavesIn(tab.fieldEl).forEach((rec, index) => {
      rec.ordinal = index + 1;
      const kicker = rec.el.querySelector(".pane-kicker");
      if (kicker) kicker.textContent = `pane ${String(rec.ordinal).padStart(2, "0")}`;
    });
  }

  // ------------------------------------------------------------- tabs ----
  function createTab(cwd) {
    const fieldEl = document.createElement("div");
    fieldEl.className = "tab-field hidden";
    field.append(fieldEl);
    const tab = { uid: nextUid++, fieldEl, lastFocused: null };
    tabs.push(tab);
    const fresh = createPane(tab, cwd);
    pending.push(fresh);
    fieldEl.append(fresh.el);
    fresh.mount();
    activateTab(tab);
    setFocusStyle(fresh);
    fresh.term.focus();
    return tab;
  }

  function activateTab(tab) {
    if (activeTab === tab) return;
    activeTab = tab;
    tab.attention = false;
    for (const t of tabs) t.fieldEl.classList.toggle("hidden", t !== tab);
    const ls = leavesIn(tab.fieldEl);
    // A window resize while this tab was hidden means its agent panes hold a
    // stale frame for the old geometry; clear before the catch-up resize.
    markForAgentRedraw(ls.filter(isAgentPane));
    requestAnimationFrame(() => {
      ls.forEach(fitPane);
      const f = tab.lastFocused && !tab.lastFocused.closed ? tab.lastFocused : ls[0];
      if (f) {
        setFocusStyle(f);
        f.term.focus();
      }
    });
    renderAll();
  }

  function destroyTab(tab) {
    const i = tabs.indexOf(tab);
    if (i >= 0) tabs.splice(i, 1);
    tab.fieldEl.remove();
    if (tabs.length === 0) {
      createTab();
      return;
    }
    if (activeTab === tab) {
      activeTab = null;
      activateTab(tabs[Math.min(i, tabs.length - 1)]);
    } else {
      renderAll();
    }
  }

  function closeTab(tab) {
    leavesIn(tab.fieldEl).forEach((rec) => closePane(rec));
  }

  function moveTab(tab, dir) {
    const i = tabs.indexOf(tab);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= tabs.length) return;
    tabs.splice(i, 1);
    tabs.splice(j, 0, tab);
    renderAll();
  }

  function tabDisplayName(tab, rep) {
    return tab.customName || paneFolderName(rep);
  }

  function cycleTab(dir) {
    if (tabs.length < 2 || !activeTab) return;
    const i = tabs.indexOf(activeTab);
    activateTab(tabs[(i + dir + tabs.length) % tabs.length]);
  }

  // ------------------------------------------------------------ splits ----
  function makeDivider(container) {
    const d = document.createElement("div");
    d.className = "divider";
    d.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const prev = d.previousElementSibling;
      const next = d.nextElementSibling;
      if (!prev || !next) return;
      const horiz = container.classList.contains("h");
      const total = horiz
        ? prev.getBoundingClientRect().width + next.getBoundingClientRect().width
        : prev.getBoundingClientRect().height + next.getBoundingClientRect().height;
      const start = horiz ? ev.clientX : ev.clientY;
      const prevStart = horiz ? prev.getBoundingClientRect().width : prev.getBoundingClientRect().height;
      layoutDragActive = true;
      d.classList.add("dragging");
      d.setPointerCapture(ev.pointerId);
      const move = (mv) => {
        const delta = (horiz ? mv.clientX : mv.clientY) - start;
        const a = Math.min(Math.max(prevStart + delta, 80), total - 80);
        prev.style.flex = `${a / total} 1 0`;
        next.style.flex = `${(total - a) / total} 1 0`;
      };
      const up = () => {
        layoutDragActive = false;
        d.classList.remove("dragging");
        d.removeEventListener("pointermove", move);
        d.removeEventListener("pointerup", up);
        d.removeEventListener("pointercancel", up);
        const affected = allLeaves().filter((rec) => container.contains(rec.el));
        markForAgentRedraw(affected);
        requestAnimationFrame(() => affected.forEach(fitPane));
      };
      d.addEventListener("pointermove", move);
      d.addEventListener("pointerup", up);
      d.addEventListener("pointercancel", up);
    });
    return d;
  }

  function splitPane(rec, dir) {
    const tab = rec.tab;
    const parent = rec.el.parentElement;
    const affected = parent.classList.contains("split") && parent.classList.contains(dir)
      ? leavesIn(tab.fieldEl).filter((pane) => parent.contains(pane.el))
      : [rec];
    markForAgentRedraw(affected);
    // a split inherits the folder of the pane it came from, Warp-style
    const fresh = createPane(tab, panePath(rec) || undefined);
    pending.push(fresh);
    if (parent.classList.contains("split") && parent.classList.contains(dir)) {
      const d = makeDivider(parent);
      rec.el.after(d);
      d.after(fresh.el);
    } else {
      const wrap = document.createElement("div");
      wrap.className = `split ${dir}`;
      wrap.style.flex = rec.el.style.flex || "1 1 0";
      parent.replaceChild(wrap, rec.el);
      rec.el.style.flex = "";
      wrap.append(rec.el, makeDivider(wrap), fresh.el);
    }
    fresh.mount();
    renumberPanes(tab);
    focusPane(fresh);
  }

  function closePane(rec, alreadyExited = false) {
    if (rec.closed) return;
    rec.closed = true;
    const tab = rec.tab;
    if (!alreadyExited && rec.paneId != null) agentTerminal.ptyKill(rec.paneId);
    if (rec.paneId != null) panes.delete(rec.paneId);
    const pi = pending.indexOf(rec);
    if (pi >= 0) pending.splice(pi, 1);
    rec.ro?.disconnect();
    // The GPU renderer must be torn down before the terminal that owns its
    // canvas — disposing the Terminal first throws inside the addon, and an
    // exception here used to strand the pane's DOM element and its tab (the
    // PTY was already dead). Neither call may abort the rest of this teardown.
    try { rec.webgl?.dispose(); } catch {}
    rec.webgl = null;
    try { rec.term.dispose(); } catch {}

    const el = rec.el;
    const parent = el.parentElement;
    markForAgentRedraw(leavesIn(tab.fieldEl).filter((pane) => pane !== rec && parent.contains(pane.el)));
    const d = el.previousElementSibling?.classList.contains("divider")
      ? el.previousElementSibling
      : el.nextElementSibling;
    el.remove();
    if (d?.classList.contains("divider")) d.remove();

    if (parent.classList.contains("split") && parent.children.length === 1) {
      const child = parent.firstElementChild;
      child.style.flex = parent.style.flex || "";
      parent.replaceWith(child);
    }

    if (tab.lastFocused === rec) tab.lastFocused = null;
    if (focused === rec) focused = null;

    const rest = leavesIn(tab.fieldEl);
    if (rest.length === 0) {
      destroyTab(tab);
      return;
    }
    renumberPanes(tab);
    if (tab === activeTab && !focused) focusPane(rest[0]);
    else renderAll();
  }

  // ----------------------------------------- global keyboard (capture) ----
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
      const key = ev.key.toLowerCase();
      const act = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (key === "b") {
        act();
        toggleRail();
        return;
      }
      if (key === "p") {
        act();
        if (paletteEl.classList.contains("hidden")) openPalette();
        else closePalette();
        return;
      }
      if (key === "f") {
        act();
        if (searchBar.classList.contains("hidden")) openSearch();
        else closeSearch();
        return;
      }
      if (key === "t") {
        act();
        createTab(focused ? panePath(focused) : undefined);
        return;
      }
      if (key === "pagedown" || key === "pageup") {
        act();
        cycleTab(key === "pagedown" ? 1 : -1);
        return;
      }
      if (!focused) return;
      if (key === "d") {
        act();
        splitPane(focused, "h");
      } else if (key === "e") {
        act();
        splitPane(focused, "v");
      } else if (key === "w") {
        act();
        closePane(focused);
      } else if (key === "arrowright" || key === "arrowleft") {
        const all = activeTab ? leavesIn(activeTab.fieldEl) : [];
        const i = all.indexOf(focused);
        if (i >= 0 && all.length > 1) {
          act();
          focusPane(all[(i + (key === "arrowright" ? 1 : all.length - 1)) % all.length]);
        }
      }
    },
    true
  );

  // --------------------------------------------------------- PTY wires ----
  agentTerminal.onPtyData(({ id, data }) => {
    const rec = panes.get(id);
    if (!rec) return;
    rec.lastDataAt = Date.now();
    if (!rec.runtimeHint) {
      const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (/OpenAI Codex/i.test(plain)) rec.runtimeHint = "codex";
      else if (/Claude Code/i.test(plain)) rec.runtimeHint = "claude";
      if (rec.runtimeHint) {
        const head = rec.el.querySelector(".pane-head");
        head.classList.toggle("claude", rec.runtimeHint === "claude");
        head.classList.toggle("codex", rec.runtimeHint === "codex");
        rec.el.classList.toggle("claude", rec.runtimeHint === "claude");
        rec.el.classList.toggle("codex", rec.runtimeHint === "codex");
        applyProviderTheme(rec);
        renderAll();
      }
    }
    rec.term.write(data);
  });

  agentTerminal.onPtyExit(({ id }) => {
    const rec = panes.get(id);
    if (rec) closePane(rec, true);
  });

  // -------------------------------------------------------- top chrome ----
  document.getElementById("menu-terminal").addEventListener("click", () => focused?.term.focus());

  // Appearance popover: themes + opacity slider under the strip menu.
  const appearanceBtn = document.getElementById("appearance-btn");
  const appearancePop = document.getElementById("appearance-pop");
  const appearanceThemes = document.getElementById("appearance-themes");
  const appearanceOpacity = document.getElementById("appearance-opacity");
  const appearanceOpacityValue = document.getElementById("appearance-opacity-value");
  const appearanceVersion = document.getElementById("appearance-version");
  agentTerminal.updateGetState().then((state) => {
    if (state?.currentVersion) appearanceVersion.textContent = `Nexo v${state.currentVersion}`;
  }).catch(() => {});

  function renderAppearance() {
    appearanceThemes.innerHTML = Object.entries(NEXO_THEMES.themes).map(([id, theme]) => `
      <button class="ap-theme ${id === currentThemeId ? "current" : ""}" data-theme-id="${id}" role="menuitem">
        <span class="sw" style="background:${theme.swatch.bg};box-shadow:inset 0 0 0 2px ${theme.swatch.bg},inset 0 0 0 4px ${theme.swatch.accent}"></span>
        <span>${esc(theme.label)}</span>
      </button>`).join("");
    appearanceThemes.querySelectorAll(".ap-theme").forEach((row) => {
      row.addEventListener("click", () => {
        applyUiTheme(row.dataset.themeId);
        renderAppearance();
        syncOpacitySlider();
        renderAll();
      });
    });
    syncOpacitySlider();
  }

  function syncOpacitySlider() {
    const pct = currentOpacityPct();
    appearanceOpacity.value = String(pct);
    appearanceOpacityValue.textContent = `${pct}%`;
  }

  function toggleAppearance(open) {
    const show = open ?? appearancePop.classList.contains("hidden");
    appearancePop.classList.toggle("hidden", !show);
    appearanceBtn.classList.toggle("active", show);
    appearanceBtn.setAttribute("aria-expanded", show ? "true" : "false");
    if (show) renderAppearance();
  }

  appearanceBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleAppearance();
  });
  appearanceOpacity.addEventListener("input", () => {
    applyOpacity(Number(appearanceOpacity.value));
    appearanceOpacityValue.textContent = `${appearanceOpacity.value}%`;
  });
  document.addEventListener("pointerdown", (ev) => {
    if (appearancePop.classList.contains("hidden")) return;
    if (!appearancePop.contains(ev.target) && ev.target !== appearanceBtn && !appearanceBtn.contains(ev.target)) {
      toggleAppearance(false);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !appearancePop.classList.contains("hidden")) toggleAppearance(false);
  });
  const newTabHere = () => createTab(focused ? panePath(focused) : undefined);
  document.getElementById("new-tab").addEventListener("click", newTabHere);
  document.getElementById("new-pane").addEventListener("click", newTabHere);
  document.getElementById("workspace-split").addEventListener("click", () => focused && splitPane(focused, "h"));
  document.getElementById("workspace-split-v").addEventListener("click", () => focused && splitPane(focused, "v"));

  function renderTabs() {
    tabStrip.innerHTML = tabs.map((tab) => {
      const rep = tab.lastFocused && !tab.lastFocused.closed
        ? tab.lastFocused
        : leavesIn(tab.fieldEl)[0];
      if (!rep) return "";
      const s = rep.session;
      const source = paneSource(rep);
      const chip = modelChip(s?.model);
      const pct = contextPct(s);
      const streaming = Date.now() - rep.lastDataAt < 1500;
      const count = leavesIn(tab.fieldEl).length;
      // renderTabs rebuilds the strip, which would restart the blink from zero
      // on every telemetry tick; a negative delay keeps its phase continuous.
      const attnDelay = tab.attention
        ? -((Date.now() - (tab.attentionSince || 0)) % ATTENTION_PERIOD_MS)
        : 0;
      return `<button class="tab ${esc(source)} ${tab === activeTab ? "active" : ""} ${streaming ? "streaming" : ""} ${tab.attention ? "attention" : ""}"
        style="--attn-delay:${attnDelay}ms"
        role="tab" aria-selected="${tab === activeTab}" data-tab="${tab.uid}"
        title="${esc(panePath(rep) || rep.title)}">
        <span class="tick"></span>
        <span class="name">${esc(tabDisplayName(tab, rep))}${count > 1 ? ` +${count - 1}` : ""}</span>
        ${chip ? `<span class="chip">${esc(chip)}</span>` : ""}
        <span class="tclose" title="Close session (Ctrl+Shift+W)" aria-label="Close session">×</span>
        <span class="mini ${pct == null ? "off" : ""}"><i style="width:${pct ?? 0}%"></i></span>
      </button>`;
    }).join("");
    tabStrip.querySelectorAll(".tab").forEach((btn) => {
      const tab = tabs.find((t) => t.uid === Number(btn.dataset.tab));
      if (!tab) return;
      btn.addEventListener("pointerdown", (ev) => {
        if (ev.button === 0 && !ev.target.closest(".tclose")) activateTab(tab);
      });
      btn.addEventListener("click", (ev) => {
        if (ev.target.closest(".tclose")) closeTab(tab);
      });
      btn.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) closeTab(tab);
      });
      btn.addEventListener("dblclick", () => openPalette({ rename: tab }));
    });
  }

  function updateChrome() {
    if (!focused) {
      workspaceTitle.textContent = "No active session";
      workspaceId.textContent = "#LOCAL";
      workspaceMeta.textContent = "terminal unavailable";
      return;
    }
    const name = focused.tab.customName || paneFolderName(focused);
    workspaceTitle.textContent = name;
    workspaceId.textContent = `${modelChip(focused.session?.model) || focused.title} · ${paneSource(focused)} · #LOCAL-${String(focused.ordinal).padStart(2, "0")}`;
    workspaceMeta.textContent = `${panePath(focused) || "local shell"} · ${focused.title}`;
    document.title = `${name} — Nexo`;
  }

  // ----------------------------------------------------- session ledger ----
  const rail = document.getElementById("ledger");
  const linkEl = document.getElementById("link-state");
  const relayEl = document.getElementById("relay-state");
  const rowsEl = document.getElementById("ledger-rows");
  const railToggle = document.getElementById("ledger-toggle");
  const sessions = new Map();

  function syncRailToggle() {
    const min = rail.classList.contains("min");
    railToggle.textContent = min ? "»" : "«";
    railToggle.title = `${min ? "Expand" : "Collapse"} sessions (Ctrl+Shift+B)`;
    railToggle.setAttribute("aria-expanded", min ? "false" : "true");
  }

  function toggleRail() {
    rail.classList.toggle("min");
    syncRailToggle();
    try {
      localStorage.setItem("rail-min-v1", rail.classList.contains("min") ? "1" : "");
    } catch {}
  }
  railToggle.addEventListener("click", toggleRail);
  try {
    if (localStorage.getItem("rail-min-v1") === "1") rail.classList.add("min");
  } catch {}
  syncRailToggle();

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function ago(iso) {
    if (!iso) return "";
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  }

  function compactCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    if (value >= 1e6) {
      const digits = value >= 10e6 ? 0 : 1;
      return `${(value / 1e6).toFixed(digits)}m`;
    }
    if (value >= 1e3) {
      const digits = value >= 100e3 ? 0 : 1;
      return `${(value / 1e3).toFixed(digits)}k`;
    }
    return String(Math.round(value));
  }

  function rateLimitHtml(session) {
    if (!Array.isArray(session.rateLimits)) return "";
    return session.rateLimits
      .filter((w) => w && typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent))
      .map((w) => `${esc(w.label ?? "plan")} <b>${Math.round(w.usedPercent)}%</b>`)
      .join(" · ");
  }

  function tokenText(session) {
    const total = compactCount(session.tokens?.total);
    return total ? `${total} tok` : "";
  }

  function contextPct(s) {
    if (!s) return null;
    const pct = s.contextPercent ?? (s.contextUsed != null && s.contextWindow
      ? (100 * s.contextUsed) / s.contextWindow : null);
    return pct == null ? null : Math.max(0, Math.min(100, pct));
  }

  // ---------------------------------------------- pane <-> session link ----
  // claude sessions carry an exact paneId (env var -> statusline hook).
  // Codex sessions become exact after the first notify; until then the freshest
  // unclaimed session goes to a Codex-titled pane, marked "≈" as an assumption.
  function linkSessions() {
    const now = Date.now();
    const live = [...sessions.values()].filter(
      (r) => r.updatedAt && now - Date.parse(r.updatedAt) < 30 * 60e3
    );
    const byPane = new Map();
    const claimed = new Set();
    for (const s of live) {
      if (s.paneId != null && !s.subagent) {
        const pid = String(s.paneId);
        byPane.set(pid, { s, approx: false });
        claimed.add(s.sessionId);
        const rec = panes.get(pid);
        if (rec) rec.approxSessionId = null;
      }
    }
    const codexPool = live
      .filter((s) => s.source === "codex" && !s.subagent && !claimed.has(s.sessionId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    // Keep a provisional assignment on the pane that earned it. Recomputing
    // from scratch on every split made truthful Codex telemetry disappear as
    // soon as another pane entered the layout.
    for (const rec of panes.values()) {
      const pid = String(rec.paneId);
      if (byPane.has(pid) || !rec.approxSessionId) continue;
      const s = codexPool.find(
        (candidate) => candidate.sessionId === rec.approxSessionId &&
          !claimed.has(candidate.sessionId)
      );
      if (!s) {
        rec.approxSessionId = null;
        continue;
      }
      claimed.add(s.sessionId);
      byPane.set(pid, { s, approx: true });
    }

    for (const rec of panes.values()) {
      const pid = String(rec.paneId);
      if (byPane.has(pid)) continue;
      if (rec.runtimeHint !== "codex" &&
          !rec.el.querySelector(".pane-head").classList.contains("codex")) continue;
      const s = codexPool.find((x) => !claimed.has(x.sessionId));
      if (s) {
        claimed.add(s.sessionId);
        rec.approxSessionId = s.sessionId;
        byPane.set(pid, { s, approx: true });
      }
    }
    const unbound = [...panes.values()].filter(
      (rec) => rec.runtimeHint === "codex" && !byPane.has(String(rec.paneId))
    );
    const available = codexPool.filter((s) => !claimed.has(s.sessionId));
    // Before Codex's first completed-turn notify, a single pane and a single
    // live Codex session are an honest, explicitly approximate match.
    if (unbound.length === 1 && available.length === 1) {
      claimed.add(available[0].sessionId);
      unbound[0].approxSessionId = available[0].sessionId;
      byPane.set(String(unbound[0].paneId), { s: available[0], approx: true });
    }
    return byPane;
  }

  function traceHtml(r, unknownLabel = "?") {
    const clamped = contextPct(r);
    const provenance = r.contextLabel === "measured" ? "" : r.contextLabel === "counted" ? "counted" : "unknown";
    const pctCls = clamped == null ? "" : clamped >= 85 ? "hot" : clamped >= 60 ? "warn" : "";
    return clamped == null
      ? `<span class="trace unknown"></span><span class="pct">${unknownLabel}</span>`
      : `<span class="trace ${provenance}"><span class="fill" style="width:${clamped}%"></span></span>
         <span class="pct ${pctCls}">${Math.round(clamped)}%</span>`;
  }

  function updatePaneStatus(byPane) {
    for (const rec of panes.values()) {
      const el = rec.el.querySelector(".pane-status");
      if (!el) continue;
      const hit = byPane.get(String(rec.paneId));
      if (!hit) {
        rec.session = null;
        // Strip stays mounted (empty) so linking never resizes the terminal —
        // a ConPTY resize mid-boot interrupts codex's MCP startup.
        el.className = "pane-status empty";
        el.innerHTML = `<span class="tick"></span><span class="model">shell</span><span class="status-muted">instrumentation waiting</span>`;
        continue;
      }
      const { s, approx } = hit;
      rec.session = s;
      rec.el.classList.toggle("claude", s.source === "claude");
      rec.el.classList.toggle("codex", s.source === "codex");
      const plan = rateLimitHtml(s);
      const tokens = tokenText(s);
      const cost = typeof s.costUsd === "number" && Number.isFinite(s.costUsd)
        ? `$${s.costUsd.toFixed(2)}`
        : "";
      const effort = s.effort ? ` · ${esc(s.effort)}` : "";
      el.hidden = false;
      el.className = `pane-status ${esc(s.source)}`;
      el.innerHTML = `
        <span class="tick"></span>
        <span class="model">${approx ? "≈ " : ""}${esc(s.model ?? "model unknown")}${effort}</span>
        <span class="trace-wrap">${traceHtml(s)}</span>
        <span class="plan">context <b>${esc(s.contextLabel ?? "unknown")}</b></span>
        ${plan ? `<span class="plan">${plan}</span>` : ""}
        ${tokens ? `<span class="plan">${tokens}</span>` : ""}
        ${cost ? `<span class="plan">${cost}</span>` : ""}`;
    }
  }

  function renderRail(byPane) {
    const recs = allLeaves();
    rowsEl.innerHTML = recs.map((rec) => {
      const hit = rec.paneId == null ? null : byPane.get(String(rec.paneId));
      const s = hit?.s ?? null;
      const source = s?.source ?? (rec.runtimeHint || "shell");
      const stale = s?.updatedAt && Date.now() - Date.parse(s.updatedAt) > 10 * 60e3;
      const initial = source === "claude" ? "C" : source === "codex" ? "X" : "&gt;_";
      const preview = s
        ? `${hit.approx ? "~ " : ""}${esc(s.model || "model unknown")}${s.effort ? ` · ${esc(s.effort)}` : ""}`
        : esc(rec.title);
      const pct = contextPct(s);
      return `<button class="mrow ${esc(source)} ${focused === rec ? "focused" : ""} ${stale ? "stale" : ""}"
        data-pane="${rec.uid}" title="${esc(panePath(rec) || rec.title)}">
        <span class="ava">${initial}</span>
        <span class="mbody">
          <span class="ml1">
            <span class="mname">${esc(rec.tab.customName || paneFolderName(rec))}</span>
            <span class="mtime">${s ? ago(s.updatedAt) : ""}</span>
          </span>
          <span class="mprev">${preview}</span>
          <span class="mbar ${pct == null ? "off" : ""}"><i style="width:${pct ?? 0}%"></i></span>
        </span>
        <span class="mbar2 ${pct == null ? "off" : ""}"><i style="width:${pct ?? 0}%"></i></span>
      </button>`;
    }).join("");

    if (recs.length === 0) {
      rowsEl.innerHTML = '<div id="ledger-empty">No session is running.</div>';
    }
    rowsEl.querySelectorAll(".mrow").forEach((row) => {
      row.addEventListener("click", () => {
        const rec = allLeaves().find((pane) => pane.uid === Number(row.dataset.pane));
        if (rec) focusPane(rec);
      });
    });
  }

  // The usage pool: one group per provider —
  //   [model] ctx XX% (provenance) · <rate-limit windows> · cost
  // Session/weekly windows come from telemetry rateLimits; absent data shows
  // nothing rather than a guess.
  function renderPool(byPane) {
    const groups = [];
    for (const source of ["claude", "codex"]) {
      let s = focused?.session?.source === source ? focused.session : null;
      if (!s) {
        for (const hit of byPane.values()) {
          if (hit.s.source === source) {
            s = hit.s;
            break;
          }
        }
      }
      if (!s) continue;
      const pct = contextPct(s);
      const limits = Array.isArray(s.rateLimits)
        ? s.rateLimits
            .filter((w) => w && typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent))
            .map((w) => `<span class="pv2">${esc(w.label ?? "plan")} ${Math.round(w.usedPercent)}%</span>`)
            .join("")
        : "";
      const cost = typeof s.costUsd === "number" && Number.isFinite(s.costUsd)
        ? `<span class="pv2">$${s.costUsd.toFixed(2)}</span>`
        : "";
      groups.push(`<span class="seg ${esc(source)}">
        <span class="tick"></span>
        <span class="sname">${esc(modelChip(s.model) || source)}</span>
        ${pct == null
          ? `<span class="pv">ctx unknown</span>`
          : `<span class="trace"><span class="fill" style="width:${pct}%"></span></span>
             <span class="pv">ctx ${Math.round(pct)}% · ${esc(s.contextLabel ?? "unknown")}</span>`}
        ${limits}${cost}
      </span>`);
    }
    if (groups.length === 0 && focused) {
      groups.push(`<span class="seg">
        <span class="tick"></span>
        <span class="sname">${esc(paneFolderName(focused))}</span>
        <span class="pv2">shell · no model</span>
      </span>`);
    }
    poolGroups.innerHTML = groups.join("");
  }

  function renderAll() {
    const byPane = linkSessions();
    updatePaneStatus(byPane);
    renderTabs();
    renderRail(byPane);
    renderPool(byPane);
    updateChrome();
    updateCursorQuiet();
  }

  // Telemetry arrives far faster than the chrome needs to change: Claude's
  // statusline hook fires on every status-line repaint, so a streaming session
  // pushed one FULL renderAll() per event — relinking sessions, rewriting every
  // pane-status block, and rebuilding the tab strip, the rail and the pool
  // along with all their event listeners.
  //
  // Coalesced rather than split into targeted updates on purpose. The whole-
  // chrome render is what keeps the views consistent, and two existing
  // behaviours are built on top of it: the tab strip carries the blink phase in
  // --attn-delay because it gets rebuilt, and tab activation runs on
  // pointerdown because a repaint can replace the node before click lands.
  // Rendering less often keeps both correct; rendering partially would not.
  //
  // Trailing edge, so the final state always paints even if the burst stops.
  const TELEMETRY_RENDER_MS = 200;
  let renderPending = false;
  let lastRenderAt = 0;

  function scheduleRender() {
    if (renderPending) return;
    const wait = Math.max(0, TELEMETRY_RENDER_MS - (Date.now() - lastRenderAt));
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      lastRenderAt = Date.now();
      renderAll();
    }, wait);
  }

  async function connectTelemetry() {
    const telemetryUrl = await agentTerminal.telemetryUrl();
    const es = new EventSource(telemetryUrl);
    es.onopen = () => {
      linkEl.innerHTML = "<i></i> live";
      linkEl.className = "live";
      relayEl.innerHTML = "<i></i> relay live";
      relayEl.className = "live";
    };
    es.onerror = () => {
      linkEl.innerHTML = "<i></i> offline";
      linkEl.className = "dim";
      relayEl.innerHTML = "<i></i> relay offline";
      relayEl.className = "dim";
    };
    es.onmessage = (ev) => {
      try {
        const rec = JSON.parse(ev.data);
        if (rec && rec.sessionId) {
          // The session map updates immediately; only the repaint is coalesced,
          // so anything reading rec.session still sees fresh telemetry at once.
          sessions.set(rec.sessionId, rec);
          scheduleRender();
        }
      } catch {
        /* never let malformed telemetry touch the panes */
      }
    };
  }

  // -------------------------------------------------------- search bar ----
  const searchBar = document.getElementById("search-bar");
  const searchInput = document.getElementById("search-input");

  function openSearch() {
    searchBar.classList.remove("hidden");
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch() {
    searchBar.classList.add("hidden");
    focused?.search?.clearDecorations?.();
    focused?.term.focus();
  }
  function runSearch(dir, incremental = false) {
    const rec = focused;
    const q = searchInput.value;
    if (!rec?.search || !q) return;
    if (dir < 0) rec.search.findPrevious(q);
    else rec.search.findNext(q, incremental ? { incremental: true } : undefined);
  }
  searchInput.addEventListener("input", () => runSearch(1, true));
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeSearch();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      runSearch(ev.shiftKey ? -1 : 1);
    }
  });
  document.getElementById("search-next").addEventListener("click", () => runSearch(1));
  document.getElementById("search-prev").addEventListener("click", () => runSearch(-1));
  document.getElementById("search-close").addEventListener("click", closeSearch);
  document.getElementById("workspace-search").addEventListener("click", openSearch);

  // ---------------------------------------------------- command palette ----
  const paletteEl = document.getElementById("palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteList = document.getElementById("palette-list");
  let paletteMode = null; // null (actions) | { rename: tab }
  let paletteSel = 0;
  let paletteItems = [];

  function fuzzyScore(q, s) {
    if (!q) return 0;
    q = q.toLowerCase();
    s = s.toLowerCase();
    let qi = 0, score = 0, streak = 0;
    for (let i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] === q[qi]) {
        score += 1 + streak + (i === 0 || s[i - 1] === " " || s[i - 1] === ":" ? 3 : 0);
        streak++;
        qi++;
      } else {
        streak = 0;
      }
    }
    return qi === q.length ? score : -1;
  }

  function paletteActions() {
    const acts = [];
    const here = focused ? panePath(focused) : "";
    acts.push({ label: "New tab", hint: "Ctrl+Shift+T", run: () => createTab(here || undefined) });
    if (focused) {
      acts.push({ label: "Split right", hint: "Ctrl+Shift+D", run: () => splitPane(focused, "h") });
      acts.push({ label: "Split down", hint: "Ctrl+Shift+E", run: () => splitPane(focused, "v") });
      acts.push({ label: "Close pane", hint: "Ctrl+Shift+W", run: () => closePane(focused) });
    }
    if (activeTab) {
      const tab = activeTab;
      acts.push({ label: "Close tab", run: () => closeTab(tab) });
      acts.push({ label: "Rename tab…", run: () => openPalette({ rename: tab }) });
      acts.push({ label: "Move tab left", run: () => moveTab(tab, -1) });
      acts.push({ label: "Move tab right", run: () => moveTab(tab, 1) });
    }
    acts.push({
      label: rail.classList.contains("min") ? "Expand sessions" : "Collapse sessions",
      hint: "Ctrl+Shift+B",
      run: toggleRail,
    });
    acts.push({ label: "Next tab", hint: "Ctrl+Shift+PgDn", run: () => cycleTab(1) });
    acts.push({ label: "Previous tab", hint: "Ctrl+Shift+PgUp", run: () => cycleTab(-1) });
    acts.push({ label: "Local telemetry settings", run: () => agentTerminal.openTelemetrySettings() });
    acts.push({ label: "Appearance: themes & opacity…", run: () => toggleAppearance(true) });
    for (const [id, theme] of Object.entries(NEXO_THEMES.themes)) {
      acts.push({
        label: `Theme: ${theme.label}`,
        hint: id === currentThemeId ? "current" : "",
        run: () => applyUiTheme(id),
      });
    }
    acts.push({ label: "Opacity: reset to theme default", run: () => applyOpacity(null) });
    for (const tab of tabs) {
      const rep = tab.lastFocused && !tab.lastFocused.closed ? tab.lastFocused : leavesIn(tab.fieldEl)[0];
      if (!rep) continue;
      const s = rep.session;
      acts.push({
        label: `Go to: ${tabDisplayName(tab, rep)}${s ? ` — ${modelChip(s.model)}` : ""}`,
        cls: paneSource(rep),
        run: () => activateTab(tab),
      });
    }
    return acts;
  }

  function renderPalette() {
    if (paletteMode && paletteMode.rename) {
      paletteList.innerHTML =
        '<div id="palette-empty">Enter renames the tab — empty resets to the folder name. Esc cancels.</div>';
      return;
    }
    const q = paletteInput.value.trim();
    paletteItems = paletteActions()
      .map((a) => ({ a, score: fuzzyScore(q, a.label) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
    paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
    paletteList.innerHTML = paletteItems.length
      ? paletteItems
          .map(
            (a, i) => `<div class="prow ${a.cls || ""} ${i === paletteSel ? "sel" : ""}" data-i="${i}">
        <span class="tick"></span><span>${esc(a.label)}</span>${a.hint ? `<span class="hint">${esc(a.hint)}</span>` : ""}
      </div>`
          )
          .join("")
      : '<div id="palette-empty">No matching command.</div>';
    paletteList.querySelectorAll(".prow").forEach((row) => {
      row.addEventListener("click", () => {
        const a = paletteItems[Number(row.dataset.i)];
        if (!a) return;
        closePalette(false);
        a.run();
        if (paletteEl.classList.contains("hidden")) focused?.term.focus();
      });
    });
  }

  function openPalette(mode) {
    paletteMode = mode || null;
    paletteSel = 0;
    paletteEl.classList.remove("hidden");
    paletteInput.value = mode && mode.rename ? mode.rename.customName || "" : "";
    paletteInput.placeholder = mode && mode.rename ? "New tab name…" : "Type a command…";
    renderPalette();
    paletteInput.focus();
    paletteInput.select();
  }

  function closePalette(refocus = true) {
    paletteEl.classList.add("hidden");
    paletteMode = null;
    if (refocus) focused?.term.focus();
  }

  paletteInput.addEventListener("input", () => {
    paletteSel = 0;
    renderPalette();
  });
  paletteInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePalette();
      return;
    }
    if (paletteMode && paletteMode.rename) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        paletteMode.rename.customName = paletteInput.value.trim() || null;
        closePalette();
        renderAll();
      }
      return;
    }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!paletteItems.length) return;
      paletteSel = (paletteSel + (ev.key === "ArrowDown" ? 1 : paletteItems.length - 1)) % paletteItems.length;
      renderPalette();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const a = paletteItems[paletteSel];
      if (!a) return;
      closePalette(false);
      a.run();
      if (paletteEl.classList.contains("hidden")) focused?.term.focus();
    }
  });
  paletteEl.addEventListener("mousedown", (ev) => {
    if (ev.target === paletteEl) closePalette();
  });

  // boot: one tab — in the folder Explorer asked for, if any
  createTab(new URLSearchParams(location.search).get("open") || undefined);
  renderAll();
  // "Open in Nexo" while already running: the folder arrives as a new tab
  agentTerminal.onOpenFolder?.(({ cwd }) => cwd && createTab(cwd));
  try {
    connectTelemetry().catch(() => {
      linkEl.innerHTML = "<i></i> offline";
      linkEl.className = "dim";
      relayEl.innerHTML = "<i></i> relay offline";
      relayEl.className = "dim";
    });
    setInterval(renderAll, 30000); // refresh staleness + ages
  } catch {
    linkEl.innerHTML = "<i></i> offline";
    linkEl.className = "dim";
    relayEl.innerHTML = "<i></i> relay offline";
    relayEl.className = "dim";
  }

  // Updates remain entirely user-controlled: the icon appears only after a
  // release is found, the first click downloads, and a later click restarts.
  const updateButton = document.getElementById("update-status");
  const updateLabel = document.getElementById("update-label");
  let updateState = { phase: "idle" };
  function renderUpdate(state) {
    updateState = state || updateState;
    const visible = ["available", "downloading", "ready"].includes(updateState.phase);
    updateButton.classList.toggle("hidden", !visible);
    updateButton.classList.toggle("ready", updateState.phase === "ready");
    updateButton.disabled = updateState.phase === "downloading";
    if (updateState.phase === "available") {
      updateLabel.textContent = `Nexo ${updateState.version || "update"}`;
      updateButton.title = "Update available — click to download";
    } else if (updateState.phase === "downloading") {
      updateLabel.textContent = `Downloading ${updateState.percent || 0}%`;
      updateButton.title = "Downloading Nexo update";
    } else if (updateState.phase === "ready") {
      updateLabel.textContent = "Restart & update";
      updateButton.title = "Update ready — choose when to restart";
    }
  }
  updateButton.addEventListener("click", async () => {
    if (updateState.phase === "available") await agentTerminal.updateDownload();
    else if (updateState.phase === "ready") await agentTerminal.updateInstall();
  });
  agentTerminal.onUpdateState(renderUpdate);
  agentTerminal.updateGetState().then(renderUpdate).catch(() => {});

  // Streaming indicator: pulse the active tab's seam only while its session is
  // actually producing output. Class toggle only — no geometry involved.
  setInterval(() => {
    const btn = tabStrip.querySelector(".tab.active");
    if (!btn || !activeTab) return;
    const rep = activeTab.lastFocused || leavesIn(activeTab.fieldEl)[0];
    if (!rep) return;
    btn.classList.toggle("streaming", Date.now() - rep.lastDataAt < 1500);
  }, 1000);

  // Unread attention, the messenger rule: a tab blinks only when a reply the
  // user asked for arrives while they are not looking, and stops the moment
  // they look. Three conditions must all hold — the user submitted a line in
  // that pane (replyPendingAt), work then ran for at least TURN_MIN_MS, and
  // the tab was not being watched when it finished.
  //
  // Codex reports `working` truthfully (task_started / agent-turn-complete).
  // Claude's telemetry carries no turn state at all, so the fallback is its own
  // repainting spinner: an agent pane quiet for AGENT_QUIET_MS has finished.
  // That fallback fires on *any* output, which is exactly why the user-submit
  // arm is required — without it, output nobody asked for blinked the tab.
  function paneIsWorking(rec, now) {
    if (!isAgentPane(rec)) return false;
    if (typeof rec.session?.working === "boolean") return rec.session.working;
    return now - rec.lastDataAt < AGENT_QUIET_MS;
  }

  // The user is watching this tab only if it is on screen *and* Nexo has the
  // OS focus — a finished turn behind another window still deserves the blink.
  function tabIsWatched(tab) {
    return tab === activeTab && document.hasFocus();
  }

  function updateAttention(now = Date.now()) {
    let changed = false;
    for (const rec of panes.values()) {
      const working = paneIsWorking(rec, now);
      if (working !== rec.working) {
        if (working) {
          // The turn is a reply to the user only if they submitted a line
          // before it began, and recently enough to still be waiting on it.
          rec.turnArmed = rec.replyPendingAt > 0 && now - rec.replyPendingAt < REPLY_ARM_MS;
          rec.replyPendingAt = 0;
          rec.workingSince = now;
        } else {
          const wasReply = rec.turnArmed && rec.workingSince && now - rec.workingSince >= TURN_MIN_MS;
          rec.turnArmed = false;
          // Watching the tab as the reply lands means it is already read.
          if (wasReply && !tabIsWatched(rec.tab) && !rec.tab.attention) {
            rec.tab.attention = true;
            rec.tab.attentionSince = now;
            changed = true;
          }
        }
        rec.working = working;
      }
    }
    for (const tab of tabs) {
      if (tab.attention && tabIsWatched(tab)) {
        tab.attention = false;
        changed = true;
      }
    }
    if (changed) renderTabs();
  }
  setInterval(updateAttention, 500);
  window.addEventListener("focus", () => updateAttention());

  // Codex parks xterm's hardware cursor immediately after the cwd in its
  // status line while drawing a separate composer cursor. Match the buffer
  // position, not elapsed time, so typing and redraws cannot expose the ghost.
  function codexCursorIsAfterFolder(rec) {
    try {
      const buffer = rec.term.buffer.active;
      const line = buffer.getLine(buffer.cursorY)?.translateToString(true) || "";
      const folder = paneFolderName(rec).trim();
      if (!folder) return false;
      const folderEnd = line.toLocaleLowerCase().lastIndexOf(folder.toLocaleLowerCase()) + folder.length;
      return folderEnd >= folder.length &&
        buffer.cursorX >= folderEnd &&
        buffer.cursorX - folderEnd <= 4;
    } catch {
      return false;
    }
  }

  function updateCursorQuietFor(rec, now = Date.now()) {
    const source = paneSource(rec);
    const hasCodexState = source === "codex" &&
      typeof rec.session?.working === "boolean";
    const quiet = source === "codex"
      ? (hasCodexState && rec.session.working) || codexCursorIsAfterFolder(rec)
      : isAgentPane(rec) &&
        now - rec.lastDataAt < 1600 &&
        now - rec.lastKeyAt > 1000;
    if (rec.cursorQuiet === quiet) return;
    rec.cursorQuiet = quiet;
    rec.el.classList.toggle("cursor-quiet", quiet);
    // The CSS rule above only reaches the DOM renderer's .xterm-cursor element.
    // The WebGL renderer paints the cursor into its canvas — verified: 0
    // .xterm-cursor elements under WebGL, 1 under the DOM renderer — so the
    // only way to suppress a parked cursor there is to make it transparent in
    // the palette. Applied on transitions only; a per-frame theme write would
    // rebuild the glyph atlas.
    if (!rec.webgl) return;
    const base = paneTermTheme(currentThemeId, rec.runtimeHint);
    rec.term.options.theme = quiet
      ? { ...base, cursor: "#00000000", cursorAccent: "#00000000" }
      : base;
  }

  function updateCursorQuiet() {
    const now = Date.now();
    for (const rec of panes.values()) updateCursorQuietFor(rec, now);
  }
  setInterval(updateCursorQuiet, 250);

  // ------------------------------------------------------- benchmark ----
  // Exists only under --perf-selftest (?bench=1). It writes a synthetic
  // Codex-style full-screen repaint straight into xterm, bypassing the PTY, so
  // the number measures the text renderer and not the shell. Frames are paced
  // at a fixed rate so both renderers do identical work and the difference
  // shows up as CPU, which is what the user actually feels.
  if (QUERY.get("bench") === "1") {
    // Paints a fixed payload shaped like Codex's banner: a box-drawn frame,
    // background-coloured spans, block glyphs and dim/bold text. Screenshotting
    // this under each renderer is what turns "the text looks funny" into a
    // reproducible diff.
    window.__nexoProbe = () => {
      const rec = focused || [...panes.values()][0];
      if (!rec) return null;
      return {
        webglActive: !!rec.webgl,
        background: rec.term.options.theme?.background ?? null,
        allowTransparency: rec.term.options.allowTransparency,
        minimumContrastRatio: rec.term.options.minimumContrastRatio,
        customGlyphs: rec.term.options.customGlyphs,
      };
    };

    window.__nexoPaint = () => {
      const rec = focused || [...panes.values()][0];
      if (!rec) return false;
      const L = [
        "\x1b[2J\x1b[H",
        "\x1b[90m┌────────────────────────────────────────────┐\x1b[0m",
        "\x1b[90m│\x1b[0m \x1b[1m>_ OpenAI Codex\x1b[0m \x1b[90m(v0.147.0)\x1b[0m              \x1b[90m│\x1b[0m",
        "\x1b[90m│\x1b[0m                                            \x1b[90m│\x1b[0m",
        "\x1b[90m│\x1b[0m model:     \x1b[47m\x1b[30m gpt-5.6-sol high \x1b[0m \x1b[46m\x1b[30m /model \x1b[0m   \x1b[90m│\x1b[0m",
        "\x1b[90m│\x1b[0m directory: \x1b[36m~\x1b[0m                                \x1b[90m│\x1b[0m",
        "\x1b[90m└────────────────────────────────────────────┘\x1b[0m",
        "",
        "box:    ┌─┬─┐ ├─┼─┤ └─┴─┘ ╔═╦═╗ ║ ╚═╩═╝",
        "blocks: ███ ▀▀▀ ▄▄▄ ░▒▓ ▌▐",
        "bg:     \x1b[41m red \x1b[42m green \x1b[44m blue \x1b[0m plain",
        "dim:    \x1b[2mdimmed\x1b[0m \x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m \x1b[7mreverse\x1b[0m",
        "faint:  \x1b[38;5;240mlow contrast grey on the well\x1b[0m",
      ];
      rec.term.write(L.join("\r\n"));
      return true;
    };

    window.__nexoBench = (durationMs = 8000, fps = 30, warmupMs = 2500) =>
      new Promise((resolve) => {
        const rec = focused || [...panes.values()][0];
        if (!rec) {
          resolve({ error: "no pane" });
          return;
        }
        // Pin the grid: xterm fits to slightly different column counts with and
        // without the DOM renderer's scrollbar, and comparing renderers on
        // different cell counts is not a comparison.
        const cols = 120;
        const rows = 36;
        try { rec.term.resize(cols, rows); } catch {}
        // One frame = home the cursor, repaint every row in colour, erase to
        // end of line. That is the shape of a full TUI redraw.
        const palette = [31, 32, 33, 34, 35, 36, 37, 91, 92, 93, 94, 96];
        const frames = [];
        for (let f = 0; f < 12; f++) {
          let out = "\x1b[H";
          for (let y = 0; y < rows; y++) {
            const color = palette[(y + f) % palette.length];
            const body = `row ${String(y).padStart(3, "0")} │ codex repaint `
              .repeat(40)
              .slice(0, Math.max(0, cols - 2));
            out += `\x1b[${color}m${body}\x1b[0m\x1b[K${y < rows - 1 ? "\r\n" : ""}`;
          }
          frames.push(out);
        }
        const interval = 1000 / fps;
        let written = 0;
        let rendered = 0;
        // The WebGL renderer compiles shaders and builds its glyph atlas on the
        // first frames. Measuring that as steady-state cost would be a lie, so
        // the run is warmed up first and the clock starts afterwards.
        let measuring = false;
        let measureStart = 0;
        const off = rec.term.onRender(() => {
          if (measuring) rendered++;
        });
        const start = performance.now();
        let next = start;
        const pump = () => {
          const now = performance.now();
          if (!measuring && now - start >= warmupMs) {
            measuring = true;
            measureStart = now;
            written = 0;
            // Hand the CPU-time baseline to main only once the clock starts.
            window.__nexoBenchMeasuringAt = Date.now();
          }
          if (measuring && now - measureStart >= durationMs) {
            off.dispose();
            const seconds = (performance.now() - measureStart) / 1000;
            resolve({
              renderer: rec.webgl ? "webgl" : "dom",
              requested: RENDERER_MODE,
              cols,
              rows,
              seconds: Number(seconds.toFixed(2)),
              framesWritten: written,
              framesPerSec: Number((written / seconds).toFixed(1)),
              rendersPerSec: Number((rendered / seconds).toFixed(1)),
            });
            return;
          }
          rec.term.write(frames[written % frames.length], () => {
            written++;
            next += interval;
            setTimeout(pump, Math.max(0, next - performance.now()));
          });
        };
        pump();
      });
  }
})();
