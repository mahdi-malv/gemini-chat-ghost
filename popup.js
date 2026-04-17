(function () {
  "use strict";

  const STORAGE_KEY = "hideDeletedChats";
  const MESSAGE_TYPE = "GCG_TOGGLE_HIDE";

  const toggle = document.getElementById("hide-toggle");
  const statusText = document.getElementById("status-text");
  const toggleDescription = document.getElementById("toggle-description");

  function readPreference() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [STORAGE_KEY]: true }, (result) => {
        resolve(Boolean(result[STORAGE_KEY]));
      });
    });
  }

  function writePreference(value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: value }, () => resolve());
    });
  }

  function queryGeminiTabs() {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: "https://gemini.google.com/*" }, (tabs) => {
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    });
  }

  function sendToggleMessage(tabId, hideDeletedChats) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPE, hideDeletedChats }, () => {
        resolve();
      });
    });
  }

  function updateCopy(hideDeletedChats) {
    toggle.checked = hideDeletedChats;
    toggleDescription.textContent = hideDeletedChats
      ? "Deleted chats vanish from the sidebar."
      : "Deleted chats stay visible in place.";
    statusText.textContent = hideDeletedChats
      ? "Hide mode is on for Gemini."
      : "Show mode is on for Gemini.";
  }

  async function notifyGeminiTabs(hideDeletedChats) {
    const tabs = await queryGeminiTabs();

    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id) {
          return;
        }

        try {
          await sendToggleMessage(tab.id, hideDeletedChats);
        } catch (error) {
          void error;
        }
      })
    );
  }

  async function initialize() {
    const initialValue = await readPreference();
    updateCopy(initialValue);

    toggle.addEventListener("change", async () => {
      const nextValue = toggle.checked;
      updateCopy(nextValue);
      statusText.textContent = "Saving preference…";
      await writePreference(nextValue);
      await notifyGeminiTabs(nextValue);
      updateCopy(nextValue);
    });
  }

  initialize().catch(() => {
    statusText.textContent = "Preference sync failed. Reload the extension and try again.";
  });
})();
