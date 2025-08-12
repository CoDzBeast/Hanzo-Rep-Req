# HH Return Label Queue

This extension uses a structured `Logger` to reduce console noise.

## Debug levels
Set the desired level in the DevTools console:

```js
window.HH_DEBUG_LEVEL = 'debug'; // error | warn | info | debug | trace
```

For high-volume trace sampling, choose a value between 0 and 1:

```js
window.HH_DEBUG_SAMPLING = 0.25; // 25% of debug/trace logs
```

The logger rate‑limits repeated messages and prints a `[HH][Summary]` line every 30s (and on page hide/unload) with counts of suppressed messages.
