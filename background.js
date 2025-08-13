/* background.js */
/* global PDFLib */

importScripts('logger.js');
const log = createLogger('HH:bg');
const queueLog = createLogger('HH:queue');
const labelLog = createLogger('HH:label');

function applyPreset(preset){
  chrome.storage.local.set(preset, () => {
    const err = chrome.runtime.lastError;
    if (err) log.error('applyPreset error', { error: err.message });
    else log.info('preset applied', preset);
  });
}

function setupMenus(){
  try {
    chrome.contextMenus.create({ id: 'preset-quiet', title: 'Quiet', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'preset-focus', title: 'Focus Label Debug', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'preset-trace', title: 'Full Trace', contexts: ['action'] });
  } catch {}
}

chrome.contextMenus?.onClicked.addListener(info => {
  if (info.menuItemId === 'preset-quiet') {
    applyPreset({ logLevel:'warn', enableNamespaces:[], sampling:{}, rateLimit:{ windowMs:2000, maxPerWindow:20 } });
  } else if (info.menuItemId === 'preset-focus') {
    applyPreset({ logLevel:'debug', enableNamespaces:['HH:label'], sampling:{}, rateLimit:{ windowMs:2000, maxPerWindow:20 } });
  } else if (info.menuItemId === 'preset-trace') {
    applyPreset({ logLevel:'trace', enableNamespaces:['HH:*'], sampling:{ trace:0.2 }, rateLimit:{ windowMs:2000, maxPerWindow:20 } });
  }
});

