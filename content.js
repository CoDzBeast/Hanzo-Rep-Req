// content.js
// Purpose: Listen ONLY for "Ship It!" clicks inside the shipping modal,
// extract account URL and visible order, and enqueue a background job.

const log = Logger.make('Content');

// ----- Configurable selectors / keywords -----
// Single location to tweak DOM hooks or text matching for demo returns.
// These defaults are intentionally broad; adjust per site structure.
const OUT_KEYWORDS  = ['O', 'OUT', 'IN USE', 'SIGNED', 'ON LOAN']; // statuses meaning the demo is out
const SELECTORS = {
  table: 'table', // legacy account table containing demo rows
  orderLink: 'td:nth-child(2) a', // order number link within a row (legacy)
  orderPanel: '.phOrder', // new order container used on updated pages
  orderHeader: '.rwOrdr', // clickable order header row within a panel
  modalRoot: '.modal-dialog .modal-content', // root element of the shipping/demo modal
  viewLabelBtn: '[onclick*="viewReturnLabel"], a[href*="viewReturnLabel"]', // preferred action
  emailLabelBtn: '[onclick*="sendReturnLabel"], a[href*="sendReturnLabel"]', // fallback action
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
    log.debug('sendMessage ->', { msg });
    const timer = setTimeout(() => log.warn('sendMessage timeout', { msg }), 5000);
    const wrappedCb = (...args) => {
      clearTimeout(timer);
      log.debug('sendMessage <- reply', { msg, args });
      if (callback) callback(...args);
    };
    try {
      return opts !== undefined ? origSend(msg, opts, wrappedCb) : origSend(msg, wrappedCb);
    } catch (e) {
      clearTimeout(timer);
      log.error('sendMessage exception', { error: String(e), msg });
      throw e;
    }
  };

  // Wrap onMessage listener
  const origAdd = chrome.runtime.onMessage.addListener;
  chrome.runtime.onMessage.addListener = (fn) => {
    const wrapped = (msg, sender, sendResponse) => {
      log.debug('onMessage <-', { msg, sender });
      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) log.warn('onMessage handler timeout', { msg });
      }, 5000);
      const wrappedSend = (...args) => {
        responded = true;
        clearTimeout(timer);
        log.debug('onMessage -> reply', { msg, args });
        try { sendResponse(...args); }
        catch (e) { log.error('sendResponse error', { error: String(e) }); }
      };
      let result = false;
      try {
        result = fn(msg, sender, wrappedSend);
      } catch (e) {
        clearTimeout(timer);
        log.error('onMessage handler exception', { error: String(e) });
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
    log.debug('connect ->', { args });
    const port = origConnect(...args);
    const name = (args[0] && args[0].name) || '';
    port.onMessage.addListener((msg) => log.debug(`port ${name} <-`, { msg }));
    const origPost = port.postMessage.bind(port);
    port.postMessage = (msg) => {
      log.debug(`port ${name} ->`, { msg });
      origPost(msg);
    };
    const origDisc = port.disconnect.bind(port);
    port.disconnect = () => {
      log.debug(`port ${name} disconnect`);
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
    log.info('listener already attached; skipping re-attach');
    return;
  }
  window.__HH_CONTENT_ATTACHED__ = true;
  log.info('attaching Ship It! listener');

  document.addEventListener('click', (e) => {
    const shipBtn = e.target.closest('#SI'); // "Ship It!" button inside the modal
    if (!shipBtn) return;

    // Find the current modal context
    const modal = shipBtn.closest('.modal-content');
    if (!modal) {
      // Added debug: helps if DOM structure changes
      log.error('Ship It! clicked but .modal-content not found');
      return;
    }

    // Read data BEFORE modal closes / next modal opens
    const accountUrlEl = modal.querySelector('#Cust0');
    const accountUrl = accountUrlEl?.getAttribute('href') || null; // e.g. /cgi-bin/AccountInfo.cfm?iP=226963
    const visibleOrder = (modal.querySelector('#iOrd1')?.textContent || '').trim() || null;

    // Log values early to trace DOM extraction issues.
    log.debug('Ship It! captured', { accountUrl, visibleOrder });

    if (!accountUrl) {
      // Clear message why job not enqueued
      log.error('Account URL (#Cust0) missing; job NOT enqueued', { visibleOrder });
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
          log.error('Failed to send ENQUEUE_SHIP_JOB', err.message, job);
        } else {
          log.debug('ENQUEUE_SHIP_JOB sent', { job });
        }
      });
    } catch (ex) {
      log.error('Exception while sending ENQUEUE_SHIP_JOB', String(ex), job);
    }
  }, { capture: true });

  // Optional: if "Ship It!" can be triggered by keyboard submit, we rely on the click path (site uses onclick).
  // If needed later, we can add form submit interception with the same payload.
})();

