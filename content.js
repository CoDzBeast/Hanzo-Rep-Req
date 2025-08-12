// content.js
// Purpose: Listen ONLY for "Ship It!" clicks inside the shipping modal,
// extract account URL and visible order, and enqueue a background job.

// Lightweight, consistent logger for content scope
const HH = (() => {
  const tag = '[HH][Content]';
  const ts = () => new Date().toISOString();
  return {
    log:  (...a) => console.log(ts(), tag, ...a),
    warn: (...a) => console.warn(ts(), tag, ...a),
    err:  (...a) => console.error(ts(), tag, ...a),
  };
})();

// ----- Configurable selectors / keywords -----
// Single location to tweak DOM hooks or text matching for demo returns.
// These defaults are intentionally broad; adjust per site structure.
const OUT_KEYWORDS  = ['O', 'OUT', 'IN USE', 'SIGNED', 'ON LOAN']; // statuses meaning the demo is out
const SELECTORS = {
  table: 'table', // account table containing demo rows
  orderLink: 'td:nth-child(2) a', // order number link within a row
  modalRoot: '.modal-dialog .modal-content', // root element of the shipping/demo modal
  viewLabelBtn: '[onclick*="viewReturnLabel"], a[href*="viewReturnLabel"]', // preferred action
  emailLabelBtn: '[onclick*="sendReturnLabel"], a[href*="sendReturnLabel"]', // fallback action
};

// Generic step logger for timestamped start/finish of async steps
const DBG = {
  async step(name, fn){
    const start = Date.now();
    HH.log(`STEP:${name}:start`, { t: start });
    try {
      const res = await fn();
      HH.log(`STEP:${name}:finish`, { dt: Date.now() - start });
      return res;
    } catch (e) {
      HH.err(`STEP:${name}:error`, String(e));
      throw e;
    }
  }
};

// Patch runtime messaging for detailed logging and timeout detection. This
// mirrors the helper used in background.js so we can trace every message in
// both directions.
function setupMessageDebug(){
  // Wrap sendMessage
  const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, options, cb) => {
    let opts = options;
    let callback = cb;
    if (typeof options === 'function') {
      callback = options;
      opts = undefined;
    }
    HH.log('sendMessage ->', msg);
    const timer = setTimeout(() => HH.warn('sendMessage timeout', msg), 5000);
    const wrappedCb = (...args) => {
      clearTimeout(timer);
      HH.log('sendMessage <- reply', msg, args);
      if (callback) callback(...args);
    };
    try {
      return opts !== undefined ? origSend(msg, opts, wrappedCb) : origSend(msg, wrappedCb);
    } catch (e) {
      clearTimeout(timer);
      HH.err('sendMessage exception', String(e), msg);
      throw e;
    }
  };

  // Wrap onMessage listener
  const origAdd = chrome.runtime.onMessage.addListener;
  chrome.runtime.onMessage.addListener = (fn) => {
    const wrapped = (msg, sender, sendResponse) => {
      HH.log('onMessage <-', msg, { sender });
      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) HH.warn('onMessage handler timeout', msg);
      }, 5000);
      const wrappedSend = (...args) => {
        responded = true;
        clearTimeout(timer);
        HH.log('onMessage -> reply', msg, args);
        try { sendResponse(...args); }
        catch (e) { HH.err('sendResponse error', String(e)); }
      };
      let result = false;
      try {
        result = fn(msg, sender, wrappedSend);
      } catch (e) {
        clearTimeout(timer);
        HH.err('onMessage handler exception', String(e));
        throw e;
      }
      if (result !== true) {
        responded = true;
        clearTimeout(timer);
      }
      return result;
    };
    origAdd.call(chrome.runtime.onMessage, wrapped);
  };

  // Wrap runtime.connect to trace long-lived ports and avoid premature closure
  const origConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = (...args) => {
    HH.log('connect ->', args);
    const port = origConnect(...args);
    const name = (args[0] && args[0].name) || '';
    port.onMessage.addListener((msg) => HH.log(`port ${name} <-`, msg));
    const origPost = port.postMessage.bind(port);
    port.postMessage = (msg) => {
      HH.log(`port ${name} ->`, msg);
      origPost(msg);
    };
    const origDisc = port.disconnect.bind(port);
    port.disconnect = () => {
      HH.log(`port ${name} disconnect`);
      origDisc();
    };
    return port;
  };
}

// Activate messaging debugging in content context
setupMessageDebug();