// Debug wrapper for runtime messaging to trace send/receive and timeouts.
// Each context (background, content, popup) calls this to patch the default
// chrome.runtime messaging APIs. We log all messages with timestamps and flag
// any responses that do not arrive within 5s.
function setupMessageDebug(){
  // Wrap sendMessage
  const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (msg, options, cb) => {
    let opts = options;
    let callback = cb;
    if (typeof options === 'function') { // sendMessage(msg, cb)
      callback = options;
      opts = undefined;
    }
    log.debug('sendMessage ->', { msg });
    const timer = setTimeout(() => {
      log.warn('sendMessage timeout', { msg });
    }, 5000);
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

  // Wrap onMessage.addListener
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

// Activate messaging debug for this background context
setupMessageDebug();

// Attempt to load pdf-lib; log explicit error if file missing or path wrong.
// This prevents silent failure when deploying from GitHub/Codex.
try {
  importScripts('pdf-lib.min.js');
} catch (e) {
  log.error('importScripts pdf-lib.min.js failed', String(e));
}

const ORIGIN = 'https://www.hattorihanzoshears.com';

// Storage keys
const JOBS_KEY   = 'hh_jobs_v1';   // [{jobId, accountUrl, visibleOrder, status, tries, nextAt, createdAt}]
const LABELS_KEY = 'hh_labels_v1'; // [{demoOrder, url, orderNumber}]
const LOCK_KEY   = 'hh_jobs_lock_v1';

const MAX_TRIES = 3;
const HEARTBEAT_MIN = 0.25; // 15s

// Sanity check: pdf-lib availability
if (!self.PDFLib || !PDFLib.PDFDocument) {
  log.error('pdf-lib not loaded. Ensure pdf-lib.min.js is present and importScripts succeeded.');
}

// ---------- Storage helpers with debug ----------
async function get(key, def){
  try {
    const obj = await chrome.storage.local.get(key);
    return (key in obj) ? obj[key] : def;
  } catch (e) {
    log.error('storage.get failed', { key, error: String(e) });
    return def;
  }
}
async function set(key, val){
  try {
    await chrome.storage.local.set({ [key]: val });
  } catch (e) {
    log.error('storage.set failed', { key, error: String(e), val });
  }
}

// ---------- Job enqueue / labels ----------
async function enqueueJob(job){
  log.info('enqueueJob', job);
  const jobs = await get(JOBS_KEY, []);
  jobs.push({ ...job, status: 'pending', tries: 0, nextAt: 0 });
  await set(JOBS_KEY, jobs);
  // Kick the processor without awaiting so we can respond to the sender
  // immediately. Any errors are logged.
  runProcessor().catch(e => log.error('runProcessor enqueue error', String(e)));
}

async function pushLabel(item){
  log.info('pushLabel', item);
  const labels = await get(LABELS_KEY, []);
  if (!labels.find(x => x.demoOrder === item.demoOrder)) {
    labels.push(item);
    await set(LABELS_KEY, labels);
  } else {
    log.warn('label duplicate ignored (demoOrder de-dupe)', item.demoOrder);
  }
}

// ---------- PDF capture helpers ----------
const expecting = new Map(); // tabId -> {until,iorder,navigation,tabIds:Set,resolve}

function looksLikePdf(url = ''){
  const u = String(url).toLowerCase();
  return u.endsWith('.pdf') || u.includes('pdf=') || u.includes('/pdf/') || u.includes('label');
}

function handlePdfCandidate(tabId, url, origin = ''){
  const info = expecting.get(tabId);
  if (info) info.navigation = true;
  if (!url) return;
  if (looksLikePdf(url)) {
    labelLog.debug(`PDF captured via: ${origin}`, { tabId, iorder: info?.iorder || null, url });
    resolvePdfForTab(tabId, url);
  }
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(({tabId, sourceTabId, url}) => {
  const info = expecting.get(sourceTabId);
  if (!info) return;
  info.navigation = true;
  expecting.set(tabId, info);
  info.tabIds.add(tabId);
  if (looksLikePdf(url)) {
    labelLog.debug('PDF captured via: onCreatedNavigationTarget', { url, iorder: info?.iorder || null });
    resolvePdfForTab(sourceTabId, url);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const info = expecting.get(tabId);
  if (!info) return;
  if (changeInfo.url) info.navigation = true;
  if (changeInfo.url && looksLikePdf(changeInfo.url)) {
    labelLog.debug('PDF captured via: tabs.onUpdated', { url: changeInfo.url, iorder: info?.iorder || null });
    resolvePdfForTab(tabId, changeInfo.url);
  }
});

function resolvePdfForTab(tabId, url){
  const info = expecting.get(tabId);
  if (!info) return;
  for (const id of info.tabIds) expecting.delete(id);
  try { info.resolve({ url, navigation: true }); } catch {}
}

// ---------- Simple storage-backed lock ----------
async function withLock(fn){
  const now = Date.now();
  const curr = await get(LOCK_KEY, { locked:false, ts:0 });
  // 15s stale window: prevents stuck locks from blocking forever
  if (curr.locked && (now - curr.ts) < 15000) {
    queueLog.trace('lock busy');
    return;
  }
  queueLog.trace('lock acquiring');
  await set(LOCK_KEY, { locked:true, ts:now });
  queueLog.trace('lock acquired');
  try { await fn(); }
  catch (e) { log.error('withLock fn error', String(e)); }
  finally {
    await set(LOCK_KEY, { locked:false, ts:Date.now() });
    queueLog.trace('lock released');
  }
}

// ---------- Messages / startup / heartbeat ----------
// Main message listener. We always send a response to prevent the message
// channel from closing prematurely. Returning true keeps the service worker
// alive until the async work completes.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ENQUEUE_SHIP_JOB') {
    enqueueJob(msg.job)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log.error('enqueueJob error', String(e), msg.job);
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }
  if (msg?.type === 'PRINT_ALL') {
    printAllMerged()
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        log.error('printAllMerged error', String(e));
        sendResponse({ ok: false, error: String(e) });
      });
    return true;
  }
  if (msg?.type === 'EXPECT_PDF') {
    const tabId = sender?.tab?.id;
    if (tabId) {
      const info = expecting.get(tabId);
      if (info) info.until = Date.now() + 45000;
      else expecting.set(tabId, { until: Date.now() + 45000, iorder: msg.iorder, navigation: false, tabIds: new Set([tabId]) });
    }
    sendResponse(true);
    return true;
  }
  if (msg?.type === 'PDF_CANDIDATE_URL') {
    handlePdfCandidate(sender?.tab?.id, msg.url, msg.origin);
    sendResponse(true);
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => {
  queueLog.trace('onStartup kick');
  runProcessor().catch(e => log.error('runProcessor onStartup error', String(e)));
});
chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  applyPreset({ logLevel:'warn', enableNamespaces:[], sampling:{}, rateLimit:{ windowMs:2000, maxPerWindow:20 } });
  queueLog.trace('onInstalled kick');
  runProcessor().catch(e => log.error('runProcessor onInstalled error', String(e)));
});

chrome.alarms.create('hh_job_heartbeat', { periodInMinutes: HEARTBEAT_MIN });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'hh_job_heartbeat') {
    queueLog.trace('heartbeat');
    runProcessor().catch(e => log.error('runProcessor heartbeat error', String(e)));
  }
});

