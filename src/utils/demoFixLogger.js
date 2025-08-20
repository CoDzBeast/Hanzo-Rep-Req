export const DemoLog = (() => {
  const ns = '[DemoFix]';
  let enabled = false;

  const manualEnabled = () =>
    !!(localStorage.getItem('DemoFixDebug') ||
       (typeof location !== 'undefined' && /\bdemodebug=1\b/i.test(location.search)));

  const nsEnabled = (ns, list) => {
    if (!Array.isArray(list) || !list.length) return false;
    return list.some(p => p.endsWith('*') ? ns.startsWith(p.slice(0, -1)) : ns === p);
  };

  const recalc = (cfg = {}) => {
    const lvl = cfg.logLevel || 'warn';
    enabled = ['debug', 'trace'].includes(lvl) || nsEnabled('HH:label', cfg.enableNamespaces);
  };

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['logLevel', 'enableNamespaces'], recalc);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.logLevel || changes.enableNamespaces)) {
        chrome.storage.local.get(['logLevel', 'enableNamespaces'], recalc);
      }
    });
  }

  const isEnabled = () => enabled || manualEnabled();

  const stamp = () =>
    new Date().toISOString().slice(11, 19) + ' +' + Math.round(performance.now());

  const fmt = (level, color, args) =>
    isEnabled() && console[level](`%c${ns} ${stamp()}`, `color:${color}`, ...args);

  return {
    get enabled(){ return isEnabled(); },
    info:  (...a) => fmt('log',   '#4fc3f7', a),
    debug: (...a) => fmt('debug', '#9e9e9e', a),
    warn:  (...a) => fmt('warn',  '#ffb300', a),
    error: (...a) => fmt('error', '#ef5350', a),

    group(label){ isEnabled() && console.groupCollapsed(`${ns} ${label}`); },
    groupEnd(){ isEnabled() && console.groupEnd(); },

    time(label){ isEnabled() && console.time(`${ns} ${label}`); },
    timeEnd(label){ isEnabled() && console.timeEnd(`${ns} ${label}`); },

    // Structured event buffer for bug reports
    events: [],
    event(type, payload){ if (isEnabled()) this.events.push({ t: Date.now(), type, payload }); },

    // Quick enable/disable at runtime
    enable(){ localStorage.setItem('DemoFixDebug','1'); },
    disable(){ localStorage.removeItem('DemoFixDebug'); },
  };
})();

// Global error hooks (optional)
if (typeof window !== 'undefined') {
  window.addEventListener('error', e => DemoLog.error('window.onerror', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', e => DemoLog.error('unhandledrejection', e.reason));
}
