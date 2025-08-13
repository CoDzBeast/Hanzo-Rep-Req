// popup.js
const log = createLogger('HH:popup');

// Debug messaging helper identical to background/content versions. It patches
// sendMessage/onMessage to log every exchange and highlight missing replies.
function setupMessageDebug(){
  const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, options, cb) => {
    let opts = options;
    let callback = cb;
    if (typeof options === 'function') {
      callback = options;
      opts = undefined;
    }
    log.debug('sendMessage ->', msg);
    const timer = setTimeout(() => log.warn('sendMessage timeout', msg), 5000);
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
}

// Activate messaging debugging in popup context
setupMessageDebug();

const LABELS_KEY = 'hh_labels_v1';
const JOBS_KEY   = 'hh_jobs_v1';
const listEl = document.getElementById('list');
const sumEl  = document.getElementById('summary');

async function load() {
  log.debug('load invoked');
  try {
    const all = await chrome.storage.local.get([LABELS_KEY, JOBS_KEY]);
    const labels = Array.isArray(all[LABELS_KEY]) ? all[LABELS_KEY] : [];
    const jobs = Array.isArray(all[JOBS_KEY]) ? all[JOBS_KEY] : [];

    const queued = labels.length;
    const pending = jobs.filter(j => j.status === 'pending' || j.status === 'processing' || j.status === 'retry').length;
    const failed  = jobs.filter(j => j.status === 'failed').length;

    log.debug('queue stats', { queued, pending, failed });
    sumEl.textContent = `Queued: ${queued} | In-Process: ${pending} | Failed: ${failed}`;

    if (!labels.length) {
      listEl.textContent = 'No labels queued.';
      return;
    }
    const ul = document.createElement('ul');
      labels.forEach(it => {
        const li = document.createElement('li');
        li.textContent = `Demo Order ${it.demoOrder}` + (it.orderNumber ? ` (from #${it.orderNumber})` : '');
        ul.appendChild(li);
      });
    listEl.innerHTML = '';
    listEl.appendChild(ul);
  } catch (e) {
    log.error('load error', { error: String(e) });
    listEl.textContent = 'Error loading queue (check console).';
  }
}

document.getElementById('printAll').addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ type: 'PRINT_ALL' }, () => {
      const err = chrome.runtime.lastError;
      if (err) log.error('PRINT_ALL send error', { error: err.message });
      else log.debug('PRINT_ALL sent');
    });
  } catch (e) {
    log.error('PRINT_ALL exception', { error: String(e) });
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [LABELS_KEY]: [] });
    log.debug('Queue cleared');
    load();
  } catch (e) {
    log.error('clear error', { error: String(e) });
  }
});

// Live refresh when background updates storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (LABELS_KEY in changes || JOBS_KEY in changes)) {
    log.debug('storage change', { changes });
    load();
  }
});

load();