(function () {
  // Defensive: make sure we only attach once (pages with partial reloads/modals)
  if (window.__HH_CONTENT_ATTACHED__) {
    HH.log('listener already attached; skipping re-attach');
    return;
  }
  window.__HH_CONTENT_ATTACHED__ = true;
  HH.log('attaching Ship It! listener');

  document.addEventListener('click', (e) => {
    const shipBtn = e.target.closest('#SI'); // "Ship It!" button inside the modal
    if (!shipBtn) return;

    // Find the current modal context
    const modal = shipBtn.closest('.modal-content');
    if (!modal) {
      // Added debug: helps if DOM structure changes
      HH.err('Ship It! clicked but .modal-content not found');
      return;
    }

    // Read data BEFORE modal closes / next modal opens
    const accountUrlEl = modal.querySelector('#Cust0');
    const accountUrl = accountUrlEl?.getAttribute('href') || null; // e.g. /cgi-bin/AccountInfo.cfm?iP=226963
    const visibleOrder = (modal.querySelector('#iOrd1')?.textContent || '').trim() || null;

    // Log values early to trace DOM extraction issues.
    HH.log('Ship It! captured', { accountUrl, visibleOrder });

    if (!accountUrl) {
      // Clear message why job not enqueued
      HH.err('Account URL (#Cust0) missing; job NOT enqueued', { visibleOrder });
      return;
    }

    const job = {
      accountUrl,
      visibleOrder,
      createdAt: Date.now(),
      jobId: `job_${Date.now()}_${Math.random().toString(36).slice(2,7)}`
    };

    try {
      // Send before the page navigates away; capturing listener fires prior to
      // any default navigation triggered by the button click.
      chrome.runtime.sendMessage({ type: 'ENQUEUE_SHIP_JOB', job }, () => {
        // Runtime errors (e.g., service worker asleep) surface here
        const err = chrome.runtime.lastError;
        if (err) {
          HH.err('Failed to send ENQUEUE_SHIP_JOB', err.message, job);
        } else {
          HH.log('ENQUEUE_SHIP_JOB sent', job);
        }
      });
    } catch (ex) {
      HH.err('Exception while sending ENQUEUE_SHIP_JOB', String(ex), job);
    }
  }, { capture: true });

  // Optional: if "Ship It!" can be triggered by keyboard submit, we rely on the click path (site uses onclick).
  // If needed later, we can add form submit interception with the same payload.
})();

// ---------------------------------------------------------------------------
// Demo return automation: auto-click demo order and fetch return label
// ---------------------------------------------------------------------------
(function(){
  HH.log('demo automation ready');

  const state = {
    orderClicked: false,
    labelClicked: false,
  };

  // Re-run logic when DOM mutates (table or modal replaced)
  const bodyObserver = new MutationObserver(() => {
    try { process(); } catch (e) { HH.err('process error', String(e)); }
  });
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Main process orchestrator
  async function process(){
    if (state.orderClicked) return; // already acted
    const table = await DBG.step('waitTable', () => waitForElem(SELECTORS.table, 10000));
    if (!table) return; // timeout logged by waitForElem

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const target = rows.find(r => {
      const status = (r.querySelector('td')?.textContent || '').trim().toUpperCase();
      return OUT_KEYWORDS.some(k => status.includes(k));
    });
    if (!target) {
      HH.warn('no out row found yet');
      return;
    }

    const link = target.querySelector(SELECTORS.orderLink);
    if (!link) {
      HH.err('order link not found in target row');
      return;
    }
    const ord = link.textContent.trim();
    HH.log('clicking order', ord);
    state.orderClicked = true;
    link.click();
    waitForModal();
  }

  // Wait for modal, then click view/email return label
  async function waitForModal(retry = 0){
    const modal = await DBG.step('waitModal', () => waitForElem(SELECTORS.modalRoot, 10000));
    if (!modal) {
      if (retry < 5) {
        const delay = 500 * Math.pow(2, retry);
        HH.warn('modal not found; retrying', { retry, delay });
        setTimeout(() => waitForModal(retry + 1), delay);
      }
      return;
    }

    await DBG.step('modalStabilize', () => waitForStable(modal));

    if (state.labelClicked) return; // idempotent
    const viewBtn = modal.querySelector(SELECTORS.viewLabelBtn);
    if (viewBtn) {
      HH.log('clicking View Rtn Label');
      state.labelClicked = true;
      viewBtn.click();
      return;
    }
    const emailBtn = modal.querySelector(SELECTORS.emailLabelBtn);
    if (emailBtn) {
      HH.log('clicking Email Rtn Label');
      state.labelClicked = true;
      emailBtn.click();
      return;
    }

    // Fallback to calling global functions if buttons absent
    if (typeof window.viewReturnLabel === 'function') {
      HH.log('calling viewReturnLabel()');
      state.labelClicked = true;
      window.viewReturnLabel();
      return;
    }
    if (typeof window.sendReturnLabel === 'function') {
      HH.log('calling sendReturnLabel()');
      state.labelClicked = true;
      window.sendReturnLabel();
      return;
    }

    if (retry < 5) {
      const delay = 500 * Math.pow(2, retry);
      HH.warn('label action missing; retrying', { retry, delay });
      setTimeout(() => waitForModal(retry + 1), delay);
    }
  }

  // Utility: wait for selector or timeout
  function waitForElem(sel, timeout = 5000){
    return new Promise((resolve) => {
      const start = Date.now();
      (function check(){
        const el = document.querySelector(sel);
        if (el) {
          HH.log('selector found', sel);
          resolve(el);
        } else if (Date.now() - start > timeout) {
          HH.warn('selector timeout', sel);
          resolve(null);
        } else {
          setTimeout(check, 100);
        }
      })();
    });
  }

  // Utility: wait for element to stay stable (no DOM mutations) for 500ms
  function waitForStable(el, idle = 500){
    return new Promise((resolve) => {
      let timer = setTimeout(done, idle);
      const mo = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, idle);
      });
      function done(){
        mo.disconnect();
        resolve();
      }
      mo.observe(el, { childList: true, subtree: true });
    });
  }

  // Kick things off when script loads
  process();
})();
