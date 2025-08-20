# HH Return Label Queue

This extension uses a scoped logger with namespaces and levels. Logging
settings are stored in `chrome.storage.local` and can be changed from the
extension's options page or by right‑clicking the extension icon and choosing a
preset:

- **Quiet** – warn/error only (default)
- **Focus Label Debug** – enables debug logs for the `HH:label` namespace
- **Full Trace** – trace for all namespaces with sampling & rate limiting

Each log line is timestamped and structured: `YYYY-MM-DDTHH:mm:ss.SSSZ [NS]
level message {json}`. Repeated identical messages are de‑duplicated and
summarised periodically.

## Demo Orders QA Checklist

Enable verbose logs by appending `?demodebug=1` to the URL or running in the console:

```js
localStorage.setItem('DemoFixDebug','1');
location.reload();
```

Then run `ensureDemoLabelFlow()` and verify:

- If "Demo Shears" is missing → expect `E_DEMO_SECTION_MISSING`.
- If no "O" rows → expect `E_NO_O_ROWS`.
- If the order doesn't load within 25s → expect a timeout (logged).
- Guards primed: `window.cTrn === 'O'`, `window.iOrder === <orderNum>`, and hidden inputs populated.
- `viewDemoLabel()` called; any `alert()` text is logged as `[ALERT]`.
- Attach `DemoLog.events` JSON on failure.
