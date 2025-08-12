// Configurable selectors for DOM access. orderRowByNumber uses :has/:contains
// when available; we provide a text search fallback in findOrderRow.
const SEL = {
  demoHeaderH4: 'h4',
  demoTableInBoxed: '.boxed .table.table-striped',
  ordersBox: '#orders_notes_snaps',
  ordersTab: '#orders_tab',
  accordion: '#accordion',
  orderRowByNumber: (orderNo) => `.rwOrdr:has(.col-xs-3:contains("#${orderNo}"))`,
  orderPanelByNumber: (orderNo) => `#O${orderNo}`,
  orderOptionsBtn: '.btn.btn-warning.dropdown-toggle',
  viewDemoLabel: 'a[onclick="viewDemoLabel();"]',
  viewRtnLabel: 'a[onclick="viewReturnLabel();"]',
  emailRtnLabel: 'a[onclick="sendReturnLabel();"]',
  itemsTable: '#TItems'
};

const DBG = (() => {
  const NS = 'HANZO-DEMO';
  const ts = () => new Date().toISOString();
  const log = (...a) => console.log(`[${NS}] ${ts()}`, ...a);
  const warn = (...a) => console.warn(`[${NS}] ${ts()}`, ...a);
  const error = (...a) => console.error(`[${NS}] ${ts()}`, ...a);
  const step = async (name, fn) => {
    const start = performance.now();
    log(`\u25b6 ${name} start`);
    try {
      const r = await fn();
      log(`\u2713 ${name} done in ${(performance.now()-start).toFixed(1)}ms`);
      return r;
    } catch (e) {
      error(`\u2717 ${name} failed`, e);
      throw e;
    }
  };
  return { log, warn, error, step };
})();

(function(){
  // Track which orders have triggered a label to keep the script idempotent.
  const labelsFired = new Set();

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 3, delay = 400) => {
    for (let i = 0; i < tries; i++) {
      const r = fn();
      if (r) return r;
      await sleep(delay * Math.pow(2, i));
    }
    return null;
  };

  function findOrderRow(orderNo){
    const sel = SEL.orderRowByNumber(orderNo);
    try {
      const bySel = document.querySelector(sel);
      if (bySel) return bySel;
    } catch {}
    return Array.from(document.querySelectorAll('.rwOrdr'))
      .find(r => (r.textContent || '').includes(`#${orderNo}`));
  }

  // Task A: gather all Demo Shears rows where Status === "O". These are the
  // orders we need to process in the Orders, Notes section.
  async function collectOutOrders(){
    const table = await waitForDemoTable();
    if (!table) return [];
    const out = [];
    table.querySelectorAll('tbody tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      const status = (tds[0]?.textContent || '').trim().toUpperCase();
      if (status === 'O') {
        const orderNo = (tds[1]?.textContent || '').trim();
        const sku = (tds[2]?.textContent || '').trim();
        const model = (tds[3]?.textContent || '').trim();
        out.push({ orderNo, sku, model });
        DBG.log('found OUT', { orderNo, sku, model });
      }
    });
    return out;
  }

  async function waitForDemoTable(){
    return waitFor(() => {
      const headers = Array.from(document.querySelectorAll(SEL.demoHeaderH4));
      const header = headers.find(h => h.textContent.trim() === 'Demo Shears');
      if (!header) return null;
      let tbl = header.nextElementSibling;
      while (tbl && tbl.tagName !== 'TABLE') tbl = tbl.nextElementSibling;
      if (tbl) return tbl;
      return header.parentElement.querySelector(SEL.demoTableInBoxed);
    }, 3, 400);
  }

  async function ensureOrdersTab(){
    if (document.querySelector(`${SEL.ordersTab}.active`)) return;
    const box = document.querySelector(SEL.ordersBox);
    const link = box?.querySelector(`a[href="${SEL.ordersTab}"]`);
    if (link) link.click();
    await waitFor(() => document.querySelector(`${SEL.ordersTab}.active`));
  }

  // Task B: click the matching order row inside the accordion to open its
  // panel. Clicking satisfies the UI requirement "you must click an order
  // number" so the order details render correctly.
  async function openOrder(orderNo){
    await ensureOrdersTab();
    const row = await waitFor(() => findOrderRow(orderNo));
    if (!row) throw new Error('row not found');
    const panelSel = SEL.orderPanelByNumber(orderNo);
    let panel = document.querySelector(panelSel);
    if (!panel || panel.style.display === 'none') {
      DBG.log('click row', orderNo);
      row.click();
      panel = await waitFor(() => {
        const p = document.querySelector(panelSel);
        return p && p.style.display !== 'none' ? p : null;
      });
      if (!panel) throw new Error('panel did not open');
      DBG.log('panel open', orderNo);
    }
    // Wait for inner content to finish rendering before proceeding.
    await waitFor(() => panel.querySelector(SEL.itemsTable) || panel.querySelector('#Ord1'));
    return panel;
  }

  // Task C: open Order Options within the panel and trigger the best available
  // label action. Preference is View Demo Label, then View/Email Return Label.
  async function triggerLabel(orderNo){
    const panel = document.querySelector(SEL.orderPanelByNumber(orderNo));
    if (!panel) throw new Error('panel missing');
    const btn = panel.querySelector(SEL.orderOptionsBtn);
    if (!btn) throw new Error('options btn missing');
    btn.click();
    await sleep(200);
    const act = panel.querySelector(SEL.viewDemoLabel) ||
                panel.querySelector(SEL.viewRtnLabel) ||
                panel.querySelector(SEL.emailRtnLabel);
    if (!act) {
      DBG.error('no label action', orderNo);
      return;
    }
    act.click();
    labelsFired.add(orderNo);
    DBG.log('label action', { orderNo, action: act.getAttribute('onclick') });
  }

  async function processOrder(orderNo){
    if (labelsFired.has(orderNo)) return;
    await openOrder(orderNo);
    if (!labelsFired.has(orderNo)) await triggerLabel(orderNo);
  }

  DBG.step('main', async () => {
    const orders = await collectOutOrders();
    const orderNos = orders.map(o => o.orderNo);
    DBG.log('orders to process', orderNos);
    for (const o of orders) {
      try { await processOrder(o.orderNo); }
      catch (e) { DBG.warn('process error', o.orderNo, e); }
    }
    const acc = document.querySelector(SEL.accordion);
    if (acc) {
      new MutationObserver(() => {
        orders.forEach(o => processOrder(o.orderNo));
      }).observe(acc, { childList: true, subtree: true });
    }
  });
})();
