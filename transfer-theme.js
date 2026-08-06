/* Keeps the private-sync dialog in Team Games' candy-colored desktop chrome. */
(() => {
  "use strict";

  const styleMarkers = [".ryan-semantic-sync-open{"];
  const dialogs = ".ryan-semantic-sync-dialog";
  const cards = ".ryan-semantic-sync-card";
  const headers = ".ryan-semantic-sync-card > header";
  const statusPanels = [
    ".ryan-semantic-sync-status", ".ryan-semantic-sync-card section",
  ].join(", ");

  function addClass(selector, className) {
    document.querySelectorAll(selector).forEach((element) => element.classList.add(className));
  }

  function applyTheme() {
    if (document.querySelector('style[data-ryan-semantic-sync-theme="team-games"]')) return;
    document.querySelectorAll("style").forEach((style) => {
      if (styleMarkers.some((marker) => style.textContent.includes(marker))) style.remove();
    });
    addClass(dialogs, "panel");
    addClass(cards, "panel");
    addClass(headers, "panel-title");
    addClass(statusPanels, "panel");

    const style = document.createElement("style");
    style.dataset.ryanSemanticSyncTheme = "team-games";
    style.textContent = `
      .ryan-semantic-sync-open{position:fixed!important;left:12px!important;bottom:12px!important;z-index:2147482998!important}
      ${dialogs}{width:min(700px,calc(100vw - 24px))!important;max-width:700px!important;max-height:calc(100vh - 24px)!important;margin:auto!important;overflow:auto!important}
      .ryan-semantic-sync-dialog{z-index:2147482999!important}
      ${headers}{display:flex!important;align-items:flex-start!important;justify-content:space-between!important;gap:12px!important}
      ${headers} h2{min-width:0!important}
      .ryan-semantic-sync-actions,.ryan-semantic-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:8px!important}
      ${statusPanels}{margin-top:12px!important}
      .ryan-semantic-sync-card h3{margin-top:0!important}
      .ryan-semantic-conflict{display:grid!important;gap:8px!important;margin-top:10px!important}
      @media(max-width:520px){.ryan-semantic-sync-open{left:8px!important;bottom:8px!important}}
    `;
    document.head.append(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  else applyTheme();
})();
