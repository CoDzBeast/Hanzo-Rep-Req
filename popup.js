// popup.js
const HH = (() => {
  const tag = '[HH][Popup]';
  const ts = () => new Date().toISOString();
  return {
    log:  (...a) => console.log(ts(), tag, ...a),
    warn: (...a) => console.warn(ts(), tag, ...a),
    err:  (...a) => console.error(ts(), tag, ...a),
  };
})();

const LABELS_KEY = 'hh_labels_v1';
const JOBS_KEY   = 'hh_jobs_v1';
const listEl = document.getElementById('list');
const sumEl  = document.getElementById('summary');

async function load() {
  HH.log('load invoked'); // Trace popup refresh
  try {
    const all = await chrome.storage.local.get([LABELS_KEY, JOBS_KEY]);
    const labels = Array.isArray(all[LABELS_KEY]) ? all[LABELS_KEY] : [];
    const jobs = Array.isArray(all[JOBS_KEY]) ? all[JOBS_KEY] : [];

    const queued = labels.length;
    const pending = jobs.filter(j => j.status === 'pending' || j.status === 'processing' || j.status === 'retry').length;
    const failed  = jobs.filter(j => j.status === 'failed').length;

    HH.log('queue stats', { queued, pending, failed }); // Log counts for debugging
    sumEl.textContent = `Queued: ${queued} | In-Process: ${pending} | Failed: ${failed}`;

    if (!labels.length) {
      listEl.textContent = 'No labels queued.';
      return;
    }
    const ul = document.createElement('ul');
    labels.forEach(it => {
      const li = document.createElement('li');
      li.textContent = `iOrder ${it.iorder}` + (it.fromOrder ? ` (from #${it.fromOrder})` : '');
      ul.appendChild(li);
    });
    listEl.innerHTML = '';
    listEl.appendChild(ul);
  } catch (e) {
    HH.err('load error', String(e));
    listEl.textContent = 'Error loading queue (check console).';
  }
}

document.getElementById('printAll').addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ type: 'PRINT_ALL' }, () => {
      const err = chrome.runtime.lastError;
      if (err) HH.err('PRINT_ALL send error', err.message);
      else HH.log('PRINT_ALL sent');
    });
  } catch (e) {
    HH.err('PRINT_ALL exception', String(e));
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [LABELS_KEY]: [] });
    HH.log('Queue cleared');
    load();
  } catch (e) {
    HH.err('clear error', String(e));
  }
});

// Live refresh when background updates storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (LABELS_KEY in changes || JOBS_KEY in changes)) {
    HH.log('storage change', { changes }); // Helps trace live updates
    load();
  }
});

load();
