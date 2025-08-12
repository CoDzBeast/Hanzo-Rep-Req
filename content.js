// content.js
// Purpose: Listen ONLY for "Ship It!" clicks inside the shipping modal,
// extract account URL and visible order, and enqueue a background job.

const log = Logger.make('Content');

// ----- Configurable selectors / keywords -----
// Single location to tweak DOM hooks or text matching for demo returns.
// These defaults are intentionally broad; adjust per site structure.
const SEL = {
  demoBoxH4Text: 'Demo Shears',                // Title text to find the correct .boxed
  ordersBox: '#orders_notes_snaps',
  ordersTab: '#orders_tab',
  accordion: '#accordion',
  orderRowMatcher: (n) => `#accordion .rwOrdr`, // we'll filter by textContent includes `#${n}`
  orderPanelByNumber: (n) => `#O${n}`,
  orderOptionsBtn: '.btn.btn-warning.dropdown-toggle',
  viewDemoLabel: 'a[onclick="viewDemoLabel();"]',
  viewRtnLabel:  'a[onclick="viewReturnLabel();"]',
  emailRtnLabel: 'a[onclick="sendReturnLabel();"]',
};

// DO NOT USE: element.click() — always use safeClick
const _click = HTMLElement.prototype.click;
Object.defineProperty(HTMLElement.prototype, 'click', {
  value: function() {
    throw new Error('Direct element.click() is disabled; use safeClick() inside Orders only.');
  }
});

function findDemoBox(){
  return Array.from(document.querySelectorAll('h4'))
    .find(h => (h.textContent || '').trim() === SEL.demoBoxH4Text)
    ?.closest('.boxed') || null;
}

function findOrdersBox(){
  return document.querySelector(SEL.ordersBox);
}

function within(node, root) { return !!(root && node && root.contains(node)); }

function safeClick(el, {demoBox, ordersBox}) {
  if (!el) throw new Error('safeClick: no element');
  if (within(el, demoBox)) {
    throw new Error('SAFEGUARD: attempted click inside Demo Shears box — forbidden');
  }
  if (!within(el, ordersBox)) {
    throw new Error('SAFEGUARD: attempted click outside Orders box — forbidden');
  }
  el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
}


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
// Demo return automation: read demo table, find matching orders, and open return labels
// ---------------------------------------------------------------------------
(function(){
  log.info('demo automation ready');

  const state = { processing: false, done: new Set(), tabActivated: false };
  const cooldowns = new Map();

  document.addEventListener('click', (e) => {
    const demoBox = findDemoBox();
    if (demoBox && within(e.target, demoBox) && e.target.closest('a[target="_new"]')){
      e.preventDefault();
      throw new Error('forbidden');
    }
  }, true);

  // Re-run logic when DOM mutates (table or accordion refreshed)
  const bodyObserver = new MutationObserver(() => {
    try { process(); } catch (e) { log.error('process error', String(e)); }
  });
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  async function process(){
    if (state.processing) return;
    const demoBox = findDemoBox();
    const ordersBox = findOrdersBox();
    const orders = collectDemoOrderNos(demoBox).filter(o => !state.done.has(o));
    if (!orders.length) return;
    logRate('found', `found OUT orders: [${orders.join(',')}]`);
    state.processing = true;
    for (const orderNo of orders){
      await handleOrder(orderNo, { demoBox, ordersBox });
      state.done.add(orderNo);
    }
    state.processing = false;
  }

  // Pull order numbers from Demo Shears without clicking links
  function collectDemoOrderNos(demoBox){
    const body = demoBox?.querySelector('tbody');
    if (!body) return [];
    return Array.from(body.querySelectorAll('tr')).reduce((acc, row) => {
      const status = (row.querySelector('td:nth-child(1)')?.textContent || '').trim().toUpperCase();
      if (status !== 'O') return acc; // only outbound demos
      const orderNo = (row.querySelector('td:nth-child(2) a')?.textContent || '').trim();
      if (orderNo) acc.push(orderNo);
      return acc;
    }, []);
  }

  // Ensure the Orders, Notes tab is visible before searching for orders
  function ensureOrdersTab(ctx){
    const tab = document.querySelector(SEL.ordersTab);
    if (tab && !tab.classList.contains('active')){
      safeClick(tab, ctx);
    }
  }

  // Find the .rwOrdr row whose text contains the order number
  async function findOrderRow(orderNo){
    let ttl = 60000, delay = 200;
    while (ttl > 0){
      const rows = Array.from(document.querySelectorAll(SEL.orderRowMatcher(orderNo)));
      const row = rows.find(r => (r.textContent || '').includes(`#${orderNo}`));
      if (row) return row;
      await sleep(delay);
      ttl -= delay;
      delay = Math.min(delay * 1.5, 1000);
    }
    warnRate(`row-${orderNo}`, 'order row not found', { orderNo });
    return null;
  }

  // Expand the order in the accordion and trigger the appropriate label link
  async function handleOrder(orderNo, ctx){
    ensureOrdersTab(ctx);
    const row = await findOrderRow(orderNo);
    if (!row) return;
    logRate(`open-${orderNo}`, `opening #${orderNo} in Orders`);
    safeClick(row, ctx);
    const panel = await waitForElem(() => document.querySelector(SEL.orderPanelByNumber(orderNo)), 10000);
    if (!panel){ warnRate(`panel-${orderNo}`, 'order panel not found', { orderNo }); return; }
    await waitForElem(() => panel.querySelector('#Ord1, #TItems'), 10000);

    const optionsBtn = panel.querySelector(SEL.orderOptionsBtn);
    if (optionsBtn) safeClick(optionsBtn, ctx);
    await sleep(200); // allow dropdown to render

    const labelLink = panel.querySelector(SEL.viewDemoLabel) ||
      panel.querySelector(SEL.viewRtnLabel) ||
      panel.querySelector(SEL.emailRtnLabel);
    if (!labelLink){ warnRate(`label-${orderNo}`, 'label link missing', { orderNo }); return; }
    safeClick(labelLink, ctx);
    let msg = 'clicked View Demo Label';
    if (labelLink.matches(SEL.viewRtnLabel)) msg = 'clicked View Return Label';
    else if (labelLink.matches(SEL.emailRtnLabel)) msg = 'clicked Email Return Label';
    logRate(`label-${orderNo}`, msg);
  }

  function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

  // Rate-limited warnings to avoid log spam
  function warnRate(key, msg, data){
    const now = Date.now();
    if (cooldowns.get(key) > now) return;
    cooldowns.set(key, now + 5000);
    log.warn(msg, data);
  }

  function logRate(key, msg, data){
    const now = Date.now();
    if (cooldowns.get(key) > now) return;
    cooldowns.set(key, now + 5000);
    log.info(msg, data);
  }

  // Utility: wait for selector or timeout
  function waitForElem(sel, timeout = 5000){
    return new Promise((resolve) => {
      const start = Date.now();
      (function check(){
        const el = typeof sel === 'function' ? sel() : document.querySelector(sel);
        if (el) {
          resolve(el);
        } else if (Date.now() - start > timeout) {
          resolve(null);
        } else {
          setTimeout(check, 100);
        }
      })();
    });
  }

  // Kick things off when script loads
  process();
})();
