# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Gemini Chat Ghost** is a Chrome Extension (Manifest V3) that adds one-click chat deletion to Google Gemini by renaming chats to `"deleted"` and optionally hiding them from the sidebar.

## Development

No build step, no dependencies. Load the extension directly in Chrome:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and select this directory

After editing any file, click the reload icon on the extension card. For content script changes, also reload the Gemini tab.

## Architecture

The extension uses three execution contexts that communicate via message passing:

### `page_bridge.js` — Page context (full DOM + network access)
Injected into the page context by the content script. Patches `window.fetch()` and `XMLHttpRequest` to intercept Gemini's rename API calls and cache the request template ("recipe"). When triggered, replays the recipe with a new chat ID and title `"deleted"`.

### `content_script.js` — Content script context (limited)
The main logic. Runs at `document_start` on `gemini.google.com/*`. Responsibilities:
- Injects `page_bridge.js` into the page context
- Discovers the sidebar and chat rows via flexible selector arrays (resilient to Gemini UI changes)
- Injects trash buttons into rows via `MutationObserver`
- Handles trash button clicks — tries network bridge first (4.5s timeout), falls back to DOM automation (click menu → rename → fill → submit)
- Reads/writes `hideDeletedChats` preference to `chrome.storage.local`
- Hides rows whose title is `"deleted"` when hide mode is active

### `popup.js` / `popup.html` — Extension popup
Simple toggle for the "Hide Deleted Chats" preference. Writes to `chrome.storage.local` and broadcasts the change to all open Gemini tabs via `chrome.tabs.sendMessage`.

### Message flow

```
Popup toggle
  → chrome.storage.local + sendMessage to content script
Content script
  → window.postMessage to page bridge (trigger rename)
Page bridge
  → native fetch to Gemini API
  → window.postMessage back to content script
Content script
  → applies hide CSS class to row
```

## Key Implementation Details

**Rename strategy (two paths):**
1. **Network bridge** (preferred): Waits for page bridge to capture a recipe from an organic rename, then replays it. Fast and transparent to the user.
2. **DOM automation** (fallback): Opens the row's context menu, clicks Rename, fills the input, submits. Slower but works even if the recipe was never captured.

**Selector resilience**: Content script uses arrays of candidate selectors for sidebar, rows, menus, and inputs. Update these arrays in `content_script.js` when Gemini changes its HTML structure — this is the most likely maintenance task.

**State tracked in content script:**
- `state.hideDeletedChats` — synced from storage
- `pendingRenameRequests` — Map of in-flight renames (keyed by chat ID)
- `sidebarRoot` — discovered sidebar element reference

**Key constants in `content_script.js`:**
- `deletedTitle = "deleted"` — the string chats are renamed to
- `busyTimeoutMs = 4500` — how long to wait for bridge before falling back
