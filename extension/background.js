/**
 * Swarm Rebuild - background service worker.
 *
 * The extension only asks for activeTab + scripting. The content script is
 * injected on demand into the tab the user clicked, and everything happens
 * locally inside that tab. No analytics, storage, or network calls.
 */

const INJECT_ERROR_BADGE_MS = 2200;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (error) {
    // Restricted pages (chrome://, the Web Store, PDF viewer, etc.) cannot be
    // injected. Show a transient badge instead of failing silently.
    console.warn("[Swarm Rebuild] Could not inject into this page:", error);
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
      await chrome.action.setBadgeBackgroundColor({
        tabId: tab.id,
        color: "#f43f5e",
      });
      setTimeout(() => {
        chrome.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => {});
      }, INJECT_ERROR_BADGE_MS);
    } catch {
      // The tab may have been closed while we were reporting the error.
    }
  }
});
