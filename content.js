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
