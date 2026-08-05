/* Keeps temporary migration controls in the same candy-colored desktop chrome as Team Games. */
(() => {
  "use strict";

  const styleMarkers = [
    ".ryan-transfer-open{",
    ".ryan-semantic-sync-open{",
    ".ryan-v3-recovery-open{",
  ];
  const dialogs = ".ryan-transfer-dialog, .ryan-semantic-sync-dialog, .ryan-v3-recovery-dialog";
  const cards = ".ryan-transfer-card, .ryan-semantic-sync-card, .ryan-v3-recovery-card";
  const headers = ".ryan-transfer-card > header, .ryan-semantic-sync-card > header, .ryan-v3-recovery-card > header";
  const statusPanels = [
    ".ryan-transfer-status", ".ryan-transfer-preview", ".ryan-transfer-sync",
    ".ryan-semantic-sync-status", ".ryan-semantic-sync-card section",
    ".ryan-v3-recovery-card [data-status]",
  ].join(", ");

  function addClass(selector, className) {
    document.querySelectorAll(selector).forEach((element) => element.classList.add(className));
  }

  function applyTheme() {
    if (document.querySelector('style[data-ryan-transfer-theme="team-games"]')) return;
    document.querySelectorAll("style").forEach((style) => {
      if (styleMarkers.some((marker) => style.textContent.includes(marker))) style.remove();
    });
    addClass(dialogs, "panel");
    addClass(cards, "panel");
    addClass(headers, "panel-title");
    addClass(statusPanels, "panel");

    const style = document.createElement("style");
    style.dataset.ryanTransferTheme = "team-games";
    style.textContent = `
      .ryan-transfer-open{position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483000!important}
      .ryan-semantic-sync-open{position:fixed!important;left:12px!important;bottom:12px!important;z-index:2147482998!important}
      .ryan-v3-recovery-open{position:fixed!important;left:12px!important;bottom:66px!important;z-index:2147482996!important}
      ${dialogs}{width:min(700px,calc(100vw - 24px))!important;max-width:700px!important;max-height:calc(100vh - 24px)!important;margin:auto!important;overflow:auto!important}
      .ryan-transfer-dialog{z-index:2147483001!important}
      .ryan-semantic-sync-dialog{z-index:2147482999!important}
      .ryan-v3-recovery-dialog{z-index:2147482997!important}
      ${headers}{display:flex!important;align-items:flex-start!important;justify-content:space-between!important;gap:12px!important}
      ${headers} h2{min-width:0!important}
      .ryan-transfer-actions,.ryan-semantic-sync-actions,.ryan-v3-recovery-actions,.ryan-semantic-conflict-actions,.ryan-transfer-conflict-actions{display:flex!important;flex-wrap:wrap!important;gap:8px!important}
      ${statusPanels}{margin-top:12px!important}
      .ryan-transfer-preview h3,.ryan-transfer-sync h3,.ryan-semantic-sync-card h3{margin-top:0!important}
      .ryan-transfer-conflict,.ryan-semantic-conflict{display:grid!important;gap:8px!important;margin-top:10px!important}
      @media(max-width:520px){.ryan-transfer-open{right:8px!important;bottom:8px!important}.ryan-semantic-sync-open{left:8px!important;bottom:8px!important}.ryan-v3-recovery-open{left:8px!important;bottom:60px!important}}
    `;
    document.head.append(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
  else applyTheme();
})();