// ---------- Processor ----------
// Process queued jobs. Converted to loop to avoid deep recursion with many jobs.
// Each iteration processes at most one job and then re-checks the queue.
async function runProcessor(){
  await withLock(async () => {
    while (true) {
      queueLog.trace('checking queue');
      let jobs = await get(JOBS_KEY, []);
      const now = Date.now();

      // choose next eligible job
      const idx = jobs.findIndex(j => (j.status === 'pending' || j.status === 'retry') && (j.nextAt || 0) <= now);
      if (idx === -1) {
        queueLog.trace('no eligible jobs');
        break;
      }

      const job = jobs[idx];
      jobs[idx].status = 'processing';
      await set(JOBS_KEY, jobs);

      queueLog.trace('processing job', job);

      try {
        await processJob(job);

        // success -> remove
        jobs = await get(JOBS_KEY, []);
        const pos = jobs.findIndex(j => j.jobId === job.jobId);
        if (pos > -1) { jobs.splice(pos, 1); await set(JOBS_KEY, jobs); }
        queueLog.trace('job completed', { jobId: job.jobId });

        // notify (optional)
        try {
          chrome.notifications.create(undefined, {
            type: 'basic',
            title: 'Label queued',
            message: `Order ${job.visibleOrder || ''} added`
          });
        } catch {}
      } catch (err) {
        const reason = (err && err.message) ? err.message : String(err);
        log.warn('Job failed', { jobId: job.jobId, reason });

        // schedule retry or mark failed
        jobs = await get(JOBS_KEY, []);
        const pos = jobs.findIndex(j => j.jobId === job.jobId);
        if (pos > -1) {
          const tries = (jobs[pos].tries ?? 0) + 1;
          if (tries >= MAX_TRIES) {
            jobs[pos].status = 'failed';
            jobs[pos].tries = tries;
            log.error('Job permanently failed', { jobId: job.jobId, tries, reason });
          } else {
            const backoff = Math.min(30000, 1000 * Math.pow(2, tries)); // 2s,4s,8s...
            jobs[pos].status = 'retry';
            jobs[pos].tries = tries;
            jobs[pos].nextAt = Date.now() + backoff;
            log.warn('Job scheduled for retry', { jobId: job.jobId, tries, backoffMs: backoff, reason });
          }
          await set(JOBS_KEY, jobs);
        }
      }

      // After processing, check if more work is ready immediately.
      const more = (await get(JOBS_KEY, [])).some(j =>
        (j.status === 'pending') || (j.status === 'retry' && (j.nextAt || 0) <= Date.now())
      );
      if (!more) {
        queueLog.trace('processor idle');
        break;
      }
      // Loop continues to process next job
    }
  });
}

// ---------- Per-job work ----------
async function processJob(job){
  const accountUrl = job.accountUrl ? (job.accountUrl.startsWith('http') ? job.accountUrl : ORIGIN + job.accountUrl) : null;
  if (!accountUrl) {
    // Clear error explains why; used in retry decision
    throw new Error('No accountUrl');
  }

  // 1) Open account page in background
  const { id: tabId } = await chrome.tabs.create({ url: accountUrl, active: false });
  labelLog.debug('account tab opened', { tabId, accountUrl });
  await waitComplete(tabId);

  // 2) Find order row (matching visibleOrder if provided) and extract demo order
  const [{ result: demoOrder }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: (visibleOrder) => {
      function getIOrder(href){
        const m = /[?&]iorder=(\d+)/i.exec(href || '');
        return m ? m[1] : null;
      }
      const rows = Array.from(document.querySelectorAll('tr'));
      let cand = null;
      if (visibleOrder) {
        cand = rows.find(r => {
          const text = r.textContent || '';
          return text.includes(`#${visibleOrder}`) && r.querySelector('a[href*="my_inventory.cfm"][href*="iorder="]');
        });
      }
      if (!cand) {
        // Fallback: bottom "O" row
        cand = rows.reverse().find(r => {
          const tds = r.querySelectorAll('td');
          if (!tds.length) return false;
          const first = (tds[0].textContent || '').trim();
          return first === 'O' && r.querySelector('a[href*="my_inventory.cfm"][href*="iorder="]');
        });
      }
      if (!cand) return null;
      const a = cand.querySelector('a[href*="my_inventory.cfm"][href*="iorder="]');
      return getIOrder(a?.getAttribute('href'));
    },
    args: [job.visibleOrder || null]
  });

  if (!demoOrder) {
    try { await chrome.tabs.remove(tabId); } catch {}
    throw new Error('No demo order found (O-row not present or structure changed)');
  }
  labelLog.debug('mapped to iorder', { visibleOrder: job.visibleOrder || null, iorder: demoOrder });

  // 3) Try to generate/capture PDF URL with retries/backoff
  const pdfUrl = await openLabelAndCapturePdf(tabId, demoOrder, job.visibleOrder || null);
  if (!pdfUrl) {
    try { await chrome.tabs.remove(tabId); } catch {}
    throw new Error('No PDF URL captured (label click produced no PDF)');
  }
  labelLog.debug('pdf url captured', { iorder: demoOrder, url: pdfUrl });

  // 4) Save to labels queue
  await pushLabel({ demoOrder, orderNumber: job.visibleOrder || null, url: pdfUrl });

  try { await chrome.tabs.remove(tabId); } catch {}
  queueLog.trace('account tab closed', { tabId });
}

