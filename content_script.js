(function () {
  "use strict";

  const CONFIG = {
    debug: false,
    storageKey: "hideDeletedChats",
    deletedTitle: "deleted",
    bridgeScriptId: "gcg-page-bridge",
    rowClass: "gcg-chat-row",
    hiddenClass: "gcg-chat-row-hidden",
    buttonClass: "gcg-trash-button",
    rowReadyClass: "gcg-row-ready",
    initializedAttr: "gcgInitialized",
    titleAttr: "gcgTitle",
    chatIdAttr: "gcgChatId",
    messageSource: "GCG_CONTENT_SCRIPT",
    pageSource: "GCG_PAGE_BRIDGE",
    messageTypes: {
      toggleHide: "GCG_TOGGLE_HIDE",
      renameChat: "GCG_RENAME_CHAT",
      renameResult: "GCG_RENAME_RESULT",
      renameRecipeSeen: "GCG_RENAME_RECIPE_SEEN"
    },
    rowExcludeSelector: [
      ".gcg-trash-button",
      "[aria-hidden='true']",
      "template",
      "script",
      "style"
    ].join(","),
    sidebarRootSelectors: [
      "aside nav",
      "aside",
      "nav[aria-label*='chat' i]",
      "nav[aria-label*='history' i]",
      "nav[aria-label*='conversation' i]",
      "[role='navigation']",
      "[data-test-id*='sidebar' i]",
      "[data-testid*='sidebar' i]",
      "[data-test-id*='history' i]",
      "[data-testid*='history' i]",
      "main nav"
    ],
    chatAnchorSelectors: [
      "a[href*='/app/']",
      "a[href*='/chat/']",
      "a[href*='/conversation/']",
      "a[href*='conversationId=']",
      "a[href*='chatId=']",
      "a[href]"
    ],
    menuButtonSelectors: [
      "button[aria-haspopup='menu']",
      "button[aria-label*='more' i]",
      "button[aria-label*='options' i]",
      "button[aria-label*='menu' i]",
      "[role='button'][aria-haspopup='menu']"
    ],
    menuSurfaceSelectors: [
      "[role='menu']",
      "[data-test-id*='menu' i]",
      "[data-testid*='menu' i]",
      ".cdk-overlay-pane [role='menu']"
    ],
    renameInputSelectors: [
      "[role='dialog'] input[type='text']",
      "[role='dialog'] textarea",
      "form input[type='text']",
      "form textarea",
      "input[aria-label*='title' i]",
      "input[aria-label*='rename' i]",
      "textarea[aria-label*='title' i]"
    ],
    confirmButtonSelectors: [
      "[role='dialog'] button",
      "form button",
      "button[type='submit']",
      "[role='button']"
    ],
    busyTimeoutMs: 4500,
    startupScanWindowMs: 5000,
    startupScanIntervalMs: 250
  };

  const state = {
    hideDeletedChats: true,
    bridgeInjected: false,
    renameRecipeSeen: false,
    sidebarRoot: null,
    rootObserver: null,
    rowObserver: null,
    pendingScan: false,
    pendingRenameRequests: new Map(),
    startupScanTimerId: null,
    startupScanStartedAt: 0
  };

  function debugLog(...args) {
    if (CONFIG.debug) {
      console.debug("[Gemini Chat Ghost]", ...args);
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizedLowercase(value) {
    return normalizeText(value).toLowerCase();
  }

  function isDeletedTitle(value) {
    return normalizedLowercase(value) === CONFIG.deletedTitle;
  }

  function unique(items) {
    return Array.from(new Set(items.filter(Boolean)));
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function nextMicrotask() {
    return Promise.resolve();
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function readStorage(key, fallbackValue) {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [key]: fallbackValue }, (result) => {
        if (chrome.runtime.lastError) {
          debugLog("storage read failed", chrome.runtime.lastError.message);
          resolve(fallbackValue);
          return;
        }
        resolve(result[key]);
      });
    });
  }

  function whenBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }

    const observer = new MutationObserver(() => {
      if (!document.body) {
        return;
      }
      observer.disconnect();
      callback();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function injectPageBridge() {
    if (state.bridgeInjected || document.getElementById(CONFIG.bridgeScriptId)) {
      return;
    }

    const script = document.createElement("script");
    script.id = CONFIG.bridgeScriptId;
    script.src = chrome.runtime.getURL("page_bridge.js");
    script.async = false;
    script.dataset.extension = "gemini-chat-ghost";
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => {
      debugLog("failed to inject page bridge");
      script.remove();
    }, { once: true });

    (document.head || document.documentElement).appendChild(script);
    state.bridgeInjected = true;
  }

  function startObservers() {
    if (state.rootObserver) {
      state.rootObserver.disconnect();
    }

    state.rootObserver = new MutationObserver(() => {
      if (!state.sidebarRoot || !document.contains(state.sidebarRoot)) {
        refreshSidebarRoot();
        scheduleSidebarScan();
      }
    });

    state.rootObserver.observe(document.body, {
      childList: true,
      subtree: false
    });

    refreshSidebarRoot();
    scheduleSidebarScan();
  }

  function stopRowObserver() {
    if (state.rowObserver) {
      state.rowObserver.disconnect();
      state.rowObserver = null;
    }
  }

  function observeSidebarRoot(root) {
    stopRowObserver();

    if (!root) {
      return;
    }

    state.rowObserver = new MutationObserver(() => {
      scheduleSidebarScan();
    });

    state.rowObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["aria-label", "href", "title"]
    });
  }

  function refreshSidebarRoot() {
    const nextRoot = findSidebarRoot();
    const currentRootAlive = state.sidebarRoot && document.contains(state.sidebarRoot);

    if (currentRootAlive && state.sidebarRoot === nextRoot) {
      return state.sidebarRoot;
    }

    if (nextRoot !== state.sidebarRoot) {
      state.sidebarRoot = nextRoot;
      observeSidebarRoot(nextRoot);
      debugLog("sidebar root updated", nextRoot);
    } else if (!currentRootAlive) {
      state.sidebarRoot = nextRoot;
      observeSidebarRoot(nextRoot);
    }

    return state.sidebarRoot;
  }

  function findSidebarRoot() {
    const selectorMatches = unique(
      CONFIG.sidebarRootSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
      )
    );

    if (!selectorMatches.length) {
      return null;
    }

    let bestCandidate = null;
    let bestScore = 0;

    for (const candidate of selectorMatches) {
      const score = scoreSidebarRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    return bestScore > 0 ? bestCandidate : null;
  }

  function scoreSidebarRoot(root) {
    if (!(root instanceof HTMLElement) || !root.isConnected) {
      return 0;
    }

    const anchors = Array.from(root.querySelectorAll("a[href]")).filter(isLikelyChatAnchor);
    if (!anchors.length) {
      return 0;
    }

    const menuButtons = root.querySelectorAll(CONFIG.menuButtonSelectors.join(",")).length;
    const nestedNavPenalty = root.querySelectorAll("nav").length > 2 ? 3 : 0;

    return anchors.length * 10 + menuButtons * 2 - nestedNavPenalty;
  }

  function isLikelyChatAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return false;
    }

    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) {
      return false;
    }

    let url;
    try {
      url = new URL(rawHref, window.location.origin);
    } catch (error) {
      return false;
    }

    if (url.origin !== window.location.origin) {
      return false;
    }

    const path = url.pathname.toLowerCase();
    const search = url.search.toLowerCase();
    const text = normalizedLowercase(anchor.textContent);
    const looksLikeChatUrl =
      path.includes("/app/") ||
      path.includes("/chat/") ||
      path.includes("/conversation/") ||
      search.includes("conversationid=") ||
      search.includes("chatid=");

    if (looksLikeChatUrl) {
      return true;
    }

    if (!text) {
      return false;
    }

    const excluded = [
      "privacy",
      "terms",
      "help",
      "settings",
      "activity",
      "upgrade",
      "apps",
      "gem manager"
    ];

    return path !== "/" && !excluded.some((label) => text.includes(label));
  }

  function findPotentialRows(root) {
    if (!root) {
      return [];
    }

    const anchors = unique(
      CONFIG.chatAnchorSelectors.flatMap((selector) =>
        Array.from(root.querySelectorAll(selector))
      )
    ).filter(isLikelyChatAnchor);

    const rows = anchors
      .map((anchor) => resolveRowElement(anchor, root))
      .filter((row) => row instanceof HTMLElement && row !== root);

    return unique(rows);
  }

  function resolveRowElement(anchor, root) {
    let current = anchor;
    let best = anchor;

    while (current && current !== root && current !== document.body) {
      if (isRowCandidate(current)) {
        best = current;
      }

      if (hasMenuOrEndcap(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return best;
  }

  function isRowCandidate(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.matches(CONFIG.rowExcludeSelector)) {
      return false;
    }

    const text = normalizeText(element.textContent);
    if (!text) {
      return false;
    }

    return (
      element.matches("li, a, button, [role='listitem'], [role='link'], [role='button']") ||
      element.childElementCount > 1
    );
  }

  function hasMenuOrEndcap(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    return Boolean(element.querySelector(CONFIG.menuButtonSelectors.join(",")));
  }

  function scheduleSidebarScan() {
    if (state.pendingScan) {
      return;
    }

    state.pendingScan = true;
    requestAnimationFrame(() => {
      state.pendingScan = false;
      const root = refreshSidebarRoot();
      if (!root) {
        return;
      }

      for (const row of findPotentialRows(root)) {
        initializeOrRefreshRow(row);
      }

      applyGhostingToKnownRows();
    });
  }

  function beginStartupScans() {
    if (state.startupScanTimerId) {
      window.clearInterval(state.startupScanTimerId);
    }

    state.startupScanStartedAt = performance.now();
    scheduleSidebarScan();
    window.setTimeout(scheduleSidebarScan, 0);
    window.setTimeout(scheduleSidebarScan, 60);

    state.startupScanTimerId = window.setInterval(() => {
      scheduleSidebarScan();

      if (performance.now() - state.startupScanStartedAt >= CONFIG.startupScanWindowMs) {
        window.clearInterval(state.startupScanTimerId);
        state.startupScanTimerId = null;
      }
    }, CONFIG.startupScanIntervalMs);
  }

  function initializeOrRefreshRow(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row.classList.add(CONFIG.rowClass);

    const chatId = extractChatIdFromRow(row);
    if (chatId) {
      row.dataset[CONFIG.chatIdAttr] = chatId;
    }

    const title = extractRowTitle(row);
    if (title) {
      row.dataset[CONFIG.titleAttr] = title;
    }

    if (!row.dataset[CONFIG.initializedAttr]) {
      injectTrashButton(row);
      row.dataset[CONFIG.initializedAttr] = "true";
    }

    applyGhosting(row);
    row.classList.add(CONFIG.rowReadyClass);
  }

  function injectTrashButton(row) {
    if (row.querySelector(`.${CONFIG.buttonClass}`)) {
      return;
    }

    const menuButton = findRowMenuButton(row);
    if (!menuButton || !menuButton.parentElement) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = CONFIG.buttonClass;
    button.setAttribute("aria-label", "Rename chat to deleted");
    button.setAttribute("title", "Rename chat to deleted");
    button.innerHTML = trashIconSvg();
    menuButton.parentElement.insertBefore(button, menuButton.nextSibling);
  }

  function trashIconSvg() {
    return [
      "<svg viewBox='0 0 24 24' aria-hidden='true' focusable='false'>",
      "<path d='M9 3h6l1 2h4v2H4V5h4l1-2z'></path>",
      "<path d='M7 7h10l-.8 11.2A2 2 0 0 1 14.2 20H9.8a2 2 0 0 1-2-1.8L7 7z'></path>",
      "<path d='M10 11v5'></path>",
      "<path d='M14 11v5'></path>",
      "</svg>"
    ].join("");
  }

  function extractChatIdFromRow(row) {
    if (!(row instanceof HTMLElement)) {
      return "";
    }

    const anchor = row.matches("a[href]") ? row : row.querySelector("a[href]");
    if (!anchor) {
      return "";
    }

    const href = anchor.getAttribute("href");
    if (!href) {
      return "";
    }

    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch (error) {
      return "";
    }

    const queryKeys = ["conversationId", "chatId", "id", "c"];
    for (const key of queryKeys) {
      const value = url.searchParams.get(key);
      if (value) {
        return value;
      }
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const candidate = [...segments].reverse().find((segment) => segment.length > 6 && !["app", "chat", "conversation"].includes(segment.toLowerCase()));
    return candidate || "";
  }

  function extractRowTitle(row) {
    const anchorTitle = extractAnchorTitle(row);
    if (anchorTitle) {
      return anchorTitle;
    }

    const titleElement = findLikelyTitleElement(row);
    if (titleElement) {
      return normalizeText(titleElement.textContent);
    }

    const fragments = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.parentElement.closest(`.${CONFIG.buttonClass}`)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (node.parentElement.closest("button, [role='button'], svg")) {
          return NodeFilter.FILTER_REJECT;
        }

        const value = normalizeText(node.textContent);
        return value ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    while (walker.nextNode()) {
      fragments.push(normalizeText(walker.currentNode.textContent));
    }

    fragments.sort((left, right) => right.length - left.length);
    return fragments[0] || "";
  }

  function extractAnchorTitle(row) {
    const anchor = row.matches("a[href]") ? row : row.querySelector("a[href]");
    if (!anchor) {
      return "";
    }

    const leafCandidates = Array.from(anchor.querySelectorAll("span, div, p"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        if (element.closest(`.${CONFIG.buttonClass}`)) {
          return false;
        }
        return element.childElementCount === 0 && Boolean(normalizeText(element.textContent));
      })
      .sort((left, right) => normalizeText(right.textContent).length - normalizeText(left.textContent).length);

    if (leafCandidates.length) {
      return normalizeText(leafCandidates[0].textContent);
    }

    const clone = anchor.cloneNode(true);
    clone.querySelectorAll("button, [role='button'], svg, img").forEach((node) => node.remove());
    return normalizeText(clone.textContent);
  }

  function findLikelyTitleElement(row) {
    const candidates = Array.from(row.querySelectorAll("span, div, p"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        if (element.closest(`.${CONFIG.buttonClass}`)) {
          return false;
        }
        if (element.closest("button, [role='button']")) {
          return false;
        }
        return Boolean(normalizeText(element.textContent)) && element.querySelector("span, div, p") === null;
      })
      .sort((left, right) => normalizeText(right.textContent).length - normalizeText(left.textContent).length);

    return candidates[0] || null;
  }

  function applyGhostingToKnownRows() {
    for (const row of document.querySelectorAll(`.${CONFIG.rowClass}`)) {
      applyGhosting(row);
    }
  }

  function applyGhosting(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    const title = extractRowTitle(row) || row.dataset[CONFIG.titleAttr] || "";
    row.dataset[CONFIG.titleAttr] = title;
    const shouldHide = state.hideDeletedChats && isDeletedTitle(title);
    row.classList.toggle(CONFIG.hiddenClass, shouldHide);
  }

  function setOptimisticDeletedState(row) {
    if (!(row instanceof HTMLElement)) {
      return;
    }

    row.dataset[CONFIG.titleAttr] = CONFIG.deletedTitle;

    const titleElement = findLikelyTitleElement(row);
    if (titleElement && titleElement.childElementCount === 0) {
      titleElement.textContent = CONFIG.deletedTitle;
    }

    applyGhosting(row);
  }

  function bindMessageListeners() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") {
        return false;
      }

      if (message.type === CONFIG.messageTypes.toggleHide) {
        state.hideDeletedChats = Boolean(message.hideDeletedChats);
        applyGhostingToKnownRows();
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[CONFIG.storageKey]) {
        return;
      }

      state.hideDeletedChats = Boolean(changes[CONFIG.storageKey].newValue);
      applyGhostingToKnownRows();
    });

    window.addEventListener("message", handlePageBridgeMessage);
  }

  function handlePageBridgeMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== CONFIG.pageSource) {
      return;
    }

    if (message.type === CONFIG.messageTypes.renameRecipeSeen) {
      state.renameRecipeSeen = true;
      debugLog("rename recipe observed");
      return;
    }

    if (message.type !== CONFIG.messageTypes.renameResult || !message.requestId) {
      return;
    }

    const pending = state.pendingRenameRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    window.clearTimeout(pending.timeoutId);
    state.pendingRenameRequests.delete(message.requestId);
    pending.resolve({
      ok: Boolean(message.ok),
      method: message.method || "bridge",
      error: message.error || ""
    });
  }

  function bindClickDelegation() {
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(`.${CONFIG.buttonClass}`) : null;
      if (!button) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const row = button.closest(`.${CONFIG.rowClass}`);
      if (!row) {
        return;
      }

      handleTrashClick(row, button).catch((error) => {
        debugLog("rename action failed", error);
      });
    }, true);
  }

  async function handleTrashClick(row, button) {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    if (button.dataset.busy === "true") {
      return;
    }

    button.dataset.busy = "true";
    button.disabled = true;

    try {
      const chatId = row.dataset[CONFIG.chatIdAttr] || extractChatIdFromRow(row);
      if (chatId) {
        row.dataset[CONFIG.chatIdAttr] = chatId;
      }

      let result = { ok: false, error: "No rename strategy succeeded." };

      if (chatId) {
        result = await requestRenameThroughBridge(chatId, CONFIG.deletedTitle);
      }

      if (!result.ok) {
        result = await renameViaDomFallback(row);
      }

      if (result.ok) {
        setOptimisticDeletedState(row);
        scheduleSidebarScan();
      } else {
        button.dataset.failed = "true";
        window.setTimeout(() => {
          delete button.dataset.failed;
        }, 1600);
      }
    } finally {
      button.disabled = false;
      delete button.dataset.busy;
    }
  }

  function requestRenameThroughBridge(chatId, title) {
    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `gcg-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        state.pendingRenameRequests.delete(requestId);
        resolve({
          ok: false,
          error: "Rename bridge timeout."
        });
      }, CONFIG.busyTimeoutMs);

      state.pendingRenameRequests.set(requestId, { resolve, timeoutId });
      window.postMessage({
        source: CONFIG.messageSource,
        type: CONFIG.messageTypes.renameChat,
        requestId,
        chatId,
        title
      }, window.location.origin);
    });
  }

  function findRowMenuButton(row) {
    const buttons = Array.from(row.querySelectorAll(CONFIG.menuButtonSelectors.join(",")));
    return (
      buttons.find((button) => {
        const label = normalizedLowercase(
          button.getAttribute("aria-label") ||
          button.getAttribute("aria-labelledby") ||
          button.textContent
        );
        return label.includes("more") || label.includes("option") || label.includes("menu");
      }) ||
      buttons[buttons.length - 1] ||
      null
    );
  }

  async function renameViaDomFallback(row) {
    const menuButton = findRowMenuButton(row);
    if (!menuButton) {
      return { ok: false, method: "dom-fallback", error: "No menu button found for row." };
    }

    menuButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

    const menu = await waitForElement(() => findOpenMenu());
    if (!menu) {
      return { ok: false, method: "dom-fallback", error: "Rename menu did not open." };
    }

    const renameItem = findRenameMenuItem(menu);
    if (!renameItem) {
      return { ok: false, method: "dom-fallback", error: "Rename menu item not found." };
    }

    renameItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

    const input = await waitForElement(() => findRenameInput());
    if (!input) {
      return { ok: false, method: "dom-fallback", error: "Rename input not found." };
    }

    fillInput(input, CONFIG.deletedTitle);
    await nextAnimationFrame();

    const submitted = submitRename(input);
    if (!submitted) {
      return { ok: false, method: "dom-fallback", error: "Rename form could not be submitted." };
    }

    await waitForRenameCompletion(row);
    return { ok: true, method: "dom-fallback" };
  }

  function findOpenMenu() {
    for (const selector of CONFIG.menuSurfaceSelectors) {
      const menu = document.querySelector(selector);
      if (menu) {
        return menu;
      }
    }
    return null;
  }

  function findRenameMenuItem(menu) {
    const menuItems = Array.from(
      menu.querySelectorAll("button, [role='menuitem'], [role='button'], li")
    );

    return (
      menuItems.find((item) => normalizedLowercase(item.textContent).includes("rename")) || null
    );
  }

  function findRenameInput() {
    for (const selector of CONFIG.renameInputSelectors) {
      const input = document.querySelector(selector);
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        return input;
      }
    }

    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      return active;
    }

    return null;
  }

  function fillInput(input, value) {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function submitRename(input) {
    const dialog = input.closest("[role='dialog'], form") || document;
    const buttons = Array.from(dialog.querySelectorAll(CONFIG.confirmButtonSelectors.join(",")));
    const confirmButton = buttons.find((button) => {
      const text = normalizedLowercase(button.textContent);
      return text.includes("save") || text.includes("rename") || text.includes("done") || text.includes("ok");
    });

    if (confirmButton) {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }

    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter", code: "Enter" }));
    return true;
  }

  async function waitForRenameCompletion(row) {
    const start = performance.now();
    while (performance.now() - start < CONFIG.busyTimeoutMs) {
      const title = extractRowTitle(row);
      if (isDeletedTitle(title)) {
        return true;
      }
      await wait(100);
    }
    return false;
  }

  function waitForElement(factory, timeoutMs = CONFIG.busyTimeoutMs) {
    const initial = factory();
    if (initial) {
      return Promise.resolve(initial);
    }

    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const next = factory();
        if (!next) {
          return;
        }
        window.clearTimeout(timeoutId);
        observer.disconnect();
        resolve(next);
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });
  }

  async function initialize() {
    state.hideDeletedChats = Boolean(await readStorage(CONFIG.storageKey, true));

    bindMessageListeners();
    bindClickDelegation();
    injectPageBridge();

    whenBodyReady(() => {
      startObservers();
      beginStartupScans();
    });

    await nextMicrotask();
    scheduleSidebarScan();
  }

  initialize().catch((error) => {
    debugLog("initialization failed", error);
  });
})();
