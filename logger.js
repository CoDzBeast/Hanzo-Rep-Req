(function(global){
  const LEVELS = { error:0, warn:1, info:2, debug:3, trace:4 };
  const DEFAULT = {
    logLevel: 'warn',
    enableNamespaces: [],
    sampling: {},
    rateLimit: { windowMs: 0, maxPerWindow: Infinity }
  };
  let settings = null;
  let fetchedAt = 0;
  const CACHE_MS = 2000;
  const rate = { start:0, count:0 };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.logLevel || changes.enableNamespaces || changes.sampling || changes.rateLimit)) {
      fetchedAt = 0;
    }
  });

  async function loadSettings(){
    const now = Date.now();
    if (settings && (now - fetchedAt) < CACHE_MS) return settings;
    try {
      const obj = await chrome.storage.local.get(['logLevel','enableNamespaces','sampling','rateLimit']);
      settings = Object.assign({}, DEFAULT, obj);
    } catch {
      settings = Object.assign({}, DEFAULT);
    }
    fetchedAt = now;
    return settings;
  }

  function nsEnabled(ns, enabled){
    if (!Array.isArray(enabled) || !enabled.length) return false;
    return enabled.some(p => {
      if (p.endsWith('*')) return ns.startsWith(p.slice(0,-1));
      return ns === p;
    });
  }

  function emit(level, ns, msg, ctx){
    loadSettings().then(cfg => {
      const lvlNum = LEVELS[level];
      const minLvl = LEVELS[cfg.logLevel] ?? LEVELS.warn;
      if (lvlNum < minLvl) return;
      if (lvlNum < LEVELS.warn && !nsEnabled(ns, cfg.enableNamespaces)) return;
      const prob = cfg.sampling && typeof cfg.sampling[level] === 'number' ? cfg.sampling[level] : 1;
      if (prob < 1 && Math.random() > prob) return;
      const now = Date.now();
      const rl = cfg.rateLimit || {};
      const w = rl.windowMs || 0;
      const max = rl.maxPerWindow ?? Infinity;
      if (w > 0 && max < Infinity){
        if (now - rate.start > w){ rate.start = now; rate.count = 0; }
        if (rate.count >= max) return;
        rate.count++;
      }
      const ts = new Date(now).toISOString();
      const payload = ctx ? ' ' + JSON.stringify(ctx) : '';
      const line = `${ts} [${ns}] ${level} ${msg}${payload}`;
      const fn = console[level] || console.log;
      fn(line);
    });
  }

  function createLogger(ns){
    const state = { lastMsg:'', lastCtx:null, lastEmit:0, suppressed:0 };
    function dedup(level, msg, ctx){
      const now = Date.now();
      if (msg === state.lastMsg){
        if (now - state.lastEmit >= 10000){
          const sup = state.suppressed;
          state.suppressed = 0;
          state.lastEmit = now;
          state.lastCtx = ctx;
          emit(level, ns, `${msg} (suppressed ${sup})`, ctx);
        } else {
          state.suppressed++;
        }
        return;
      }
      if (state.suppressed > 0){
        emit(level, ns, `${state.lastMsg} (suppressed ${state.suppressed})`, state.lastCtx);
      }
      state.lastMsg = msg;
      state.lastCtx = ctx;
      state.suppressed = 0;
      state.lastEmit = now;
      emit(level, ns, msg, ctx);
    }
    return {
      trace:(m,c)=>emit('trace',ns,m,c),
      debug:(m,c)=>emit('debug',ns,m,c),
      info:(m,c)=>emit('info',ns,m,c),
      warn:(m,c)=>emit('warn',ns,m,c),
      error:(m,c)=>emit('error',ns,m,c),
      dedup:(m,c,l='info')=>dedup(l,m,c)
    };
  }

  global.createLogger = createLogger;
})(typeof self !== 'undefined' ? self : window);
