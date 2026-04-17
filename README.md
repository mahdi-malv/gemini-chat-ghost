# Gemini Chat Ghost

Gemini Chat Ghost is a Manifest V3 Chrome extension that adds a hover-revealed trash action to Gemini's sidebar, renames a chat to `deleted` in one click, and optionally hides any chat with that exact title.

## Files

- `manifest.json`: MV3 entrypoint, host permissions, popup, content script, and web-accessible page bridge.
- `content_script.js`: Sidebar discovery, action injection, storage sync, ghosting logic, and DOM fallback rename automation.
- `page_bridge.js`: Page-context fetch/XHR interception that caches Gemini's native rename request shape and replays it for one-click rename.
- `popup.html` and `popup.js`: Minimal toggle UI backed by `chrome.storage.local`.
- `styles.css`: Native-feel hover behavior, icon styling, and hide-state CSS.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open `https://gemini.google.com/` and refresh the page once after loading the extension.

## How It Works

1. The content script injects a hidden trash button into likely Gemini chat rows.
2. The page bridge watches Gemini's own network traffic for a successful rename request and caches the request template.
3. Clicking the trash button tries to replay that request with the target chat ID and the new title `deleted`.
4. If the request recipe is unavailable or fails, the extension falls back to opening Gemini's native rename UI and submitting `deleted` automatically.
5. When hide mode is enabled, any row titled `deleted` is hidden in place.

## Troubleshooting

### The trash button never appears

- Refresh Gemini after loading or updating the extension so the content script and page bridge attach early.
- Open DevTools on Gemini and check for console output if you temporarily set `CONFIG.debug = true` in [`content_script.js`](/Users/mahdi/crap/vibe/gemini-delete-ext/content_script.js).
- Gemini may have changed its sidebar structure. Please provide a snippet of the sidebar HTML so the selector map can be updated quickly.

### Clicking the trash button does nothing

- The direct rename path only works after Gemini has emitted a rename-shaped request that the bridge can observe. If it has not, the extension falls back to DOM automation.
- If Gemini renamed or moved the menu labels, the fallback may need updated selectors for the row menu, rename menu item, or dialog buttons.
- If this happens, please share a sidebar row HTML snippet and, if possible, the rename dialog HTML snippet.

### Deleted chats do not hide

- The hide rule matches the normalized visible title exactly against `deleted`.
- If Gemini adds prefixes or suffixes around the title, update the `isDeletedTitle()` logic in [`content_script.js`](/Users/mahdi/crap/vibe/gemini-delete-ext/content_script.js).
- Toggle the popup switch off and back on to force a fresh visibility pass.

### Gemini updated its CSS class names

- Most discovery in this extension is semantic, but the fallback flow still depends on accessible labels and menu/dialog structure.
- Update the centralized selector arrays near the top of [`content_script.js`](/Users/mahdi/crap/vibe/gemini-delete-ext/content_script.js) instead of scattering new selectors throughout the file.
- Re-test both paths:
  - direct request replay
  - DOM fallback rename

## Notes

- The current implementation hides deleted chats in place instead of moving them to a separate trash group.
- The injected action uses a standard trash icon to stay close to Gemini's native Material-style affordances.
