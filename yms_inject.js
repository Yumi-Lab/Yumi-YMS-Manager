/**
 * YMS Multi-Color Panel — Mainsail Injection Script
 *
 * Injects the YMS panel into Mainsail's dashboard without forking.
 * Loaded via <script> tag patched into ~/mainsail/index.html by install.sh.
 * YUMI_SYNC re-runs install.sh after each Mainsail update to re-inject.
 *
 * Strategy:
 *   1. Wait for Mainsail's Vue app to mount (#app populated)
 *   2. Add a sidebar navigation entry (icon + label)
 *   3. When clicked, show the YMS panel as an overlay or embedded iframe
 *   4. Poll printer.yms_manager for live data
 */

(function() {
  'use strict';

  const PANEL_URL = '/yms_panel.html';
  const POLL_MS = 2000;
  const MAX_WAIT = 30000; // max ms to wait for Mainsail

  // ── Wait for Mainsail sidebar to exist ───────────────────────────────
  function waitForElement(selector, timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeout) return reject('timeout');
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // ── SVG icon for sidebar (palette/multi-color) ───────────────────────
  const YMS_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:24px;height:24px;fill:currentColor">
    <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A2,2 0 0,0 14,20C14,19.45 13.78,18.95 13.41,18.59C13.06,18.24 12.86,17.75 12.86,17.25A2,2 0 0,1 14.86,15.25H16.25C19.45,15.25 22,12.7 22,9.5C22,5.36 17.52,2 12,2M6.5,13A1.5,1.5 0 0,1 5,11.5A1.5,1.5 0 0,1 6.5,10A1.5,1.5 0 0,1 8,11.5A1.5,1.5 0 0,1 6.5,13M9.5,8A1.5,1.5 0 0,1 8,6.5A1.5,1.5 0 0,1 9.5,5A1.5,1.5 0 0,1 11,6.5A1.5,1.5 0 0,1 9.5,8M14.5,8A1.5,1.5 0 0,1 13,6.5A1.5,1.5 0 0,1 14.5,5A1.5,1.5 0 0,1 16,6.5A1.5,1.5 0 0,1 14.5,8M17.5,13A1.5,1.5 0 0,1 16,11.5A1.5,1.5 0 0,1 17.5,10A1.5,1.5 0 0,1 19,11.5A1.5,1.5 0 0,1 17.5,13Z"/>
  </svg>`;

  // ── Inject sidebar button ────────────────────────────────────────────
  function injectSidebarButton(navList) {
    // Find existing nav items to match their style
    const existingItems = navList.querySelectorAll('.v-list-item');
    if (!existingItems.length) return false;

    // Clone style from an existing item
    const refItem = existingItems[existingItems.length - 1];

    // Create YMS nav item
    const ymsItem = document.createElement('a');
    ymsItem.className = refItem.className;
    ymsItem.href = '#yms-panel';
    ymsItem.setAttribute('role', 'listitem');
    ymsItem.setAttribute('tabindex', '0');
    ymsItem.style.textDecoration = 'none';
    ymsItem.innerHTML = `
      <div class="v-list-item__icon" style="margin-right:12px;min-width:24px;display:flex;align-items:center;">
        ${YMS_ICON_SVG}
      </div>
      <div class="v-list-item__content">
        <div class="v-list-item__title">YMS Multi-Color</div>
      </div>
    `;

    ymsItem.addEventListener('click', function(e) {
      e.preventDefault();
      togglePanel();
    });

    // Insert before the last item (Machine) or at the end
    const machineItem = Array.from(existingItems).find(
      el => el.textContent.toLowerCase().includes('machine')
    );
    if (machineItem) {
      navList.insertBefore(ymsItem, machineItem);
    } else {
      navList.appendChild(ymsItem);
    }

    return true;
  }

  // ── Panel overlay ────────────────────────────────────────────────────
  let panelVisible = false;
  let panelFrame = null;

  function createPanel() {
    // Overlay container
    const overlay = document.createElement('div');
    overlay.id = 'yms-panel-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      z-index: 9999; display: none;
      background: rgba(0,0,0,0.6);
    `;

    // Panel container (centered, like a dialog)
    const container = document.createElement('div');
    container.style.cssText = `
      position: absolute; top: 48px; left: 260px; right: 16px; bottom: 16px;
      background: #1a1a2e; border-radius: 12px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      overflow: hidden; display: flex; flex-direction: column;
    `;

    // Header bar
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 16px; background: #16213e; border-bottom: 1px solid #2a2a4a;
    `;
    header.innerHTML = `
      <span style="color:#fff;font-size:14px;font-weight:600;">
        ${YMS_ICON_SVG.replace('24px', '18px').replace('24px', '18px')}
        <span style="margin-left:8px;vertical-align:middle;">YMS Multi-Color</span>
      </span>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = `
      background: none; border: none; color: #888; font-size: 18px;
      cursor: pointer; padding: 4px 8px;
    `;
    closeBtn.onclick = () => togglePanel(false);
    header.appendChild(closeBtn);

    // Iframe with the panel
    panelFrame = document.createElement('iframe');
    panelFrame.src = PANEL_URL;
    panelFrame.style.cssText = `
      flex: 1; border: none; width: 100%; background: #1a1a2e;
    `;

    container.appendChild(header);
    container.appendChild(panelFrame);
    overlay.appendChild(container);

    // Click overlay background to close
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) togglePanel(false);
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function togglePanel(forceState) {
    const overlay = document.getElementById('yms-panel-overlay') || createPanel();
    panelVisible = forceState !== undefined ? forceState : !panelVisible;
    overlay.style.display = panelVisible ? 'block' : 'none';
  }

  // ── Keyboard shortcut (Ctrl+Y) ──────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      togglePanel();
    }
  });

  // ── Init: wait for Mainsail and inject ───────────────────────────────
  async function init() {
    try {
      // Wait for Mainsail's navigation list to appear
      const navList = await waitForElement('.v-navigation-drawer .v-list', MAX_WAIT);

      // Small delay to let all nav items render
      await new Promise(r => setTimeout(r, 2000));

      if (injectSidebarButton(navList)) {
        console.log('[YMS] Sidebar button injected into Mainsail');
      } else {
        console.warn('[YMS] Could not inject sidebar button');
      }
    } catch (e) {
      console.warn('[YMS] Mainsail navigation not found, retrying...');
      setTimeout(init, 5000);
    }
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
