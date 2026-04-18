(function () {
  "use strict";

  const CONTENT_SOURCE = "GCG_CONTENT_SCRIPT";
  const PAGE_SOURCE = "GCG_PAGE_BRIDGE";
  const MESSAGE_TYPES = {
    renameChat: "GCG_RENAME_CHAT",
    renameResult: "GCG_RENAME_RESULT",
    renameRecipeSeen: "GCG_RENAME_RECIPE_SEEN"
  };

  const state = {
    nativeFetch: window.fetch.bind(window),
    // Scraped session params
    atToken: null,
    fsid: null,
    bl: null,
    // Fallback: captured from an organic rename
    recipe: null
  };

  const XHR_METADATA = Symbol("gcgXhrMetadata");

  function postMessage(type, payload) {
    window.postMessage({ source: PAGE_SOURCE, type, ...payload }, window.location.origin);
  }

  // ── Session param extraction ────────────────────────────────────────────────
  // Gemini embeds WIZ_global_data (or equivalent) in the page with the CSRF token
  // and session params needed for batchexecute calls.

  function scrapeSessionParams() {
    // Try WIZ_global_data first (standard Google SPA pattern)
    try {
      const wiz = window.WIZ_global_data;
      if (wiz) {
        if (wiz.SNlM0e) state.atToken = wiz.SNlM0e;
        if (wiz.cfb2h)  state.fsid    = wiz.cfb2h;
        if (wiz.W3Iiob) state.bl      = wiz.W3Iiob;
      }
    } catch (_) {}

    // Try AF_initDataKeys / AF_dataServiceRequests patterns
    try {
      if (window.AF_initDataKeys) {
        const keys = window.AF_initDataKeys;
        if (keys.atToken) state.atToken = keys.atToken;
      }
    } catch (_) {}

    // Scan inline <script> tags for the "at" token pattern as last resort
    if (!state.atToken) {
      try {
        const scripts = document.querySelectorAll("script:not([src])");
        for (const script of scripts) {
          const m = script.textContent.match(/"SNlM0e":"([^"]+)"/);
          if (m) { state.atToken = m[1]; break; }
        }
      } catch (_) {}
    }

    // f.sid from WIZ or from the page's __initData
    if (!state.fsid) {
      try {
        const scripts = document.querySelectorAll("script:not([src])");
        for (const script of scripts) {
          const m = script.textContent.match(/"FdrFJe":"(-?\d+)"/);
          if (m) { state.fsid = m[1]; break; }
        }
      } catch (_) {}
    }

    // bl build label
    if (!state.bl) {
      try {
        const scripts = document.querySelectorAll("script:not([src])");
        for (const script of scripts) {
          const m = script.textContent.match(/"cfb2h":"([^"]+)"/);
          if (m) { state.bl = m[1]; break; }
        }
      } catch (_) {}
    }
  }

  // ── Direct batchexecute rename ──────────────────────────────────────────────

  function buildBatchExecuteBody(chatId, title, atToken) {
    // RPC payload: [null, [["title"]], ["c_<chatId>", "<title>"]]
    const rpcArg = JSON.stringify([null, [["title"]], [`c_${chatId}`, title]]);
    const fReq = JSON.stringify([[[
      "MUAZcd",
      rpcArg,
      null,
      "generic"
    ]]]);

    const params = new URLSearchParams();
    params.set("f.req", fReq);
    if (atToken) params.set("at", atToken);
    return params.toString();
  }

  function buildBatchExecuteUrl(chatId) {
    const url = new URL("https://gemini.google.com/_/BardChatUi/data/batchexecute");
    url.searchParams.set("rpcids", "MUAZcd");
    url.searchParams.set("source-path", `/app/${chatId}`);
    if (state.bl)   url.searchParams.set("bl", state.bl);
    if (state.fsid) url.searchParams.set("f.sid", state.fsid);
    url.searchParams.set("hl", "en");
    url.searchParams.set("rt", "c");
    return url.toString();
  }

  async function renameViaBatchExecute(chatId, title) {
    scrapeSessionParams();

    const url  = buildBatchExecuteUrl(chatId);
    const body = buildBatchExecuteBody(chatId, title, state.atToken);

    try {
      const response = await state.nativeFetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "x-same-domain": "1"
        },
        body
      });

      if (response.ok) {
        return { ok: true, method: "batchexecute" };
      }
      return { ok: false, error: `batchexecute failed: ${response.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Recipe capture (kept as fallback for auth token scraping) ──────────────

  function safeParseJson(value) {
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }

  function cloneValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof structuredClone === "function") {
      try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function objectEntriesFromHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (headers instanceof Headers) { headers.forEach((v, k) => { out[k] = v; }); return out; }
    if (Array.isArray(headers)) { for (const [k, v] of headers) out[k] = v; return out; }
    if (typeof headers === "object") return { ...headers };
    return out;
  }

  async function readRequestBody(body) {
    if (!body) return { bodyKind: "empty", bodyValue: null };
    if (typeof body === "string") {
      const json = safeParseJson(body);
      return json ? { bodyKind: "json", bodyValue: json } : { bodyKind: "text", bodyValue: body };
    }
    if (body instanceof URLSearchParams) return { bodyKind: "text", bodyValue: body.toString() };
    if (body instanceof FormData) return { bodyKind: "form-data", bodyValue: Array.from(body.entries()) };
    if (body instanceof Blob) return { bodyKind: "text", bodyValue: await body.text() };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { bodyKind: "binary", bodyValue: null };
    return { bodyKind: "unknown", bodyValue: null };
  }

  function extractAtTokenFromBody(bodyStr) {
    if (typeof bodyStr !== "string") return null;
    try {
      const params = new URLSearchParams(bodyStr);
      const at = params.get("at");
      if (at) return at;
    } catch (_) {}
    const m = bodyStr.match(/(?:^|&)at=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function extractBlFromUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return u.searchParams.get("bl") || null;
    } catch (_) { return null; }
  }

  function extractFsidFromUrl(url) {
    try {
      const u = new URL(url, window.location.origin);
      return u.searchParams.get("f.sid") || null;
    } catch (_) { return null; }
  }

  function captureParamsFromRenameRequest(descriptor) {
    // Only care about batchexecute rename calls
    if (!descriptor.url || !descriptor.url.includes("batchexecute")) return;
    const body = descriptor.bodyKind === "text" ? descriptor.bodyValue : null;
    if (!body || !body.includes("MUAZcd")) return;

    const at = extractAtTokenFromBody(body);
    if (at) state.atToken = at;

    const bl = extractBlFromUrl(descriptor.url);
    if (bl) state.bl = bl;

    const fsid = extractFsidFromUrl(descriptor.url);
    if (fsid) state.fsid = fsid;

    postMessage(MESSAGE_TYPES.renameRecipeSeen, { hasRecipe: true });
  }

  async function snapshotFetchArguments(input, init) {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = String(init && init.method ? init.method : request ? request.method : "GET").toUpperCase();
    const headers = objectEntriesFromHeaders(init && init.headers ? init.headers : request ? request.headers : null);

    let bodySource = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : null;
    if (request && bodySource === null && method !== "GET" && method !== "HEAD") {
      try { bodySource = await request.clone().text(); } catch (_) { bodySource = null; }
    }

    const { bodyKind, bodyValue } = await readRequestBody(bodySource);
    return { url, method, headers, bodyKind, bodyValue };
  }

  function patchFetch() {
    window.fetch = async function patchedFetch(input, init) {
      const descriptor = await snapshotFetchArguments(input, init);
      const response = await state.nativeFetch(input, init);
      if (response && response.ok) captureParamsFromRenameRequest(descriptor);
      return response;
    };
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this[XHR_METADATA] = { method: String(method || "GET").toUpperCase(), url: String(url), headers: {} };
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(key, value) {
      if (this[XHR_METADATA]) this[XHR_METADATA].headers[key] = value;
      return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      const metadata = this[XHR_METADATA];
      if (metadata) {
        readRequestBody(body).then(({ bodyKind, bodyValue }) => {
          metadata.bodyKind = bodyKind;
          metadata.bodyValue = bodyValue;
        });
        this.addEventListener("load", () => {
          if (this.status >= 200 && this.status < 300) {
            captureParamsFromRenameRequest({
              url: metadata.url,
              method: metadata.method,
              headers: metadata.headers,
              bodyKind: metadata.bodyKind,
              bodyValue: metadata.bodyValue
            });
          }
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  function bindMessages() {
    window.addEventListener("message", async (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;

      const message = event.data;
      if (!message || message.source !== CONTENT_SOURCE || message.type !== MESSAGE_TYPES.renameChat) return;

      // Always try direct batchexecute first
      let result = await renameViaBatchExecute(message.chatId, message.title);

      postMessage(MESSAGE_TYPES.renameResult, {
        requestId: message.requestId,
        ok: result.ok,
        method: result.method || "batchexecute",
        error: result.error || ""
      });
    });
  }

  patchFetch();
  patchXhr();
  bindMessages();

  // Scrape on load so the at-token is ready before the first click
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scrapeSessionParams, { once: true });
  } else {
    scrapeSessionParams();
  }
})();