// ---------------------------------------------------------------------------
// Demo return automation: auto-click demo order and fetch return label
// ---------------------------------------------------------------------------
(function(){
  log.info('demo automation ready');

  const state = { orderClicked: false, labelClicked: false, searching: false };
  const cooldowns = new Map();

  // Re-run logic when DOM mutates (table or modal replaced)
  const bodyObserver = new MutationObserver(() => {
    try { process(); } catch (e) { log.error('process error', String(e)); }
  });
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  async function process(){
    if (state.orderClicked || state.searching) return;
    state.searching = true;
    const rows = await waitForDemoRows();
    state.searching = false;
    if (!rows.length) return;
    const targetRow = rows[0];
    const orderNo = (targetRow.querySelector('td:nth-child(2)')?.textContent || '').trim();
    if (!orderNo) return;
    if (cooldowns.get(orderNo) > Date.now()) return;
    const link = await ensureOrderLink(targetRow, orderNo);
    if (!link) { cooldowns.set(orderNo, Date.now() + 10000); return; }
    log.info('clicking order', { orderNo });
    state.orderClicked = true;
    link.click();
    waitForModal();
  }

  function findDemoOutRows(){
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.filter(r => {
      const cells = Array.from(r.querySelectorAll('td'));
      const texts = cells.map(td => (td.textContent || '').trim().toUpperCase());
      return texts.some(t => OUT_KEYWORDS.some(k => k.length === 1 ? t === k : t.includes(k)));
    });
  }

  async function waitForDemoRows(maxMs = 60000){
    let delay = 300, ttl = maxMs;
    let started = false;
    while (ttl > 0){
      const rows = findDemoOutRows();
      if (rows.length){
        if (started) log.info('demo/out rows found', { count: rows.length });
        return rows;
      }
      if (!started){ log.debug('waiting for demo/out rows'); started = true; }
      log.debug('no demo/out row yet', { delay });
      await sleep(delay);
      ttl -= delay;
      delay = Math.min(delay * 2, 3000);
    }
    log.warn('demo/out rows not found after ttl', { maxMs });
    return [];
  }

  async function ensureOrderLink(row, orderNo){
    const selectorsTried = [SELECTORS.orderHeader, SELECTORS.orderLink];
    let link = row.querySelector(SELECTORS.orderHeader) || row.querySelector(SELECTORS.orderLink);
    if (link) return link;
    const counts = {
      panels: document.querySelectorAll(SELECTORS.orderPanel).length,
      headers: document.querySelectorAll(SELECTORS.orderHeader).length,
    };
    let textScan = false;
    if (!document.querySelector(SELECTORS.orderPanel)) {
      refreshOrdersAccordion();
      await sleep(200);
      link = row.querySelector(SELECTORS.orderHeader) || row.querySelector(SELECTORS.orderLink);
      if (link) return link;
    }
    if (!link && counts.headers === 0){
      textScan = true;
      link = Array.from(document.querySelectorAll('a, span, div')).find(el => (el.textContent || '').trim() === orderNo);
      if (link) return link;
    }
    log.warn('order link not found', { orderNo, selectorsTried, counts, textScan });
    return null;
  }

  function refreshOrdersAccordion(){
    const toggle = Array.from(document.querySelectorAll('a,button')).find(el => /Orders/i.test(el.textContent || ''));
    if (toggle) toggle.click();
  }

  function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

  // Wait for modal, then click view/email return label
  async function waitForModal(retry = 0){
    const modal = await log.step('waitModal', () => waitForElem(SELECTORS.modalRoot, 10000));
    if (!modal) {
      if (retry < 5) {
        const delay = 500 * Math.pow(2, retry);
        log.warn('modal not found; retrying', { retry, delay });
        setTimeout(() => waitForModal(retry + 1), delay);
      }
      return;
    }

    await log.step('modalStabilize', () => waitForStable(modal));

    if (state.labelClicked) return; // idempotent
    const viewBtn = modal.querySelector(SELECTORS.viewLabelBtn);
    if (viewBtn) {
      log.info('clicking View Rtn Label');
      state.labelClicked = true;
      viewBtn.click();
      return;
    }
    const emailBtn = modal.querySelector(SELECTORS.emailLabelBtn);
    if (emailBtn) {
      log.info('clicking Email Rtn Label');
      state.labelClicked = true;
      emailBtn.click();
      return;
    }

    // Fallback to calling global functions if buttons absent
    if (typeof window.viewReturnLabel === 'function') {
      log.info('calling viewReturnLabel()');
      state.labelClicked = true;
      window.viewReturnLabel();
      return;
    }
    if (typeof window.sendReturnLabel === 'function') {
      log.info('calling sendReturnLabel()');
      state.labelClicked = true;
      window.sendReturnLabel();
      return;
    }

    if (retry < 5) {
      const delay = 500 * Math.pow(2, retry);
      log.warn('label action missing; retrying', { retry, delay });
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
          log.debug('selector found', { sel });
          resolve(el);
        } else if (Date.now() - start > timeout) {
          log.warn('selector timeout', { sel });
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
