import { DemoLog } from '../../utils/demoFixLogger';
import { DemoErr } from '../../utils/demoFixErrors';

const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
const txt   = (el)=> (el?.textContent || '').trim();
const isVis = (el)=> !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null && el.offsetHeight > 0;

async function waitFor(predicate, label, timeout=25000, interval=150){
  DemoLog.debug('waitFor start:', label);
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    try {
      const v = predicate();
      if (v) {
        DemoLog.info('waitFor ok:', label, (performance.now()-t0).toFixed(0)+'ms');
        return v;
      }
    } catch (e) {
      DemoLog.warn('waitFor predicate error:', label, e);
    }
    await sleep(interval);
  }
  DemoLog.warn('Timeout:', label);
  const err = new Error(label);
  err.code = DemoErr.ORDER_TIMEOUT;
  throw err;
}

function findDemoSection(){
  const boxes = [...document.querySelectorAll('.boxed')];
  const box = boxes.find(b => /demo\s*shears/i.test(txt(b.querySelector('.title-bar h4, h4')) || ''));
  if (!box) {
    const err = new Error('Demo Shears section not found');
    err.code = DemoErr.DEMO_SECTION_MISSING;
    throw err;
  }
  return box;
}

function parseMDY(s){
  const m = /^\s*(\d{2})[-/](\d{2})[-/](\d{4})\s*$/.exec((s || '').trim());
  return m ? new Date(+m[3], +m[1]-1, +m[2]) : null;
}

function latestOpenOrder(demoBox){
  const rows = [...demoBox.querySelectorAll('table.table.table-striped tbody tr')];
  const O = rows.map(tr => {
    const td = tr.querySelectorAll('td');
    if (td.length < 5 || txt(td[0]) !== 'O') return null;
    return { order: txt(td[1]).replace(/\D/g, ''), d: parseMDY(txt(td[4])) };
  }).filter(Boolean).sort((a,b) => (b.d?.getTime()||0) - (a.d?.getTime()||0));

  if (!O.length) {
    const err = new Error('No "O" rows');
    err.code = DemoErr.NO_O_ROWS;
    throw err;
  }
  return O[0].order;
}

async function openOrder(orderNum){
  DemoLog.group(`Open order #${orderNum}`);
  try {
    if (typeof window.GetOrder === 'function' && !window.yInReturn){
      DemoLog.debug('Using GetOrder(...)');
      window.GetOrder(orderNum, 0);
    } else {
      DemoLog.debug('Falling back to row click');
      const rw =
        document.querySelector(`.rwOrdr[onclick*="GetOrder(${orderNum}"]`) ||
        [...document.querySelectorAll('.rwOrdr')].find(el => txt(el).includes('#' + orderNum));
      if (!rw) {
        const err = new Error('rwOrdr not found');
        err.code = DemoErr.ROW_CLICK_MISSING;
        throw err;
      }
      rw.click();
    }

    await waitFor(()=> String(window.iOrder) === String(orderNum), `iOrder == ${orderNum}`);
    const detailsId = 'O' + orderNum;
    const details = await waitFor(()=>{
      const el = document.getElementById(detailsId);
      return el && isVis(el) && el.innerHTML.trim().length > 60 ? el : null;
    }, `#${detailsId} visible+populated`, 25000);
    return details;
  } finally {
    DemoLog.groupEnd();
  }
}

function primeGuards(orderNum, details){
  DemoLog.group('Prime guards');
  try {
    try { window.cTrn = 'O'; } catch {}
    const cTr = document.querySelector('#cTr');
    if (cTr) cTr.innerHTML = 'O';

    try { window.iOrder = orderNum; } catch {}
    const form = details.querySelector('form');
    if (form) {
      const ensure = (n,v)=>{
        let el = form.querySelector(`input[name="${n}"]`) || form.querySelector('#'+CSS.escape(n));
        if (!el) { el = document.createElement('input'); el.type='hidden'; el.name=n; el.id=n; form.appendChild(el); }
        el.value = String(v);
      };
      ['iOrder','currentOrder','selOrder','OrderID','orderId','order','order_id'].forEach(n => ensure(n, orderNum));
    }
    DemoLog.info('Guards primed: cTrn="O", iOrder=', orderNum);
  } finally {
    DemoLog.groupEnd();
  }
}

function callViewDemoLabel(orderNum){
  if (typeof window.viewDemoLabel !== 'function'){
    const err = new Error('viewDemoLabel() missing');
    err.code = DemoErr.VIEW_FN_MISSING;
    throw err;
  }
  const _alert = window.alert;
  window.alert = (m)=>{ DemoLog.warn('[ALERT]', m); try { return _alert(m); } catch {} };
  DemoLog.info(`Calling viewDemoLabel() for order #${orderNum}`);
  window.viewDemoLabel();
}

export async function ensureDemoLabelFlow(){
  DemoLog.time('ensureDemoLabelFlow');
  try {
    DemoLog.group('Find latest demo order');
    const box = findDemoSection();
    const orderNum = latestOpenOrder(box);
    DemoLog.info('Target order:', orderNum);
    DemoLog.groupEnd();

    const details = await openOrder(orderNum);
    primeGuards(orderNum, details);
    callViewDemoLabel(orderNum);

    DemoLog.event('success', { orderNum });
    return { ok: true, orderNum };
  } catch (err) {
    DemoLog.error('Flow failed:', err.code || 'E_UNKNOWN', err.message);
    DemoLog.event('failure', { code: err.code || 'E_UNKNOWN', message: err.message, stack: err.stack });
    return { ok: false, error: { code: err.code || 'E_UNKNOWN', message: err.message } };
  } finally {
    DemoLog.timeEnd('ensureDemoLabelFlow');
  }
}
