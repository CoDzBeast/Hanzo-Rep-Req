/* background.js */
/* global PDFLib */

// Consistent logger for background scope. Defined before imports so we can log
// issues during importScripts.
const HH = (() => {
  const tag = '[HH][BG]';
  const ts = () => new Date().toISOString();
  return {
    log:  (...a) => console.log(ts(), tag, ...a),
    warn: (...a) => console.warn(ts(), tag, ...a),
    err:  (...a) => console.error(ts(), tag, ...a),
  };
})();

// Attempt to load pdf-lib; log explicit error if file missing or path wrong.
// This prevents silent failure when deploying from GitHub/Codex.
try {
  importScripts('pdf-lib.min.js');
} catch (e) {
  HH.err('importScripts pdf-lib.min.js failed', String(e));
}

const ORIGIN = 'https://www.hattorihanzoshears.com';

// Storage keys
const JOBS_KEY   = 'hh_jobs_v1';   // [{jobId, accountUrl, visibleOrder, status, tries, nextAt, createdAt}]
const LABELS_KEY = 'hh_labels_v1'; // [{iorder, url, fromOrder}]
const LOCK_KEY   = 'hh_jobs_lock_v1';

const MAX_TRIES = 3;
const HEARTBEAT_MIN = 0.25; // 15s

// Sanity check: pdf-lib availability
if (!self.PDFLib || !PDFLib.PDFDocument) {
  HH.err('pdf-lib not loaded. Ensure pdf-lib.min.js is present and importScripts succeeded.');
}

// ---------- Storage helpers with debug ----------
async function get(key, def){
  try {
    const obj = await chrome.storage.local.get(key);
    return (key in obj) ? obj[key] : def;
  } catch (e) {
    HH.err('storage.get failed', key, String(e));
    return def;
  }
}
async function set(key, val){
  try {
    await chrome.storage.local.set({ [key]: val });
  } catch (e) {
    HH.err('storage.set failed', key, String(e), { val });
  }
}

// ---------- Job enqueue / labels ----------
async function enqueueJob(job){
  HH.log('enqueueJob', job);
  const jobs = await get(JOBS_KEY, []);
  jobs.push({ ...job, status: 'pending', tries: 0, nextAt: 0 });
  await set(JOBS_KEY, jobs);
  await runProcessor(); // kick immediately
}

async function pushLabel(item){
  HH.log('pushLabel', item);
  const labels = await get(LABELS_KEY, []);
  if (!labels.find(x => x.iorder === item.iorder)) {
    labels.push(item);
    await set(LABELS_KEY, labels);
  } else {
    HH.warn('label duplicate ignored (iorder de-dupe)', item.iorder);
  }
}

// ---------- Simple storage-backed lock ----------
async function withLock(fn){
  const now = Date.now();
  const curr = await get(LOCK_KEY, { locked:false, ts:0 });
  // 15s stale window: prevents stuck locks from blocking forever
  if (curr.locked && (now - curr.ts) < 15000) {
    HH.log('withLock: already locked, skipping this cycle');
    return;
  }
  HH.log('withLock: acquiring'); // Trace lock attempts
  await set(LOCK_KEY, { locked:true, ts:now });
  HH.log('withLock: acquired'); // Confirm acquisition
  try { await fn(); }
  catch (e) { HH.err('withLock fn error', String(e)); }
  finally {
    await set(LOCK_KEY, { locked:false, ts:Date.now() });
    HH.log('withLock: released'); // Trace lock release
  }
}

// ---------- Messages / startup / heartbeat ----------
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type === 'ENQUEUE_SHIP_JOB') {
    enqueueJob(msg.job).catch(e => HH.err('enqueueJob error', String(e), msg.job));
    return;
  }
  if (msg?.type === 'PRINT_ALL') {
    printAllMerged().catch(e => HH.err('printAllMerged error', String(e)));
    return;
  }
});

chrome.runtime.onStartup.addListener(() => {
  HH.log('onStartup: kicking processor');
  runProcessor().catch(e => HH.err('runProcessor onStartup error', String(e)));
});
chrome.runtime.onInstalled.addListener(() => {
  HH.log('onInstalled: kicking processor');
  runProcessor().catch(e => HH.err('runProcessor onInstalled error', String(e)));
});

chrome.alarms.create('hh_job_heartbeat', { periodInMinutes: HEARTBEAT_MIN });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'hh_job_heartbeat') {
    HH.log('heartbeat: kicking processor');
    runProcessor().catch(e => HH.err('runProcessor heartbeat error', String(e)));
  }
});

