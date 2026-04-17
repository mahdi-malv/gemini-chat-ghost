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
    recipe: null,
    nativeFetch: window.fetch.bind(window)
  };
  const XHR_METADATA = Symbol("gcgXhrMetadata");

  function postMessage(type, payload) {
    window.postMessage({
      source: PAGE_SOURCE,
      type,
      ...payload
    }, window.location.origin);
  }

  function safeParseJson(value) {
    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function cloneValue(value) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch (error) {
        return JSON.parse(JSON.stringify(value));
      }
    }

    return JSON.parse(JSON.stringify(value));
  }

  function objectEntriesFromHeaders(headers) {
    const nextHeaders = {};

    if (!headers) {
      return nextHeaders;
    }

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        nextHeaders[key] = value;
      });
      return nextHeaders;
    }

    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        nextHeaders[key] = value;
      }
      return nextHeaders;
    }

    if (typeof headers === "object") {
      return { ...headers };
    }

    return nextHeaders;
  }

  async function readRequestBody(body) {
    if (!body) {
      return { bodyKind: "empty", bodyValue: null };
    }

    if (typeof body === "string") {
      const json = safeParseJson(body);
      return json
        ? { bodyKind: "json", bodyValue: json }
        : { bodyKind: "text", bodyValue: body };
    }

    if (body instanceof URLSearchParams) {
      return { bodyKind: "text", bodyValue: body.toString() };
    }

    if (body instanceof FormData) {
      return {
        bodyKind: "form-data",
        bodyValue: Array.from(body.entries())
      };
    }

    if (body instanceof Blob) {
      return {
        bodyKind: "text",
        bodyValue: await body.text()
      };
    }

    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return { bodyKind: "binary", bodyValue: null };
    }

    if (typeof body === "object") {
      return {
        bodyKind: "json",
        bodyValue: cloneValue(body)
      };
    }

    return { bodyKind: "unknown", bodyValue: null };
  }

  async function snapshotFetchArguments(input, init) {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = String(init && init.method ? init.method : request ? request.method : "GET").toUpperCase();
    const headers = objectEntriesFromHeaders(init && init.headers ? init.headers : request ? request.headers : null);

    let bodySource = init && Object.prototype.hasOwnProperty.call(init, "body") ? init.body : null;
    if (request && bodySource === null && method !== "GET" && method !== "HEAD") {
      try {
        bodySource = await request.clone().text();
      } catch (error) {
        bodySource = null;
      }
    }

    const { bodyKind, bodyValue } = await readRequestBody(bodySource);
    return { url, method, headers, bodyKind, bodyValue };
  }

  function walkObject(value, visitor, trail) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkObject(entry, visitor, [...trail, index]));
      return;
    }

    Object.entries(value).forEach(([key, entry]) => {
      visitor(key, entry, [...trail, key]);
      walkObject(entry, visitor, [...trail, key]);
    });
  }

  function analyzeRecipeCandidate(descriptor) {
    const analysis = {
      titlePath: null,
      chatIdPaths: []
    };

    const titleKeyNames = ["title", "name", "label"];
    const chatIdKeyNames = ["chatid", "conversationid", "conversation", "chat", "id"];

    if (descriptor.bodyKind === "json" && descriptor.bodyValue && typeof descriptor.bodyValue === "object") {
      walkObject(descriptor.bodyValue, (key, value, path) => {
        const normalizedKey = String(key).toLowerCase();
        if (!analysis.titlePath && typeof value === "string" && titleKeyNames.includes(normalizedKey)) {
          analysis.titlePath = path;
        }

        if (typeof value === "string" && chatIdKeyNames.includes(normalizedKey)) {
          analysis.chatIdPaths.push(path);
        }
      }, []);
    }

    return analysis;
  }

  function getByPath(target, path) {
    return path.reduce((value, key) => (value == null ? value : value[key]), target);
  }

  function setByPath(target, path, nextValue) {
    if (!Array.isArray(path) || !path.length) {
      return;
    }

    let cursor = target;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (cursor[key] == null || typeof cursor[key] !== "object") {
        return;
      }
      cursor = cursor[key];
    }

    cursor[path[path.length - 1]] = nextValue;
  }

  function extractChatIdFromUrl(url) {
    try {
      const nextUrl = new URL(url, window.location.origin);
      const params = ["conversationId", "chatId", "id", "c"];
      for (const key of params) {
        const value = nextUrl.searchParams.get(key);
        if (value) {
          return value;
        }
      }

      const segments = nextUrl.pathname.split("/").filter(Boolean);
      return [...segments].reverse().find((segment) => segment.length > 6) || "";
    } catch (error) {
      return "";
    }
  }

  function filterReplayHeaders(headers) {
    const blocked = new Set([
      "content-length",
      "host",
      "origin",
      "referer",
      "cookie"
    ]);

    return Object.fromEntries(
      Object.entries(headers || {}).filter(([key]) => !blocked.has(String(key).toLowerCase()))
    );
  }

  function looksLikeRenameRequest(descriptor, analysis) {
    if (!descriptor || !analysis.titlePath) {
      return false;
    }

    if (!["POST", "PATCH", "PUT"].includes(descriptor.method)) {
      return false;
    }

    const haystack = `${descriptor.url} ${JSON.stringify(descriptor.bodyValue || {})}`.toLowerCase();
    return /rename|title|chat|conversation/.test(haystack);
  }

  function captureRecipe(descriptor) {
    const analysis = analyzeRecipeCandidate(descriptor);
    if (!looksLikeRenameRequest(descriptor, analysis)) {
      return;
    }

    const previousTitle = getByPath(descriptor.bodyValue, analysis.titlePath);
    const capturedChatId =
      analysis.chatIdPaths.map((path) => getByPath(descriptor.bodyValue, path)).find(Boolean) ||
      extractChatIdFromUrl(descriptor.url);

    state.recipe = {
      url: descriptor.url,
      method: descriptor.method,
      headers: filterReplayHeaders(descriptor.headers),
      bodyKind: descriptor.bodyKind,
      bodyTemplate: cloneValue(descriptor.bodyValue),
      titlePath: analysis.titlePath,
      chatIdPaths: analysis.chatIdPaths,
      capturedChatId,
      capturedTitle: typeof previousTitle === "string" ? previousTitle : null
    };

    postMessage(MESSAGE_TYPES.renameRecipeSeen, { hasRecipe: true });
  }

  function replaceChatIdInUrl(url, previousChatId, nextChatId) {
    if (!previousChatId || !nextChatId) {
      return url;
    }

    try {
      const nextUrl = new URL(url, window.location.origin);
      if (nextUrl.pathname.includes(previousChatId)) {
        nextUrl.pathname = nextUrl.pathname.replace(previousChatId, nextChatId);
      }

      ["conversationId", "chatId", "id", "c"].forEach((key) => {
        if (nextUrl.searchParams.get(key) === previousChatId) {
          nextUrl.searchParams.set(key, nextChatId);
        }
      });

      return nextUrl.toString();
    } catch (error) {
      return url.replace(previousChatId, nextChatId);
    }
  }

  function buildReplayRequest(chatId, title) {
    if (!state.recipe) {
      return null;
    }

    const recipe = state.recipe;
    const headers = { ...recipe.headers };
    let url = replaceChatIdInUrl(recipe.url, recipe.capturedChatId, chatId);
    let body = null;

    if (recipe.bodyKind === "json" && recipe.bodyTemplate && typeof recipe.bodyTemplate === "object") {
      const payload = cloneValue(recipe.bodyTemplate);
      setByPath(payload, recipe.titlePath, title);

      for (const path of recipe.chatIdPaths) {
        setByPath(payload, path, chatId);
      }

      body = JSON.stringify(payload);
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json;charset=UTF-8";
      }
    } else if (typeof recipe.bodyTemplate === "string") {
      body = recipe.bodyTemplate;
      if (recipe.capturedTitle) {
        body = body.replace(recipe.capturedTitle, title);
      }
      if (recipe.capturedChatId) {
        body = body.replace(recipe.capturedChatId, chatId);
      }
    }

    return {
      url,
      init: {
        method: recipe.method,
        headers,
        body,
        credentials: "include"
      }
    };
  }

  async function replayRename(chatId, title) {
    const request = buildReplayRequest(chatId, title);
    if (!request) {
      return { ok: false, error: "No cached rename recipe available." };
    }

    try {
      const response = await state.nativeFetch(request.url, request.init);
      if (!response.ok) {
        return { ok: false, error: `Rename request failed with ${response.status}.` };
      }

      return { ok: true, method: "bridge" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Rename request failed." };
    }
  }

  function patchFetch() {
    window.fetch = async function patchedFetch(input, init) {
      const descriptor = await snapshotFetchArguments(input, init);
      const response = await state.nativeFetch(input, init);

      if (response && response.ok) {
        captureRecipe(descriptor);
      }

      return response;
    };
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this[XHR_METADATA] = {
        method: String(method || "GET").toUpperCase(),
        url: String(url),
        headers: {}
      };
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(key, value) {
      if (this[XHR_METADATA]) {
        this[XHR_METADATA].headers[key] = value;
      }
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
            captureRecipe({
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

  function bindMessages() {
    window.addEventListener("message", async (event) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const message = event.data;
      if (!message || message.source !== CONTENT_SOURCE || message.type !== MESSAGE_TYPES.renameChat) {
        return;
      }

      const result = await replayRename(message.chatId, message.title);
      postMessage(MESSAGE_TYPES.renameResult, {
        requestId: message.requestId,
        ok: result.ok,
        method: result.method || "bridge",
        error: result.error || ""
      });
    });
  }

  patchFetch();
  patchXhr();
  bindMessages();
})();
