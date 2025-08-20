export const DemoLog = (() => {
  const ns = '[DemoFix]';
  const enabled =
    !!(localStorage.getItem('DemoFixDebug') ||
       (typeof location !== 'undefined' && /\bdemodebug=1\b/i.test(location.search)));

  const stamp = () =>
    new Date().toISOString().slice(11, 19) + ' +' + Math.round(performance.now());

  const fmt = (level, color, args) =>
    enabled && console[level](`%c${ns} ${stamp()}`, `color:${color}`, ...args);

  return {
    enabled,
    info:  (...a) => fmt('log',   '#4fc3f7', a),
    debug: (...a) => fmt('debug', '#9e9e9e', a),
    warn:  (...a) => fmt('warn',  '#ffb300', a),
    error: (...a) => fmt('error', '#ef5350', a),

    group(label){ enabled && console.groupCollapsed(`${ns} ${label}`); },
    groupEnd(){ enabled && console.groupEnd(); },

    time(label){ enabled && console.time(`${ns} ${label}`); },
    timeEnd(label){ enabled && console.timeEnd(`${ns} ${label}`); },

    // Structured event buffer for bug reports
    events: [],
    event(type, payload){ if (enabled) this.events.push({ t: Date.now(), type, payload }); },

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