function waitComplete(tabId){
  return new Promise(resolve => {
    function onUpd(id, info){
      if (id === tabId && info.status === 'complete'){
        chrome.tabs.onUpdated.removeListener(onUpd);
        queueLog.trace('tab complete', { tabId });
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function openLabelAndCapturePdf(tabId, iorder, visibleOrder){
  const delays = [1500, 3000, 6000, 10000, 15000];
  for (const delay of delays){
    labelLog.debug('backoff attempt', { iorder, visibleOrder, delayMs: delay });
    const result = await attemptOnce(tabId, iorder, visibleOrder, delay);
    if (result.url) {
      labelLog.debug('backoff success', { iorder, url: result.url });
      return result.url;
    }
    if (result.navigation) {
      labelLog.debug('navigation without pdf', { iorder });
      return null; // navigation happened but no pdf
    }
  }
  labelLog.warn('backoff exhausted', { iorder });
  return null;
}

function attemptOnce(tabId, iorder, visibleOrder, delay){
  return new Promise(async resolve => {
    const info = { until: Date.now() + delay, iorder, navigation: false, tabIds: new Set([tabId]) };
    info.resolve = (res) => { clearTimeout(timer); cleanup(); resolve(res); };
    function cleanup(){ for (const id of info.tabIds) expecting.delete(id); }
    expecting.set(tabId, info);
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'OPEN_ORDER_AND_CLICK_LABEL', iorder, visibleOrder });
    } catch (e) {
      cleanup();
      resolve({ url: null, navigation: true });
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve({ url: null, navigation: info.navigation }); }, delay);
  });
}

// ---------- Print All: fetch, merge, print once ----------
async function printAllMerged(){
  log.info('printAll: starting');
  const queue = await get(LABELS_KEY, []);
  if (!queue.length) {
    log.warn('printAll: no labels queued');
    return;
  }

  // Fetch all PDFs; collect failures for visibility
  const pdfBuffers = [];
  const failures = [];
  for (const item of queue) {
    try {
      const res = await fetch(item.url, { credentials: 'include' });
      if (!res.ok) {
        failures.push({ demoOrder: item.demoOrder, status: res.status });
        continue;
      }
      pdfBuffers.push(await res.arrayBuffer());
    } catch (e) {
      failures.push({ demoOrder: item.demoOrder, err: String(e) });
    }
  }
  if (!pdfBuffers.length) {
    log.error('printAll: no PDFs fetched; aborting', { failures });
    return;
  }
  if (failures.length) log.warn('printAll: some PDFs failed to fetch', failures);

  if (!PDFLib || !PDFLib.PDFDocument) {
    log.error('printAll: PDFLib not available; cannot merge');
    return;
  }

  try {
    const { PDFDocument } = PDFLib;
    const merged = await PDFDocument.create();
    for (const b of pdfBuffers) {
      const doc = await PDFDocument.load(b);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const out = await merged.save();
    const blobUrl = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));

    const { id: tabId } = await chrome.tabs.create({ url: 'about:blank', active: false });
    log.info('printAll: temp tab created', { tabId });

    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (url) => {
        try {
          document.body.style.margin = '0';
          const iframe = document.createElement('iframe');
          iframe.style.width = '100vw';
          iframe.style.height = '100vh';
          iframe.style.border = '0';
          iframe.src = url;
          document.body.appendChild(iframe);
          iframe.onload = () => {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          };
        } catch {}
      },
      args: [blobUrl]
    });

    // optional: clear queue & close the temp tab after printing
    setTimeout(async () => {
      log.info('printAll: clearing queue and closing print tab', { tabId });
      await set(LABELS_KEY, []);
      try { await chrome.tabs.remove(tabId); } catch {}
    }, 4000);
  } catch (e) {
    log.error('printAll merge/print error', String(e));
  }
}
