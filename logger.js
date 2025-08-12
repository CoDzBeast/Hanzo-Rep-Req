const Logger = (() => {
  const lvl = { error:0, warn:1, info:2, debug:3, trace:4 };
  const global = typeof self !== 'undefined' ? self : window;
  let level = (() => {
    const env = (global.HH_DEBUG_LEVEL ?? 'info').toString().toLowerCase();
    return lvl[env] ?? 2;
  })();
  let sample = Number(global.HH_DEBUG_SAMPLING ?? 1);
  const last = new Map();     // key -> { t:ms, count:n }
  const SUM_INTERVAL = 30000; // 30s
  let sumTimer = null;

  function shouldLog(k, minGapMs=5000) {
    const now = Date.now();
    const rec = last.get(k);
    if (!rec || now - rec.t >= minGapMs) {
      last.set(k, { t: now, count: 0 });
      return true;
    }
    rec.count++;
    return false;
  }

  function summaryFlush() {
    if (!last.size) return;
    const lines = [];
    for (const [k, rec] of last.entries()) {
      if (rec.count > 0) lines.push(`${k} x${rec.count}`);
    }
    if (lines.length) console.info('[HH][Summary]', lines.join(' · '));
    // reset only counts; keep timestamps to preserve rate-limit windows
    for (const rec of last.values()) rec.count = 0;
  }
  function scheduleSummary() {
    if (sumTimer) return;
    sumTimer = setInterval(summaryFlush, SUM_INTERVAL);
    if (typeof addEventListener === 'function') {
      addEventListener('visibilitychange', () => { if (typeof document !== 'undefined' && document.hidden) summaryFlush(); });
      addEventListener('beforeunload', summaryFlush);
      addEventListener('pagehide', summaryFlush);
    }
  }
  scheduleSummary();

  function make(scope='Content') {
    const tag = `[HH][${scope}]`;
    const logf = (lvlName, gap, ...a) => {
      if (lvl[lvlName] > level) return;
      if ((lvlName === 'debug' || lvlName === 'trace') && Math.random() > sample) return;
      const k = `${tag} ${a[0]}`; // first arg is message key
      const first = shouldLog(k, gap);
      if (!first) return;
      if (lvlName === 'error') {
        console.error(tag, ...a, new Error().stack);
      } else {
        console[lvlName](tag, ...a);
      }
    };
    return {
      setLevel: (name) => { level = lvl[name] ?? level; },
      error: (...a) => logf('error', Number.POSITIVE_INFINITY, ...a),
      warn:  (...a) => logf('warn',  2000, ...a),
      info:  (...a) => logf('info',  3000, ...a),
      debug: (...a) => logf('debug', 5000, ...a),
      trace: (...a) => logf('trace', 7000, ...a),
      step: async (name, fn) => {
        const t0 = performance.now();
        try {
          const r = await fn();
          console.info(`${tag} ▶ ${name} ok ${(performance.now()-t0).toFixed(0)}ms`);
          return r;
        } catch (e) {
          console.error(`${tag} ✗ ${name}`, e);
          throw e;
        }
      }
    };
  }
  return { make, summaryFlush };
})();

if (typeof self !== 'undefined') self.Logger = Logger;
