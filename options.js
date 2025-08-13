const log = createLogger('HH:options');

function setPreset(preset){
  chrome.storage.local.set(preset, () => {
    const err = chrome.runtime.lastError;
    if (err) log.error('setPreset error', { error: err.message });
    else log.info('preset applied', preset);
  });
}

document.getElementById('quiet').addEventListener('click', () => setPreset({
  logLevel: 'warn',
  enableNamespaces: [],
  sampling: {},
  rateLimit: { windowMs: 2000, maxPerWindow: 20 }
}));

document.getElementById('focus').addEventListener('click', () => setPreset({
  logLevel: 'debug',
  enableNamespaces: ['HH:label'],
  sampling: {},
  rateLimit: { windowMs: 2000, maxPerWindow: 20 }
}));

document.getElementById('trace').addEventListener('click', () => setPreset({
  logLevel: 'trace',
  enableNamespaces: ['HH:*'],
  sampling: { trace: 0.2 },
  rateLimit: { windowMs: 2000, maxPerWindow: 20 }
}));
