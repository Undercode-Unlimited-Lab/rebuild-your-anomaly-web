/**
 * Swarm Rebuild - content script.
 *
 * The extension takes a snapshot of the current page, puts it inside a
 * sandboxed preview frame, hides every element, and then "rebuilds" the page
 * with a swarm of multiplayer cursors. The real page is never modified.
 *
 * Everything below runs locally in the tab. There are no network requests,
 * analytics, storage, or external dependencies.
 */
(() => {
  // Re-injecting the content script while the overlay is open toggles it off.
  if (window.__swarmRebuild) {
    window.__swarmRebuild.toggle();
    return;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_CURSORS = 14;
  const INITIAL_CURSORS = 8;

  const COLORS = [
    "#f43f5e",
    "#3b82f6",
    "#22c55e",
    "#f59e0b",
    "#a855f7",
    "#06b6d4",
    "#ef4444",
    "#8b5cf6",
    "#10b981",
    "#f97316",
    "#eab308",
    "#14b8a6",
    "#ec4899",
    "#6366f1",
  ];

  const NAMES = [
    "Ava",
    "Leo",
    "Mia",
    "Noah",
    "Zoe",
    "Kai",
    "Ivy",
    "Max",
    "Luna",
    "Eli",
    "Nia",
    "Theo",
    "Sage",
    "Remy",
  ];

  const REMOVE_TAGS = new Set([
    "script",
    "noscript",
    "iframe",
    "object",
    "embed",
    "audio",
    "base",
    "applet",
    "frame",
    "frameset",
  ]);

  const MEDIA_TAGS = new Set(["img", "svg", "video", "canvas", "picture"]);

  const TEXT_TAGS = new Set([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "a",
    "button",
    "li",
    "span",
    "label",
    "blockquote",
    "figcaption",
    "td",
    "th",
    "dt",
    "dd",
    "summary",
    "small",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "code",
    "pre",
    "time",
    "cite",
    "abbr",
    "mark",
    "output",
  ]);

  const BOX_TAGS = new Set([
    "section",
    "article",
    "header",
    "nav",
    "footer",
    "aside",
    "main",
    "form",
    "ul",
    "ol",
    "table",
    "thead",
    "tbody",
    "tr",
    "figure",
    "fieldset",
    "dialog",
  ]);

  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "link",
    "meta",
    "title",
    "base",
    "option",
    "optgroup",
    "source",
    "track",
    "param",
    "datalist",
    "br",
    "wbr",
    "head",
    "html",
    "body",
  ]);

  // ---------------------------------------------------------------- state
  let speed = 1;
  let destroyed = false;
  let state = "starting";
  let touring = false;
  let gathering = false;
  let building = false;
  let buildGeneration = 0;
  let mouseX = 0;
  let mouseY = 0;
  let rafId = 0;
  let tourRaf = 0;
  let scrollRaf = 0;
  let lastTime = 0;
  let tourLast = 0;
  let lastEnqueue = 0;
  let lastCall = 0;
  let refreshTimer = 0;
  let toastTimer = 0;
  let uiHidden = false;

  let host;
  let shadow;
  let overlay;
  let iframe;
  let shield;
  let toast;
  let progressBar;
  let countEl;
  let tourBtn;
  let cursorHost;
  let cursorShadow;
  let effectsLayer;
  let cursorLayer;
  let frameDoc;
  let frameWin;
  let scroller;
  let observer;

  let targets = [];
  let targetSet = new WeakSet();
  let queue = [];
  let builtSet = new WeakSet();
  let cursors = [];
  let styleBackup = new WeakMap();
  let visibilityStyles = [];
  let freezeStyles = [];
  let logoElement = null;
  let gatherGeneration = 0;

  const originalScroll = { x: window.scrollX, y: window.scrollY };
  const originalScroller = findMainScroller(document, window);
  const originalScrollerTop = originalScroller ? originalScroller.scrollTop : 0;
  const originalScrollerLeft = originalScroller ? originalScroller.scrollLeft : 0;
  const originalCanvases = deepQueryAll(document, "canvas");
  const originalImages = deepQueryAll(document, "img");
  const originalFields = deepQueryAll(document, "input, textarea, select");

  // ------------------------------------------------------------- utilities
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / speed)));
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function tween(duration, onUpdate, easing = easeOutCubic) {
    return new Promise((resolve) => {
      if (destroyed) {
        resolve();
        return;
      }
      const generation = buildGeneration;
      let progress = 0;
      let last = performance.now();
      const frame = (now) => {
        if (destroyed || generation !== buildGeneration) {
          resolve();
          return;
        }
        const dt = Math.min(64, Math.max(0, now - last));
        last = now;
        progress += (dt / Math.max(1, duration)) * speed;
        if (progress >= 1) {
          onUpdate(easing(1));
          resolve();
          return;
        }
        onUpdate(easing(progress));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  function deepQueryAll(root, selector) {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) {
        out.push(...deepQueryAll(el.shadowRoot, selector));
      }
    }
    return out;
  }

  function findMainScroller(doc, win) {
    const root = doc.scrollingElement || doc.documentElement;
    if (root && root.scrollHeight > root.clientHeight + 2) {
      return root;
    }
    const candidates = [...doc.querySelectorAll("*")].filter((el) => {
      const cs = win.getComputedStyle(el);
      return (
        /(auto|scroll)/.test(cs.overflowY) &&
        el.scrollHeight > el.clientHeight + 2
      );
    });
    candidates.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
    );
    return candidates[0] || root;
  }

  function getPageBackground() {
    const body = getComputedStyle(document.body);
    const html = getComputedStyle(document.documentElement);
    const pick = (color) =>
      color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent"
        ? color
        : null;
    return pick(body.backgroundColor) || pick(html.backgroundColor) || "#ffffff";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------- clone helpers
  function cloneNodeDeep(node) {
    const clone = node.cloneNode(false);
    if (node.shadowRoot) {
      const shadowRoot = clone.attachShadow({ mode: node.shadowRoot.mode });
      for (const child of node.shadowRoot.childNodes) {
        shadowRoot.appendChild(cloneNodeDeep(child));
      }
    }
    for (const child of node.childNodes) {
      clone.appendChild(cloneNodeDeep(child));
    }
    return clone;
  }

  function sanitizeClone(root) {
    const elements = [...root.querySelectorAll("*")];
    for (const el of elements) {
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (REMOVE_TAGS.has(tag)) {
        el.remove();
        continue;
      }
      if (tag === "link") {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        if (
          rel === "preload" ||
          rel === "prefetch" ||
          rel === "modulepreload" ||
          rel === "prerender"
        ) {
          el.remove();
          continue;
        }
      }
      if (tag === "meta") {
        const httpEquiv = (el.getAttribute("http-equiv") || "").toLowerCase();
        if (
          httpEquiv === "content-security-policy" ||
          httpEquiv === "refresh"
        ) {
          el.remove();
          continue;
        }
      }
      if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") {
        el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = (attr.value || "").trim().toLowerCase();
        if (name.startsWith("on") || value.startsWith("javascript:")) {
          el.removeAttribute(attr.name);
        }
      }
      if (el.shadowRoot) {
        sanitizeClone(el.shadowRoot);
      }
    }
  }

  function buildClone() {
    const clone = cloneNodeDeep(document.documentElement);
    sanitizeClone(clone);

    let head = clone.querySelector("head");
    if (!head) {
      head = clone.ownerDocument.createElement("head");
      clone.insertBefore(head, clone.firstChild);
    }
    for (const base of clone.querySelectorAll("base")) {
      base.remove();
    }
    const base = clone.ownerDocument.createElement("base");
    base.href = location.href;
    head.insertBefore(base, head.firstChild);

    return clone;
  }

  // -------------------------------------------------------------- overlay
  const OVERLAY_CSS = `
    :host {
      all: initial;
    }
    * {
      box-sizing: border-box;
    }
    .sr-overlay {
      position: fixed;
      inset: 0;
      overflow: hidden;
      background: var(--sr-bg, #fff);
      opacity: 0;
      transition: opacity 350ms ease;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    .sr-overlay.is-in {
      opacity: 1;
    }
    .sr-overlay.is-leaving {
      opacity: 0;
    }
    .sr-frame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      background: transparent;
      opacity: 0;
      transition: opacity 220ms ease;
      pointer-events: none;
    }
    .sr-overlay.is-ready .sr-frame {
      opacity: 1;
    }
    .sr-shield {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      cursor: default;
    }
    .sr-ui {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 220ms ease;
    }
    .sr-overlay.is-ready .sr-ui {
      opacity: 1;
    }
    .sr-brand {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 13px 8px 14px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.84);
      color: #fff;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.22);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      white-space: nowrap;
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
    }
    .sr-brand-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #f472b6;
      box-shadow: 0 0 0 4px rgba(244, 114, 182, 0.18);
    }
    .sr-brand-title {
      font-weight: 750;
    }
    .sr-brand-count {
      color: #cbd5e1;
      font-weight: 500;
    }
    .sr-progress {
      width: 76px;
      height: 3px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      overflow: hidden;
    }
    .sr-progress > i {
      display: block;
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #f472b6, #22d3ee);
      transition: width 240ms ease;
    }
    .sr-toolbar {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 4px;
      max-width: calc(100vw - 24px);
      padding: 6px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.18);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      pointer-events: auto;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .sr-btn {
      appearance: none;
      border: 0;
      background: transparent;
      color: #0f172a;
      font: 600 12px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 9px 10px;
      border-radius: 9px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 150ms ease, color 150ms ease, transform 100ms ease, filter 150ms ease;
    }
    .sr-btn:hover {
      background: #f1f5f9;
    }
    .sr-btn:active {
      transform: scale(0.96);
    }
    .sr-btn:focus-visible {
      outline: 2px solid #6366f1;
      outline-offset: 2px;
    }
    .sr-btn.active {
      background: #0f172a;
      color: #fff;
    }
    .sr-btn.live {
      background: linear-gradient(135deg, #6366f1, #ec4899);
      color: #fff;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);
    }
    .sr-btn.live:hover {
      background: linear-gradient(135deg, #6366f1, #ec4899);
      filter: brightness(1.06);
    }
    .sr-btn.icon {
      width: 32px;
      height: 32px;
      padding: 0;
      display: grid;
      place-items: center;
      font-size: 16px;
    }
    .sr-sep {
      width: 1px;
      height: 18px;
      margin: 0 2px;
      background: rgba(15, 23, 42, 0.1);
    }
    .sr-toast {
      position: absolute;
      left: 50%;
      bottom: 82px;
      transform: translateX(-50%) translateY(6px);
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.9);
      color: #fff;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.2);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .sr-toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .sr-overlay.ui-hidden .sr-brand,
    .sr-overlay.ui-hidden .sr-toolbar,
    .sr-overlay.ui-hidden .sr-toast {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .sr-overlay.ui-hidden .sr-brand {
      transform: translateX(-50%) translateY(-8px);
    }
    .sr-overlay.ui-hidden .sr-toolbar {
      transform: translateX(-50%) translateY(8px);
    }
  `;

  const CURSOR_CSS = `
    .sr-effects,
    .sr-cursors {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      overflow: visible;
      pointer-events: none;
    }
    .sr-effects {
      z-index: 1;
    }
    .sr-cursors {
      z-index: 2;
    }
    .sr-cursor {
      position: absolute;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      pointer-events: none;
      will-change: transform;
      z-index: 10;
      transition: opacity 160ms ease;
    }
    .sr-cursor-arrow {
      position: absolute;
      top: 0;
      left: 0;
      width: 22px;
      height: 22px;
      overflow: visible;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.32));
      transition: transform 140ms ease;
    }
    .sr-cursor-arrow path {
      fill: var(--c);
      stroke: #fff;
      stroke-width: 1.4;
      stroke-linejoin: round;
    }
    .sr-cursor-name {
      position: absolute;
      top: 16px;
      left: 16px;
      padding: 3px 7px;
      border-radius: 999px;
      background: var(--c);
      color: #fff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
      font: 600 10px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.01em;
      white-space: nowrap;
      opacity: 0.94;
    }
    .sr-cursor.is-active .sr-cursor-arrow {
      transform: scale(1.08);
    }
    .sr-cursor.is-active .sr-cursor-name {
      opacity: 1;
      box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.38), 0 2px 8px rgba(0, 0, 0, 0.22);
    }
    .sr-cursor.sr-joined .sr-cursor-arrow,
    .sr-cursor.sr-joined .sr-cursor-name {
      animation: sr-joined 620ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .sr-cursor.sr-excited .sr-cursor-arrow {
      animation: sr-excited 320ms ease;
    }
    @keyframes sr-joined {
      0% { opacity: 0; transform: scale(0.4); }
      100% { opacity: 1; transform: scale(1); }
    }
    @keyframes sr-excited {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.22); }
    }
    .sr-selection {
      position: absolute;
      border: 1.5px solid var(--c);
      border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7), 0 0 16px var(--c);
      pointer-events: none;
    }
    .sr-selection.sr-dragging {
      border-style: dashed;
    }
    .sr-size-badge {
      position: absolute;
      top: -25px;
      left: -1px;
      padding: 3px 6px;
      border-radius: 4px;
      background: #0f172a;
      color: #fff;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      font: 600 10px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
    }
    .sr-handle {
      position: absolute;
      width: 6px;
      height: 6px;
      border: 1.5px solid var(--c);
      border-radius: 1px;
      background: #fff;
    }
    .sr-handle.tl { left: -4px; top: -4px; }
    .sr-handle.tr { right: -4px; top: -4px; }
    .sr-handle.bl { left: -4px; bottom: -4px; }
    .sr-handle.br { right: -4px; bottom: -4px; }
    .sr-draw-svg,
    .sr-guide-svg {
      position: absolute;
      overflow: visible;
      pointer-events: none;
    }
    .sr-caret {
      position: absolute;
      width: 2px;
      border-radius: 1px;
      background: var(--c);
      box-shadow: 0 0 8px var(--c);
      animation: sr-blink 1s steps(1) infinite;
    }
    @keyframes sr-blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }
    .sr-ghost {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      padding: 8px;
      border: 1.5px dashed var(--c);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.84);
      color: #0f172a;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.14);
      font: 600 11px/1.3 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
      pointer-events: none;
    }
    .sr-alt-badge {
      position: absolute;
      top: -10px;
      left: -10px;
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--c);
      color: #fff;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      font-size: 11px;
      font-weight: 700;
    }
    .sr-pulse {
      position: absolute;
      border: 2px solid var(--c);
      border-radius: 50%;
      pointer-events: none;
      animation: sr-pulse 620ms ease-out forwards;
    }
    @keyframes sr-pulse {
      0% { opacity: 0.85; transform: scale(0.2); }
      100% { opacity: 0; transform: scale(1.7); }
    }
    .sr-gather-ring {
      position: absolute;
      width: 28px;
      height: 28px;
      margin-left: -14px;
      margin-top: -14px;
      border: 2px solid var(--c);
      border-radius: 50%;
      pointer-events: none;
      animation: sr-gather 900ms ease-out infinite;
    }
    @keyframes sr-gather {
      0% { opacity: 0.9; transform: scale(0.4); }
      100% { opacity: 0; transform: scale(2.4); }
    }
    .sr-guide-label {
      position: absolute;
      padding: 2px 5px;
      border-radius: 3px;
      background: #0f172a;
      color: #fff;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22);
      font: 600 9px/1.2 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
      pointer-events: none;
    }
  `;

  function createOverlay() {
    host = document.createElement("div");
    host.id = "swarm-rebuild-host";
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;";

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="sr-overlay" style="--sr-bg:${escapeHtml(getPageBackground())}">
        <iframe class="sr-frame" title="Swarm Rebuild preview" sandbox="allow-same-origin"></iframe>
        <div class="sr-shield"></div>
        <div class="sr-ui">
          <div class="sr-brand">
            <span class="sr-brand-dot"></span>
            <span class="sr-brand-title">Swarm Rebuild</span>
            <span class="sr-brand-count">0 agents</span>
            <span class="sr-progress"><i></i></span>
          </div>
          <div class="sr-toolbar">
            <button class="sr-btn" type="button" data-action="tour" title="Auto-scroll at the swarm's pace (T)">Tour</button>
            <span class="sr-sep"></span>
            <button class="sr-btn speed active" type="button" data-speed="1" title="Build speed 1x (1)">1×</button>
            <button class="sr-btn speed" type="button" data-speed="2" title="Build speed 2x (2)">2×</button>
            <button class="sr-btn speed" type="button" data-speed="3" title="Build speed 3x (3)">3×</button>
            <span class="sr-sep"></span>
            <button class="sr-btn" type="button" data-action="replay" title="Replay (R)">Replay</button>
            <button class="sr-btn live" type="button" data-action="live" title="Go live (L)">Go live</button>
            <button class="sr-btn" type="button" data-action="hide" title="Hide UI (H)">Hide</button>
            <button class="sr-btn icon" type="button" data-action="exit" title="Exit (Esc)" aria-label="Exit">×</button>
          </div>
          <div class="sr-toast" role="status" aria-live="polite"></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);

    overlay = shadow.querySelector(".sr-overlay");
    iframe = shadow.querySelector(".sr-frame");
    shield = shadow.querySelector(".sr-shield");
    toast = shadow.querySelector(".sr-toast");
    progressBar = shadow.querySelector(".sr-progress > i");
    countEl = shadow.querySelector(".sr-brand-count");
    tourBtn = shadow.querySelector('[data-action="tour"]');

    iframe.setAttribute(
      "csp",
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src 'none'; base-uri *;"
    );

    requestAnimationFrame(() => overlay.classList.add("is-in"));
  }

  async function loadPreview() {
    const loadPromise = new Promise((resolve) => {
      iframe.addEventListener("load", resolve, { once: true });
    });

    iframe.srcdoc =
      "<!doctype html><html><head></head><body></body></html>";
    await loadPromise;
    if (destroyed) return;

    frameDoc = iframe.contentDocument;
    frameWin = iframe.contentWindow;

    if (!frameDoc || !frameDoc.documentElement || !frameDoc.body) {
      throw new Error("Preview frame did not load");
    }

    const clone = buildClone();
    const adopted = frameDoc.adoptNode(clone);
    frameDoc.replaceChild(adopted, frameDoc.documentElement);

    copyLiveState();

    // Wait for the cloned stylesheets, images, and fonts to settle.
    await waitForPreviewResources(frameDoc, 1600);
    if (destroyed) return;

    scroller = findMainScroller(frameDoc, frameWin);

    // Restore the page's scroll position as closely as possible.
    if (scroller) {
      scroller.scrollTop = originalScrollerTop;
      scroller.scrollLeft = originalScrollerLeft;
    }
    try {
      frameWin.scrollTo(originalScroll.x, originalScroll.y);
    } catch {
      // Ignore cross-origin or sandboxed scroll failures.
    }

    await new Promise((resolve) =>
      frameWin.requestAnimationFrame(() => frameWin.requestAnimationFrame(resolve))
    );

    injectHideStyles();
    createCursorLayer();

    mouseX = frameWin.innerWidth / 2;
    mouseY = frameWin.innerHeight / 2;
  }

  async function waitForPreviewResources(doc, timeout) {
    const links = deepQueryAll(doc, 'link[rel="stylesheet"]');
    await Promise.race([
      Promise.all(
        links.map((link) =>
          link.sheet
            ? Promise.resolve()
            : new Promise((resolve) => {
                link.addEventListener("load", resolve, { once: true });
                link.addEventListener("error", resolve, { once: true });
              })
        )
      ),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);

    const images = deepQueryAll(doc, "img");
    await Promise.race([
      Promise.all(
        images.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                img.addEventListener("load", resolve, { once: true });
                img.addEventListener("error", resolve, { once: true });
              })
        )
      ),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);

    try {
      await Promise.race([
        doc.fonts ? doc.fonts.ready : Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    } catch {
      // Fonts are a nice-to-have.
    }

    // Give layout two frames to settle after the document swap.
    await new Promise((resolve) =>
      frameWin.requestAnimationFrame(() => frameWin.requestAnimationFrame(resolve))
    );
  }

  function copyLiveState() {
    const cloneCanvases = deepQueryAll(frameDoc, "canvas");
    originalCanvases.forEach((source, index) => {
      const target = cloneCanvases[index];
      if (!target) return;
      try {
        target.width = source.width;
        target.height = source.height;
        const context = target.getContext("2d");
        if (context) context.drawImage(source, 0, 0);
      } catch {
        // Cross-origin or WebGL canvases may not be copyable.
      }
    });

    const cloneImages = deepQueryAll(frameDoc, "img");
    originalImages.forEach((source, index) => {
      const target = cloneImages[index];
      if (!target) return;
      if (source.currentSrc && target.src !== source.currentSrc) {
        target.src = source.currentSrc;
      }
      if (source.srcset) target.srcset = source.srcset;
      if (source.sizes) target.sizes = source.sizes;
      target.loading = "lazy";
      target.decoding = "async";
    });

    const cloneFields = deepQueryAll(frameDoc, "input, textarea, select");
    originalFields.forEach((source, index) => {
      const target = cloneFields[index];
      if (!target) return;
      try {
        if (
          source.tagName === "INPUT" &&
          (source.type === "checkbox" || source.type === "radio")
        ) {
          target.checked = source.checked;
        } else {
          target.value = source.value;
        }
      } catch {
        // Some custom elements may reject direct value writes.
      }
    });

    deepQueryAll(frameDoc, "video").forEach((video) => {
      video.removeAttribute("autoplay");
      try {
        video.pause();
      } catch {
        // Ignore.
      }
    });
  }

  function injectHideStyles() {
    visibilityStyles = [];
    freezeStyles = [];

    const nonceSource = document.querySelector("[nonce]");
    const nonce = nonceSource
      ? nonceSource.getAttribute("nonce") || nonceSource.nonce
      : "";

    const visibilityCss = `
      html {
        scroll-behavior: auto !important;
      }
      body * {
        visibility: hidden !important;
      }
      .sr-show,
      .sr-show-tree,
      .sr-show-shadow {
        visibility: visible !important;
      }
      .sr-show-tree,
      .sr-show-tree * {
        visibility: visible !important;
      }
    `;
    const freezeCss = `
      *,
      *::before,
      *::after {
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        transition-duration: 0.001s !important;
        transition-delay: 0s !important;
      }
    `;

    const visibilityStyle = frameDoc.createElement("style");
    visibilityStyle.textContent = visibilityCss;
    if (nonce) visibilityStyle.setAttribute("nonce", nonce);
    frameDoc.head.appendChild(visibilityStyle);
    visibilityStyles.push(visibilityStyle);

    const freezeStyle = frameDoc.createElement("style");
    freezeStyle.textContent = freezeCss;
    if (nonce) freezeStyle.setAttribute("nonce", nonce);
    frameDoc.head.appendChild(freezeStyle);
    freezeStyles.push(freezeStyle);

    const shadowVisibilityCss = `
      :host * {
        visibility: hidden !important;
      }
      :host(.sr-show-tree) *,
      :host(.sr-show-shadow) *,
      .sr-show,
      .sr-show *,
      .sr-show-tree,
      .sr-show-tree *,
      .sr-show-shadow,
      .sr-show-shadow * {
        visibility: visible !important;
      }
    `;

    for (const el of deepQueryAll(frameDoc, "*")) {
      if (!el.shadowRoot) continue;
      const shadowVisibility = frameDoc.createElement("style");
      shadowVisibility.textContent = shadowVisibilityCss;
      if (nonce) shadowVisibility.setAttribute("nonce", nonce);
      el.shadowRoot.appendChild(shadowVisibility);
      visibilityStyles.push(shadowVisibility);

      const shadowFreeze = frameDoc.createElement("style");
      shadowFreeze.textContent = freezeCss;
      if (nonce) shadowFreeze.setAttribute("nonce", nonce);
      el.shadowRoot.appendChild(shadowFreeze);
      freezeStyles.push(shadowFreeze);
    }
  }

  function setVisibilityStylesEnabled(enabled) {
    for (const style of visibilityStyles) {
      if (style) style.disabled = !enabled;
    }
  }

  function createCursorLayer() {
    cursorHost = frameDoc.createElement("div");
    cursorHost.id = "sr-cursor-host";
    cursorHost.style.cssText =
      "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    frameDoc.documentElement.appendChild(cursorHost);

    cursorShadow = cursorHost.attachShadow({ mode: "open" });
    cursorShadow.innerHTML = `
      <style>${CURSOR_CSS}</style>
      <div class="sr-effects"></div>
      <div class="sr-cursors"></div>
    `;
    effectsLayer = cursorShadow.querySelector(".sr-effects");
    cursorLayer = cursorShadow.querySelector(".sr-cursors");
  }

  // --------------------------------------------------------------- targets
  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim()) {
        return true;
      }
    }
    return false;
  }

  function isActuallyVisible(el, win) {
    const cs = win.getComputedStyle(el);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.visibility === "collapse" ||
      parseFloat(cs.opacity) < 0.05
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function isBoxLike(el, cs) {
    const background =
      (cs.backgroundColor &&
        cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        cs.backgroundColor !== "transparent") ||
      (cs.backgroundImage && cs.backgroundImage !== "none");
    const border = ["Top", "Right", "Bottom", "Left"].some(
      (side) =>
        parseFloat(cs[`border${side}Width`]) > 0 &&
        cs[`border${side}Style`] !== "none"
    );
    const shadow = cs.boxShadow && cs.boxShadow !== "none";
    const tag = el.tagName.toLowerCase();
    return background || border || shadow || (BOX_TAGS.has(tag) && el.children.length > 0);
  }

  function collectTargets(doc, win) {
    const out = [];
    if (!doc.body) return out;
    const textRoots = new WeakSet();
    const all = [...doc.body.querySelectorAll("*")];

    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") {
        continue;
      }
      if (el.closest("svg") && tag !== "svg") continue;
      if (el.closest("picture") && tag !== "img") continue;
      if (el.closest("canvas") && tag !== "canvas") continue;
      if (!isActuallyVisible(el, win)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) continue;
      if (rect.width > win.innerWidth * 3 && rect.height > win.innerHeight * 3) {
        continue;
      }

      let ancestor = el.parentElement;
      let insideTextRoot = false;
      while (ancestor) {
        if (textRoots.has(ancestor)) {
          insideTextRoot = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (insideTextRoot) continue;

      const cs = win.getComputedStyle(el);
      const media = MEDIA_TAGS.has(tag);
      const hasShadow = !!el.shadowRoot;
      const directText = hasDirectText(el);
      const textTag = TEXT_TAGS.has(tag);
      const box = isBoxLike(el, cs);

      let kind = null;
      if (media) kind = "media";
      else if (hasShadow) kind = "box";
      else if (textTag && directText) kind = "text";
      else if (box) kind = "box";
      else if (directText) kind = "text";
      if (!kind) continue;

      if (kind === "text") textRoots.add(el);
      out.push({ el, kind, isLogo: false, queued: false, building: false });
    }

    if (doc.body.shadowRoot) {
      out.push({
        el: doc.body,
        kind: "box",
        isLogo: false,
        queued: false,
        building: false,
      });
    }
    if (doc.documentElement && doc.documentElement.shadowRoot) {
      out.push({
        el: doc.documentElement,
        kind: "box",
        isLogo: false,
        queued: false,
        building: false,
      });
    }

    return out;
  }

  function findLogo(doc, win) {
    const selectors = [
      'header img',
      'nav img',
      '[class*="logo" i] img',
      '[id*="logo" i] img',
      'img[alt*="logo" i]',
      'a[href="/"] img',
      'a[href*="home" i] img',
      "header svg",
      "nav svg",
      '[class*="logo" i]',
      '[id*="logo" i]',
    ];

    for (const selector of selectors) {
      for (const el of doc.querySelectorAll(selector)) {
        if (isActuallyVisible(el, win)) return el;
      }
    }

    const images = [...doc.images].filter((img) => isActuallyVisible(img, win));
    images.sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
    );
    return images[0] || null;
  }

  function refreshTargets() {
    if (!frameDoc || destroyed) return;
    let added = false;

    setVisibilityStylesEnabled(false);
    try {
      const fresh = collectTargets(frameDoc, frameWin);

      for (const task of fresh) {
        if (!targetSet.has(task.el)) {
          targetSet.add(task.el);
          targets.push(task);
          added = true;
        }
      }

      const logo = findLogo(frameDoc, frameWin);
      logoElement = logo;
      if (logo) {
        let logoTask = targets.find((task) => task.el === logo);
        if (!logoTask) {
          const tag = logo.tagName.toLowerCase();
          logoTask = {
            el: logo,
            kind: MEDIA_TAGS.has(tag)
              ? "media"
              : hasDirectText(logo)
              ? "text"
              : "box",
            isLogo: true,
            queued: false,
            building: false,
          };
          targets.push(logoTask);
          targetSet.add(logo);
          added = true;
        } else {
          logoTask.isLogo = true;
        }
      }
    } finally {
      setVisibilityStylesEnabled(true);
    }

    if (added) updateProgress();
  }

  function isVisibleInViewport(el, margin = 120) {
    if (!frameWin) return false;
    const rect = el.getBoundingClientRect();
    const height = frameWin.innerHeight;
    const width = frameWin.innerWidth;
    return (
      rect.width > 2 &&
      rect.height > 2 &&
      rect.bottom >= -margin &&
      rect.top <= height + margin &&
      rect.right >= -margin &&
      rect.left <= width + margin
    );
  }

  function getDocPoint(rect, xFraction = 0, yFraction = 0) {
    return {
      x: rect.left + rect.width * xFraction + frameWin.scrollX,
      y: rect.top + rect.height * yFraction + frameWin.scrollY,
    };
  }

  // ---------------------------------------------------------------- cursors
  function createCursor(index) {
    const color = COLORS[index % COLORS.length];
    const baseName = NAMES[index % NAMES.length];
    const name =
      index < NAMES.length
        ? baseName
        : `${baseName} ${Math.floor(index / NAMES.length) + 1}`;

    const el = frameDoc.createElement("div");
    el.className = "sr-cursor";
    el.style.setProperty("--c", color);
    el.innerHTML = `
      <svg class="sr-cursor-arrow" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M0 0 L18 9 L10 11 L6 19 Z"></path>
      </svg>
      <span class="sr-cursor-name">${escapeHtml(name)}</span>
    `;
    cursorLayer.appendChild(el);

    return {
      el,
      name,
      color,
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      active: false,
    };
  }

  function addCursor(announce = false) {
    if (cursors.length >= MAX_CURSORS) return null;
    const cursor = createCursor(cursors.length);
    cursor.el.classList.add("sr-joined");
    setTimeout(() => cursor.el.classList.remove("sr-joined"), 700);
    cursors.push(cursor);
    updateProgress();
    if (announce) showToast(`Agent ${cursor.name} joined`);
    return cursor;
  }

  function pickCursor(rect) {
    const target = getDocPoint(rect, 0.5, 0.5);
    let best = null;
    let bestScore = Infinity;
    for (const cursor of cursors) {
      if (cursor.active) continue;
      const distance = Math.hypot(cursor.x - target.x, cursor.y - target.y);
      const score = distance + Math.random() * 90;
      if (score < bestScore) {
        best = cursor;
        bestScore = score;
      }
    }
    return best;
  }

  function releaseCursor(cursor) {
    if (!cursor) return;
    cursor.active = false;
    cursor.el.classList.remove("is-active");
  }

  function waitForCursor(cursor, x, y, timeout) {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        if (destroyed) {
          resolve();
          return;
        }
        const distance = Math.hypot(cursor.x - x, cursor.y - y);
        if (distance < 26 || performance.now() - start > timeout) {
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  function flockCursors() {
    if (!frameWin || !cursors.length) return;
    const centerX = mouseX + frameWin.scrollX;
    const centerY = mouseY + frameWin.scrollY;
    const count = Math.max(1, cursors.length);
    for (let i = 0; i < cursors.length; i++) {
      const cursor = cursors[i];
      if (cursor.active) continue;
      const angle = (i / count) * Math.PI * 2 + 0.4;
      const radius = 38 + (i % 3) * 22;
      cursor.tx = centerX + Math.cos(angle) * radius;
      cursor.ty = centerY + Math.sin(angle) * radius;
    }
  }

  function cursorLoop(now) {
    if (destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const ease = Math.min(1, (0.16 + speed * 0.035) * (dt * 60));
    for (const cursor of cursors) {
      cursor.x += (cursor.tx - cursor.x) * ease;
      cursor.y += (cursor.ty - cursor.y) * ease;
      cursor.el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
    }
    rafId = requestAnimationFrame(cursorLoop);
  }

  // ---------------------------------------------------------------- effects
  function createEffect(className) {
    const el = frameDoc.createElement("div");
    el.className = className;
    effectsLayer.appendChild(el);
    return el;
  }

  function createSvg(className) {
    const svg = frameDoc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className);
    effectsLayer.appendChild(svg);
    return svg;
  }

  function removeEffect(el, delay = 0) {
    if (!el) return;
    if (delay) {
      setTimeout(() => el.remove(), delay);
    } else {
      el.remove();
    }
  }

  function showSelection(rect, color, label) {
    const el = createEffect("sr-selection");
    el.style.left = `${rect.left + frameWin.scrollX}px`;
    el.style.top = `${rect.top + frameWin.scrollY}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.setProperty("--c", color);
    el.innerHTML = `
      <span class="sr-size-badge">${escapeHtml(label)}</span>
      <i class="sr-handle tl"></i>
      <i class="sr-handle tr"></i>
      <i class="sr-handle bl"></i>
      <i class="sr-handle br"></i>
    `;
    return el;
  }

  async function dragOutBox(rect, color, label, cursor) {
    const selection = createEffect("sr-selection sr-dragging");
    selection.style.setProperty("--c", color);
    selection.innerHTML = `
      <span class="sr-size-badge">${escapeHtml(label)}</span>
      <i class="sr-handle tl"></i>
      <i class="sr-handle tr"></i>
      <i class="sr-handle bl"></i>
      <i class="sr-handle br"></i>
    `;
    const badge = selection.querySelector(".sr-size-badge");

    const startX = rect.left + frameWin.scrollX;
    const startY = rect.top + frameWin.scrollY;
    selection.style.left = `${startX}px`;
    selection.style.top = `${startY}px`;
    selection.style.width = "0px";
    selection.style.height = "0px";

    await tween(420, (progress) => {
      const width = Math.max(1, rect.width * progress);
      const height = Math.max(1, rect.height * progress);
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
      badge.textContent = `${Math.round(width)} × ${Math.round(height)}`;
      if (cursor) {
        cursor.tx = startX + width;
        cursor.ty = startY + height;
      }
    });

    badge.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    return selection;
  }

  function pointOnRect(rect, progress) {
    const width = rect.width;
    const height = rect.height;
    const perimeter = 2 * (width + height);
    let distance = progress * perimeter;
    let x;
    let y;

    if (distance < width) {
      x = rect.left + distance;
      y = rect.top;
    } else if (distance < width + height) {
      x = rect.left + width;
      y = rect.top + (distance - width);
    } else if (distance < 2 * width + height) {
      x = rect.left + width - (distance - width - height);
      y = rect.top + height;
    } else {
      x = rect.left;
      y = rect.top + height - (distance - 2 * width - height);
    }

    return {
      x: x + frameWin.scrollX,
      y: y + frameWin.scrollY,
    };
  }

  function backupStyle(el) {
    if (!styleBackup.has(el)) {
      styleBackup.set(el, {
        clipPath: el.style.clipPath,
        opacity: el.style.opacity,
        transform: el.style.transform,
        filter: el.style.filter,
        willChange: el.style.willChange,
      });
    }
  }

  function restoreInline(el) {
    const backup = styleBackup.get(el);
    if (!backup) return;
    el.style.clipPath = backup.clipPath;
    el.style.opacity = backup.opacity;
    el.style.transform = backup.transform;
    el.style.filter = backup.filter;
    el.style.willChange = backup.willChange;
  }

  function showSelf(el) {
    el.classList.add("sr-show");
  }

  function showTree(el) {
    el.classList.add("sr-show-tree");
    for (const node of deepQueryAll(el, "*")) {
      if (node.shadowRoot) node.classList.add("sr-show-tree");
    }
  }

  function showShadow(el) {
    el.classList.add("sr-show-shadow");
    for (const node of deepQueryAll(el, "*")) {
      if (node.shadowRoot) node.classList.add("sr-show-shadow");
    }
  }

  async function revealElement(el, kind) {
    const isRootShadow =
      el === (frameDoc && frameDoc.body) ||
      el === (frameDoc && frameDoc.documentElement);

    if (isRootShadow) {
      showShadow(el);
      return;
    }

    backupStyle(el);
    if (el.shadowRoot) {
      showTree(el);
    } else if (kind === "box") {
      showSelf(el);
    } else {
      showTree(el);
    }

    if (kind === "media") {
      el.style.opacity = "0";
      el.style.transform = "scale(0.97)";
      el.style.filter = "blur(6px)";
      el.style.willChange = "opacity, transform, filter";
      await tween(380, (progress) => {
        el.style.opacity = String(progress);
        el.style.transform = `scale(${0.97 + 0.03 * progress})`;
        el.style.filter = `blur(${6 * (1 - progress)}px)`;
      });
      restoreInline(el);
    } else {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.willChange = "opacity, transform";
      await tween(320, (progress) => {
        el.style.opacity = String(progress);
        el.style.transform = `translateY(${6 * (1 - progress)}px)`;
      });
      restoreInline(el);
    }
  }

  async function drawBorderAndFill(el, rect, cursor, kind) {
    const svg = createSvg("sr-draw-svg");
    svg.style.left = `${rect.left + frameWin.scrollX}px`;
    svg.style.top = `${rect.top + frameWin.scrollY}px`;
    svg.style.width = `${rect.width}px`;
    svg.style.height = `${rect.height}px`;

    const outline = frameDoc.createElementNS(SVG_NS, "rect");
    const width = Math.max(1, rect.width - 2);
    const height = Math.max(1, rect.height - 2);
    const perimeter = 2 * (width + height);
    outline.setAttribute("x", "1");
    outline.setAttribute("y", "1");
    outline.setAttribute("width", String(width));
    outline.setAttribute("height", String(height));
    outline.setAttribute("rx", String(Math.min(8, Math.min(width, height) * 0.08)));
    outline.setAttribute("fill", "none");
    outline.setAttribute("stroke", cursor.color);
    outline.setAttribute("stroke-width", "2");
    outline.setAttribute("stroke-linecap", "round");
    outline.setAttribute("stroke-dasharray", String(perimeter));
    outline.setAttribute("stroke-dashoffset", String(perimeter));
    svg.appendChild(outline);

    await tween(520, (progress) => {
      outline.setAttribute("stroke-dashoffset", String(perimeter * (1 - progress)));
      const point = pointOnRect(rect, progress);
      cursor.tx = point.x;
      cursor.ty = point.y;
    });

    svg.style.opacity = "0";
    svg.style.transition = "opacity 180ms ease";
    setTimeout(() => svg.remove(), 220);

    await revealElement(el, kind);
  }

  function getCaretRect(textNodes, charIndex) {
    if (!textNodes.length) return null;
    const total = textNodes.reduce((sum, entry) => sum + entry.length, 0);
    const index = Math.max(0, Math.min(charIndex, total));
    const range = frameDoc.createRange();
    const first = textNodes[0];
    range.setStart(first.node, 0);

    let remaining = index;
    let endNode = first.node;
    let endOffset = 0;
    for (const entry of textNodes) {
      if (remaining <= entry.length) {
        endNode = entry.node;
        endOffset = remaining;
        break;
      }
      remaining -= entry.length;
    }

    try {
      range.setEnd(endNode, endOffset);
      const rects = range.getClientRects();
      if (!rects.length) return null;
      for (let i = rects.length - 1; i >= 0; i--) {
        const rect = rects[i];
        if (rect.width > 0.5 && rect.height > 0.5) {
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        }
      }
      const rect = rects[rects.length - 1];
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    } catch {
      return null;
    }
  }

  async function typeText(el, rect, cursor) {
    const textNodes = [];
    const walker = frameDoc.createTreeWalker(el, 4); // NodeFilter.SHOW_TEXT
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.length) {
        textNodes.push({ node, length: node.textContent.length });
      }
    }

    const fullText = textNodes.map((entry) => entry.node.textContent).join("");
    if (!fullText.trim()) {
      await revealElement(el, "text");
      return;
    }

    const cs = frameWin.getComputedStyle(el);
    const isRtl = cs.direction === "rtl";
    const isVertical = String(cs.writingMode || "").startsWith("vertical");
    const duration = Math.min(1900, 280 + fullText.length * 15);

    backupStyle(el);
    showTree(el);
    el.style.willChange = "clip-path";

    const caret = createEffect("sr-caret");
    caret.style.setProperty("--c", cursor.color);
    caret.style.opacity = "0";

    if (isVertical) {
      el.style.clipPath = "inset(0 0 100% 0)";
    } else if (isRtl) {
      el.style.clipPath = "inset(0 0 0 100%)";
    } else {
      el.style.clipPath = "inset(0 100% 0 0)";
    }

    const elementRect = el.getBoundingClientRect();
    const elementLeft = elementRect.left + frameWin.scrollX;
    const elementTop = elementRect.top + frameWin.scrollY;

    await tween(duration, (progress) => {
      const charIndex = Math.min(
        fullText.length,
        Math.floor(progress * fullText.length)
      );
      const caretRect = getCaretRect(textNodes, charIndex);

      if (isVertical) {
        const clip = (1 - progress) * 100;
        el.style.clipPath = `inset(0 0 ${clip}% 0)`;
        caret.style.opacity = "1";
        caret.style.left = `${elementLeft + elementRect.width / 2}px`;
        caret.style.top = `${elementTop + elementRect.height * progress}px`;
        caret.style.height = "2px";
        return;
      }

      if (!caretRect) {
        const clip = (1 - progress) * 100;
        el.style.clipPath = isRtl
          ? `inset(0 0 0 ${clip}%)`
          : `inset(0 ${clip}% 0 0)`;
        caret.style.opacity = "1";
        caret.style.left = `${elementLeft + (isRtl ? elementRect.width * (1 - progress) : elementRect.width * progress)}px`;
        caret.style.top = `${elementTop}px`;
        caret.style.height = `${elementRect.height}px`;
        return;
      }

      const top = Math.max(0, Math.min(elementRect.height, caretRect.top - elementRect.top));
      const bottom = Math.max(
        top,
        Math.min(elementRect.height, caretRect.bottom - elementRect.top)
      );
      const x = Math.max(0, Math.min(elementRect.width, caretRect.right - elementRect.left));
      const width = elementRect.width;

      if (isRtl) {
        el.style.clipPath = `polygon(0 0, ${width}px 0, ${width}px ${bottom}px, ${x}px ${bottom}px, ${x}px ${top}px, 0 ${top}px)`;
      } else {
        el.style.clipPath = `polygon(0 0, ${width}px 0, ${width}px ${top}px, ${x}px ${top}px, ${x}px ${bottom}px, 0 ${bottom}px)`;
      }

      caret.style.opacity = "1";
      caret.style.left = `${elementLeft + x}px`;
      caret.style.top = `${elementTop + top}px`;
      caret.style.height = `${Math.max(2, bottom - top)}px`;
    });

    el.style.clipPath = "";
    restoreInline(el);
    caret.style.opacity = "0";
    setTimeout(() => caret.remove(), 180);
  }

  async function dragIn(task, rect, color, cursor) {
    const ghost = createEffect("sr-ghost");
    ghost.style.setProperty("--c", color);
    ghost.style.left = `${rect.left + frameWin.scrollX}px`;
    ghost.style.top = `${rect.top + frameWin.scrollY}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.textContent =
      task.el.textContent.trim().slice(0, 48) || "Drag into place";

    const badge = frameDoc.createElement("span");
    badge.className = "sr-alt-badge";
    badge.textContent = "⌥";
    ghost.appendChild(badge);

    const startX = -48;
    const startY = 30;
    await tween(440, (progress) => {
      const offsetX = startX * (1 - progress);
      const offsetY = startY * (1 - progress);
      ghost.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
      ghost.style.opacity = String(0.55 + 0.35 * progress);
      if (cursor) {
        cursor.tx = rect.left + frameWin.scrollX + offsetX + 8;
        cursor.ty = rect.top + frameWin.scrollY + offsetY + 8;
      }
    });

    ghost.remove();
  }

  function drawGuides(rect, color) {
    const svg = createSvg("sr-guide-svg");
    const scrollX = frameWin.scrollX;
    const scrollY = frameWin.scrollY;
    const width = frameWin.innerWidth;
    const height = frameWin.innerHeight;
    const left = rect.left + scrollX;
    const right = rect.right + scrollX;
    const top = rect.top + scrollY;
    const bottom = rect.bottom + scrollY;

    const lines = [
      [scrollX, top, left, top],
      [right, top, scrollX + width, top],
      [left, scrollY, left, top],
      [left, bottom, left, scrollY + height],
    ];

    for (const [x1, y1, x2, y2] of lines) {
      const line = frameDoc.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "1");
      line.setAttribute("opacity", "0.55");
      const length = Math.hypot(x2 - x1, y2 - y1);
      line.setAttribute("stroke-dasharray", String(length));
      line.setAttribute("stroke-dashoffset", String(length));
      svg.appendChild(line);
      if (line.animate) {
        line.animate(
          [
            { strokeDashoffset: length },
            { strokeDashoffset: 0 },
          ],
          {
            duration: 260 / speed,
            easing: "ease-out",
            fill: "forwards",
          }
        );
      }
    }

    const label = createEffect("sr-guide-label");
    label.textContent = `${Math.round(rect.left)}, ${Math.round(rect.top)}`;
    label.style.left = `${left}px`;
    label.style.top = `${top - 22}px`;

    setTimeout(() => {
      svg.remove();
      label.remove();
    }, 620);
  }

  function pulse(rect, color) {
    const el = createEffect("sr-pulse");
    const size = Math.max(18, Math.min(48, Math.min(rect.width, rect.height) * 0.35));
    el.style.setProperty("--c", color);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.left = `${rect.left + rect.width / 2 + frameWin.scrollX - size / 2}px`;
    el.style.top = `${rect.top + rect.height / 2 + frameWin.scrollY - size / 2}px`;
    setTimeout(() => el.remove(), 700);
  }

  // ------------------------------------------------------------------ build
  async function buildTask(task, generation) {
    const el = task.el;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < -220 || rect.top > frameWin.innerHeight + 220) {
      return false;
    }

    const isRootShadow =
      el === frameDoc.body || el === frameDoc.documentElement;
    const viewportWidth = frameWin.innerWidth;
    const viewportHeight = frameWin.innerHeight;
    const effectRect = isRootShadow
      ? {
          left: viewportWidth * 0.5 - 130,
          top: viewportHeight * 0.5 - 70,
          width: 260,
          height: 140,
          right: viewportWidth * 0.5 + 130,
          bottom: viewportHeight * 0.5 + 70,
        }
      : rect;

    const cursor = pickCursor(effectRect);
    if (!cursor) return false;
    cursor.active = true;
    cursor.el.classList.add("is-active");

    const start = isRootShadow
      ? {
          x: frameWin.scrollX + viewportWidth * 0.5,
          y: frameWin.scrollY + viewportHeight * 0.5,
        }
      : getDocPoint(rect, 0.03, 0.08);
    cursor.tx = start.x;
    cursor.ty = start.y;
    await waitForCursor(cursor, start.x, start.y, 420 / speed);

    if (
      destroyed ||
      state === "leaving" ||
      generation !== buildGeneration
    ) {
      releaseCursor(cursor);
      return false;
    }

    drawGuides(effectRect, cursor.color);
    let selection = null;

    try {
      if (isRootShadow) {
        selection = showSelection(effectRect, cursor.color, "SHADOW");
        await wait(360);
        await revealElement(el, "box");
      } else if (task.kind === "text") {
        selection = showSelection(rect, cursor.color, "TEXT");
        await typeText(el, rect, cursor);
      } else if (task.kind === "media") {
        selection = await dragOutBox(rect, cursor.color, "IMG", cursor);
        await drawBorderAndFill(el, rect, cursor, "media");
      } else if (task.kind === "link") {
        await dragIn(task, rect, cursor.color, cursor);
        if (el.textContent.trim()) {
          await typeText(el, rect, cursor);
        } else {
          await revealElement(el, "box");
        }
      } else {
        selection = await dragOutBox(rect, cursor.color, "BOX", cursor);
        await drawBorderAndFill(el, rect, cursor, "box");
      }

      if (
        !el.classList.contains("sr-show") &&
        !el.classList.contains("sr-show-tree") &&
        !el.classList.contains("sr-show-shadow")
      ) {
        await revealElement(el, task.kind);
      }
    } catch (error) {
      console.warn("[Swarm Rebuild] Could not build an element:", error);
      showTree(el);
    } finally {
      if (selection) {
        selection.style.opacity = "0";
        selection.style.transition = "opacity 160ms ease";
        setTimeout(() => selection.remove(), 180);
      }
      releaseCursor(cursor);
    }

    if (destroyed || state === "leaving" || generation !== buildGeneration) {
      return false;
    }

    pulse(effectRect, cursor.color);
    await wait(130);
    return true;
  }

  function parallelWorkers() {
    return Math.max(2, Math.min(4, cursors.length - 1));
  }

  async function runBuild() {
    if (building || destroyed) return;
    const generation = buildGeneration;
    building = true;

    const worker = async () => {
      while (
        queue.length &&
        !destroyed &&
        state !== "leaving" &&
        generation === buildGeneration
      ) {
        const task = queue.shift();
        if (!task) continue;
        task.queued = false;
        if (builtSet.has(task.el)) continue;

        task.building = true;
        const built = await buildTask(task, generation);
        task.building = false;

        if (
          destroyed ||
          state === "leaving" ||
          generation !== buildGeneration
        ) {
          break;
        }

        if (built) {
          builtSet.add(task.el);
          updateProgress();
        }
        await wait(70);
      }
    };

    await Promise.all(
      Array.from({ length: parallelWorkers() }, () => worker())
    );

    if (generation === buildGeneration) {
      building = false;
      if (
        !destroyed &&
        state !== "leaving" &&
        queue.length === 0
      ) {
        if (allVisibleBuilt()) {
          finishBuild();
        } else {
          enqueueVisible();
        }
      }
    }
  }

  function allVisibleBuilt() {
    for (const task of targets) {
      if (!builtSet.has(task.el) && isVisibleInViewport(task.el, 100)) {
        return false;
      }
    }
    return true;
  }

  function enqueueVisible() {
    if (destroyed || gathering || state === "leaving" || !frameWin) return;

    const newTasks = [];
    for (const task of targets) {
      if (builtSet.has(task.el) || task.queued || task.building) continue;
      if (!isVisibleInViewport(task.el, 160)) continue;
      task.queued = true;
      newTasks.push(task);
    }

    if (newTasks.length) {
      newTasks.sort((a, b) => {
        if (a.isLogo) return -1;
        if (b.isLogo) return 1;
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (
          ar.top + frameWin.scrollY - (br.top + frameWin.scrollY) ||
          ar.left + frameWin.scrollX - (br.left + frameWin.scrollX)
        );
      });
      queue.push(...newTasks);
      if (state !== "building") {
        state = "building";
        hideToast();
      }
      updateProgress();
      runBuild();
    } else {
      updateProgress();
    }
  }

  function finishBuild() {
    state = "idle";
    updateProgress(true);
    showToast(`Rebuilt by ${cursors.length} agent${cursors.length === 1 ? "" : "s"}`);
    flockCursors();
  }

  // --------------------------------------------------------------- progress
  function updateProgress(forceComplete = false) {
    if (!progressBar) return;
    let visible = 0;
    let built = 0;
    for (const task of targets) {
      if (isVisibleInViewport(task.el, 80)) {
        visible++;
        if (builtSet.has(task.el)) built++;
      }
    }
    let percent = visible ? Math.round((built / visible) * 100) : 0;
    if (forceComplete || (state === "idle" && queue.length === 0)) {
      percent = 100;
    }
    progressBar.style.width = `${percent}%`;
    if (countEl) {
      countEl.textContent = `${cursors.length} agent${cursors.length === 1 ? "" : "s"}`;
    }
  }

  // ------------------------------------------------------------------- tour
  function startTour() {
    if (destroyed || state === "leaving" || touring) return;
    touring = true;
    tourBtn.classList.add("active");
    showToast("Tour started");
    tourLast = performance.now();
    tourRaf = requestAnimationFrame(tourLoop);
  }

  function stopTour() {
    if (!touring) return;
    touring = false;
    tourBtn.classList.remove("active");
    if (tourRaf) cancelAnimationFrame(tourRaf);
    tourRaf = 0;
  }

  function toggleTour() {
    if (touring) {
      stopTour();
    } else {
      startTour();
    }
  }

  function tourLoop(now) {
    if (!touring || destroyed) return;
    const dt = Math.min(0.05, Math.max(0, (now - tourLast) / 1000));
    tourLast = now;

    const maxScroll = scroller
      ? scroller.scrollHeight - scroller.clientHeight
      : 0;
    if (!scroller || maxScroll <= 0 || scroller.scrollTop >= maxScroll - 1) {
      stopTour();
      showToast("Tour complete");
      return;
    }

    scroller.scrollTop += 95 * speed * dt;
    tourRaf = requestAnimationFrame(tourLoop);
  }

  // ------------------------------------------------------------------ replay
  function restoreElement(el) {
    el.classList.remove("sr-show", "sr-show-tree", "sr-show-shadow");
    restoreInline(el);
  }

  async function replay() {
    if (destroyed || state === "leaving") return;
    stopTour();
    buildGeneration++;
    queue = [];
    building = false;
    gathering = false;

    for (const task of targets) {
      if (builtSet.has(task.el)) restoreElement(task.el);
    }
    builtSet = new WeakSet();
    effectsLayer.textContent = "";
    hideToast();
    updateProgress();

    state = "starting";
    const generation = buildGeneration;
    await gatherAroundLogo();
    if (destroyed || generation !== buildGeneration) return;
    state = "building";
    enqueueVisible();
  }

  // ------------------------------------------------------------------ gather
  function getGatherCenter() {
    const logo = logoElement;
    if (logo && logo.isConnected && isVisibleInViewport(logo, 0)) {
      const rect = logo.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 + frameWin.scrollX,
        y: rect.top + rect.height / 2 + frameWin.scrollY,
      };
    }

    const first = targets.find((task) => isVisibleInViewport(task.el, 0));
    if (first) {
      const rect = first.el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 + frameWin.scrollX,
        y: rect.top + rect.height / 2 + frameWin.scrollY,
      };
    }

    return {
      x: frameWin.innerWidth / 2 + frameWin.scrollX,
      y: frameWin.innerHeight / 2 + frameWin.scrollY,
    };
  }

  async function gatherAroundLogo() {
    if (!frameWin || !cursors.length) return;
    const generation = ++gatherGeneration;
    gathering = true;
    const center = getGatherCenter();
    const ring = createEffect("sr-gather-ring");
    ring.style.setProperty("--c", "#f472b6");
    ring.style.left = `${center.x}px`;
    ring.style.top = `${center.y}px`;
    setTimeout(() => ring.remove(), 950);

    const count = cursors.length;
    for (let i = 0; i < count; i++) {
      const cursor = cursors[i];
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
      const radius = 54 + (i % 2) * 24;
      cursor.tx = center.x + Math.cos(angle) * radius;
      cursor.ty = center.y + Math.sin(angle) * radius;
    }

    showToast("Assembling the swarm");
    await wait(850);
    if (generation === gatherGeneration) gathering = false;
  }

  // ------------------------------------------------------------------- live
  function goLive() {
    if (destroyed || state === "leaving") return;
    state = "leaving";
    stopTour();
    hideToast();
    flockCursors();
    setTimeout(() => {
      if (destroyed) return;
      overlay.classList.add("is-leaving");
      setTimeout(destroy, 380);
    }, 140);
  }

  // ---------------------------------------------------------------- destroy
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopTour();
    if (rafId) cancelAnimationFrame(rafId);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (observer) observer.disconnect();

    window.removeEventListener("keydown", onKeyDown, true);
    if (shield) {
      shield.removeEventListener("wheel", onWheel);
      shield.removeEventListener("mousemove", onMouseMove);
    }
    if (frameDoc) {
      frameDoc.removeEventListener("scroll", onScroll, true);
    }
    if (frameWin) {
      frameWin.removeEventListener("resize", onResize);
    }

    try {
      if (iframe) iframe.srcdoc = "";
    } catch {
      // Ignore.
    }
    if (host) host.remove();
    window.__swarmRebuild = null;
  }

  // ------------------------------------------------------------------ events
  function setSpeed(nextSpeed) {
    speed = nextSpeed;
    for (const button of shadow.querySelectorAll(".sr-btn.speed")) {
      button.classList.toggle(
        "active",
        Number(button.dataset.speed) === nextSpeed
      );
    }
    showToast(`Speed ${nextSpeed}×`);
  }

  function setUiHidden(hidden) {
    uiHidden = hidden;
    overlay.classList.toggle("ui-hidden", hidden);
  }

  function toggleUiHidden() {
    setUiHidden(!uiHidden);
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 1500);
  }

  function hideToast() {
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.classList.remove("show");
  }

  function onWheel(event) {
    if (destroyed) return;
    event.preventDefault();
    if (!scroller) return;
    if (touring) stopTour();
    scroller.scrollBy({
      left: event.deltaX,
      top: event.deltaY,
      behavior: "auto",
    });
    mouseX = event.clientX;
    mouseY = event.clientY;
    maybeCallAgents(Math.abs(event.deltaY) + Math.abs(event.deltaX));
    flockCursors();
  }

  function maybeCallAgents(velocity) {
    const now = performance.now();
    if (velocity < 90 || now - lastCall < 280) return;
    lastCall = now;

    if (cursors.length < MAX_CURSORS) {
      addCursor(true);
    } else {
      for (const cursor of cursors) {
        cursor.el.classList.add("sr-excited");
        setTimeout(() => cursor.el.classList.remove("sr-excited"), 360);
      }
    }
  }

  function onMouseMove(event) {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (uiHidden) setUiHidden(false);
    if (!gathering) flockCursors();
  }

  function onScroll() {
    if (destroyed || !frameWin) return;
    if (!scrollRaf) {
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (destroyed) return;
        const now = performance.now();
        if (now - lastEnqueue > 90) {
          lastEnqueue = now;
          enqueueVisible();
        }
        flockCursors();
        scheduleRefreshTargets();
      });
    }
  }

  function onResize() {
    if (destroyed) return;
    enqueueVisible();
    flockCursors();
  }

  function scheduleRefreshTargets() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      if (destroyed) return;
      refreshTargets();
      enqueueVisible();
    }, 360);
  }

  function onKeyDown(event) {
    if (destroyed) return;

    if (event.key === "Escape" || event.key === "Esc") {
      if (!document.fullscreenElement) event.preventDefault();
      event.stopPropagation();
      destroy();
      return;
    }
    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      event.stopPropagation();
      toggleUiHidden();
      return;
    }
    if (event.key === "1" || event.key === "2" || event.key === "3") {
      event.preventDefault();
      event.stopPropagation();
      setSpeed(Number(event.key));
      return;
    }
    if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      event.stopPropagation();
      toggleTour();
      return;
    }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      event.stopPropagation();
      replay();
      return;
    }
    if (event.key === "l" || event.key === "L") {
      event.preventDefault();
      event.stopPropagation();
      goLive();
    }
  }

  function onToolbarClick(event) {
    const button = event.target.closest(".sr-btn");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "tour") {
      toggleTour();
    } else if (action === "replay") {
      replay();
    } else if (action === "live") {
      goLive();
    } else if (action === "hide") {
      setUiHidden(true);
    } else if (action === "exit") {
      destroy();
    } else if (button.dataset.speed) {
      setSpeed(Number(button.dataset.speed));
    }
  }

  // -------------------------------------------------------------------- init
  async function init() {
    createOverlay();
    shield.addEventListener("wheel", onWheel, { passive: false });
    shield.addEventListener("mousemove", onMouseMove);
    shadow.addEventListener("click", onToolbarClick);
    window.addEventListener("keydown", onKeyDown, true);

    observer = new MutationObserver(() => {
      if (host && !host.isConnected) destroy();
    });
    observer.observe(document.documentElement, { childList: true });

    try {
      await loadPreview();
    } catch (error) {
      console.warn("[Swarm Rebuild] Could not create the preview:", error);
      overlay.classList.add("is-ready");
      showToast("Could not rebuild this page");
      setTimeout(destroy, 2200);
      return;
    }
    if (destroyed) return;

    frameDoc.addEventListener("scroll", onScroll, true);
    frameWin.addEventListener("resize", onResize);

    refreshTargets();
    updateProgress();
    overlay.classList.add("is-ready");

    const generation = buildGeneration;
    const center = getGatherCenter();
    const count = INITIAL_CURSORS;
    for (let i = 0; i < count; i++) {
      const cursor = createCursor(i);
      const angle = (i / count) * Math.PI * 2;
      const radius =
        Math.max(frameWin.innerWidth, frameWin.innerHeight) * 0.65;
      cursor.x = center.x + Math.cos(angle) * radius;
      cursor.y = center.y + Math.sin(angle) * radius;
      cursor.tx = cursor.x;
      cursor.ty = cursor.y;
      cursor.el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
      cursors.push(cursor);
    }

    lastTime = performance.now();
    rafId = requestAnimationFrame(cursorLoop);
    updateProgress();

    await gatherAroundLogo();
    if (destroyed || generation !== buildGeneration) return;
    state = "building";
    enqueueVisible();
  }

  window.__swarmRebuild = {
    toggle() {
      destroy();
    },
    destroy,
  };

  init();
})();
