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