// ---------- Processor ----------
// Process queued jobs. Converted to loop to avoid deep recursion with many jobs.
// Each iteration processes at most one job and then re-checks the queue.
async function runProcessor(){
  await withLock(async () => {
    while (true) {
      HH.log('runProcessor: checking queue'); // Trace each loop iteration
      let jobs = await get(JOBS_KEY, []);
      const now = Date.now();

      // choose next eligible job
      const idx = jobs.findIndex(j => (j.status === 'pending' || j.status === 'retry') && (j.nextAt || 0) <= now);
      if (idx === -1) {
        HH.log('runProcessor: no eligible jobs');
        break;
      }

      const job = jobs[idx];
      jobs[idx].status = 'processing';
      await set(JOBS_KEY, jobs);

      HH.log('Processing job', job);

      try {
        await processJob(job);

        // success -> remove
        jobs = await get(JOBS_KEY, []);
        const pos = jobs.findIndex(j => j.jobId === job.jobId);
        if (pos > -1) { jobs.splice(pos, 1); await set(JOBS_KEY, jobs); }
        HH.log('Job completed', job.jobId);

        // notify (optional)
        try {
          chrome.notifications.create(undefined, {
            type: 'basic',
            iconUrl: 'icon48.png',
            title: 'Label queued',
            message: `Order ${job.visibleOrder || ''} added`
          });
        } catch {}
      } catch (err) {
        const reason = (err && err.message) ? err.message : String(err);
        HH.warn('Job failed', { jobId: job.jobId, reason });

        // schedule retry or mark failed
        jobs = await get(JOBS_KEY, []);
        const pos = jobs.findIndex(j => j.jobId === job.jobId);
        if (pos > -1) {
          const tries = (jobs[pos].tries ?? 0) + 1;
          if (tries >= MAX_TRIES) {
            jobs[pos].status = 'failed';
            jobs[pos].tries = tries;
            HH.err('Job permanently failed', { jobId: job.jobId, tries, reason });
          } else {
            const backoff = Math.min(30000, 1000 * Math.pow(2, tries)); // 2s,4s,8s...
            jobs[pos].status = 'retry';
            jobs[pos].tries = tries;
            jobs[pos].nextAt = Date.now() + backoff;
            HH.warn('Job scheduled for retry', { jobId: job.jobId, tries, backoffMs: backoff, reason });
          }
          await set(JOBS_KEY, jobs);
        }
      }

      // After processing, check if more work is ready immediately.
      const more = (await get(JOBS_KEY, [])).some(j =>
        (j.status === 'pending') || (j.status === 'retry' && (j.nextAt || 0) <= Date.now())
      );
      if (!more) {
        HH.log('Processor idle');
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
  HH.log('Account tab opened', { tabId, accountUrl });
  await waitComplete(tabId);

  // 2) Find bottom "O" row and extract iorder
  const [{ result: iorder }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      function getIOrder(href){
        const m = /[?&]iorder=(\d+)/i.exec(href || '');
        return m ? m[1] : null;
      }
      // NOTE: scanning all rows is robust; if perf becomes an issue, narrow to the specific table
      const rows = Array.from(document.querySelectorAll('tr'));
      const cand = rows.find(r => {
        const tds = r.querySelectorAll('td');
        if (!tds.length) return false;
        const first = (tds[0].textContent || '').trim();
        return first === 'O' && r.querySelector('a[href*="my_inventory.cfm"][href*="iorder="]');
      });
      if (!cand) return null;
      const a = cand.querySelector('a[href*="my_inventory.cfm"][href*="iorder="]');
      return getIOrder(a?.getAttribute('href'));
    }
  });

  if (!iorder) {
    try { await chrome.tabs.remove(tabId); } catch {}
    throw new Error('No iorder found (O-row not present or structure changed)');
  }
  HH.log('Found iorder', { iorder, fromOrder: job.visibleOrder || null });

  // 3) Try to generate/capture PDF URL (handles backend lag)
  const pdfUrl = await tryViewDemoLabelWithRetries(tabId, iorder, 5, 2000);
  if (!pdfUrl) {
    try { await chrome.tabs.remove(tabId); } catch {}
    throw new Error('No PDF URL captured (viewDemoLabel may have changed)');
  }
  HH.log('Captured PDF URL', { iorder, pdfUrl });

  // 4) Save to labels queue
  await pushLabel({ iorder, fromOrder: job.visibleOrder || null, url: pdfUrl });

  try { await chrome.tabs.remove(tabId); } catch {}
  HH.log('Closed account tab', { tabId });
}

function waitComplete(tabId){
  return new Promise(resolve => {
    function onUpd(id, info){
      if (id === tabId && info.status === 'complete'){
        chrome.tabs.onUpdated.removeListener(onUpd);
        HH.log('Tab complete', { tabId });
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

async function tryViewDemoLabelWithRetries(tabId, iorder, maxTries, delayMs){
  // Patch window.open once to capture PDFs
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => {
      if (window.__HH_OPEN_PATCHED__) return;
      window.__HH_OPEN_PATCHED__ = true;
      const origOpen = window.open;
      window.open = function(u, ...r){
        try {
          if (u && /\.pdf(\?|$)/i.test(u)) window.__HH_LAST_PDF_URL__ = u;
        } catch {}
        return origOpen.apply(this, [u, ...r]);
      };
    }
  });

  for (let t=1; t<=maxTries; t++){
    HH.log('viewDemoLabel attempt', { attempt: t, iorder });

    // Try param signature first, fallback to context call
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (io) => {
        try {
          if (typeof viewDemoLabel === 'function') {
            if (viewDemoLabel.length >= 1) {
              // Call with iorder if function declares params
              viewDemoLabel(io);
            } else {
              // Some sites ignore params and use selected context
              viewDemoLabel();
            }
          } else {
            console.error('[HH][Page] viewDemoLabel is not a function');
          }
        } catch (e) {
          console.error('[HH][Page] viewDemoLabel threw', e);
        }
      },
      args: [iorder]
    });

    const url = await waitPdfUrl(tabId, 1500);
    if (url) {
      HH.log('viewDemoLabel success', { attempt: t, url });
      return url;
    }

    HH.warn('viewDemoLabel: no PDF yet, delaying', { attempt: t, delayMs });
    await new Promise(r => setTimeout(r, delayMs));
  }
  HH.err('viewDemoLabel exhausted retries', { iorder, maxTries });
  return null;
}

function waitPdfUrl(tabId, timeoutMs){
  HH.log('waitPdfUrl: start', { tabId, timeoutMs }); // Trace entry
  return new Promise(resolve => {
    let timer = setTimeout(() => {
      HH.warn('waitPdfUrl: timeout', { tabId, timeoutMs }); // Debug timeout path
      cleanup();
      resolve(null);
    }, timeoutMs);

    function onUpdated(id, info){
      if (id !== tabId) return;
      if (info.url && /\.pdf(\?|$)/i.test(info.url)) {
        cleanup();
        HH.log('PDF via tab URL change', { tabId, url: info.url });
        resolve(info.url);
      }
    }

    async function pollVar(){
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => window.__HH_LAST_PDF_URL__ || null
        });
        if (result && /\.pdf(\?|$)/i.test(result)) {
          cleanup();
          HH.log('PDF via window.open capture', { tabId, url: result });
          resolve(result);
          return;
        }
      } catch (e) {
        HH.warn('pollVar executeScript error', String(e));
      }
      if (timer) setTimeout(pollVar, 250);
    }

    function cleanup(){
      clearTimeout(timer);
      timer = null;
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    pollVar();
  });
}

// ---------- Print All: fetch, merge, print once ----------
async function printAllMerged(){
  HH.log('printAll: starting');
  const queue = await get(LABELS_KEY, []);
  if (!queue.length) {
    HH.warn('printAll: no labels queued');
    return;
  }

  // Fetch all PDFs; collect failures for visibility
  const pdfBuffers = [];
  const failures = [];
  for (const item of queue) {
    try {
      const res = await fetch(item.url, { credentials: 'include' });
      if (!res.ok) {
        failures.push({ iorder: item.iorder, status: res.status });
        continue;
      }
      pdfBuffers.push(await res.arrayBuffer());
    } catch (e) {
      failures.push({ iorder: item.iorder, err: String(e) });
    }
  }
  if (!pdfBuffers.length) {
    HH.err('printAll: no PDFs fetched; aborting', { failures });
    return;
  }
  if (failures.length) HH.warn('printAll: some PDFs failed to fetch', failures);

  if (!PDFLib || !PDFLib.PDFDocument) {
    HH.err('printAll: PDFLib not available; cannot merge');
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
    HH.log('printAll: temp tab created', { tabId });

    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (url) => {
        // Inline logging inside page to trace print timing
        try {
          const stamp = () => new Date().toISOString();
          console.log(stamp(), '[HH][PrintTab] injecting iframe for merged PDF');
          document.body.style.margin = '0';
          const iframe = document.createElement('iframe');
          iframe.style.width = '100vw';
          iframe.style.height = '100vh';
          iframe.style.border = '0';
          iframe.src = url;
          document.body.appendChild(iframe);
          iframe.onload = () => {
            console.log(stamp(), '[HH][PrintTab] iframe loaded; calling print()');
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          };
        } catch (e) {
          console.error('[HH][PrintTab] print script error', e);
        }
      },
      args: [blobUrl]
    });

    // optional: clear queue & close the temp tab after printing
    setTimeout(async () => {
      HH.log('printAll: clearing queue and closing print tab', { tabId });
      await set(LABELS_KEY, []);
      try { await chrome.tabs.remove(tabId); } catch {}
    }, 4000);
  } catch (e) {
    HH.err('printAll merge/print error', String(e));
  }
}
