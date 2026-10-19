/*
 * 全聯 PX Pay「消費明細」截圖的 OCR 結果解析器（純函式）
 * 輸入：{ width, height, lines: [{ text, bbox, words: [{ text, conf, bbox:{x0,y0,x1,y1} }] }] }
 * 輸出：單張截圖的交易草稿；看不到的欄位保持 null，不確定的欄位標示待確認。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else root.PXParser = factory(root.PXLogic);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  const NAME_CONF = 75;   // 名稱單字信心低於此值 → 待確認
  const NUM_CONF = 85;    // 數字信心低於此值 → 待確認
  const STOP_RE = /付款方式|優惠活動|回饋|備註事項|合計|總計|小計|發票/;
  const CJK_RE = /[㐀-鿿]/;

  function compact(s) { return String(s || '').normalize('NFKC').replace(/\s+/g, ''); }
  function cx(w) { return (w.bbox.x0 + w.bbox.x1) / 2; }

  /*
   * 把 OCR 文字轉成數字。只做常見且可說明的字元替換（O→0、l/I→1、去除引號），
   * 有替換時回報 substituted，呼叫端必須標示待確認。
   */
  function cleanNumber(text) {
    let s = String(text || '').normalize('NFKC').replace(/NT\$?|\$|,|\s/gi, '').replace(/[−–—]/g, '-');
    const before = s;
    s = s.replace(/^["'“”‘’`.:;]+|["'“”‘’`:;]+$/g, '');
    let substituted = s !== before;
    if (/^[-\dOoIl|]+$/.test(s) && /[OoIl|]/.test(s)) {
      s = s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
      substituted = true;
    }
    if (!/^-?\d+(\.\d+)?$/.test(s)) return { value: null, substituted, raw: text };
    return { value: parseFloat(s), substituted, raw: text };
  }

  function joinName(words) {
    let out = '';
    words.forEach((w, i) => {
      const t = w.text.normalize('NFKC');
      if (i === 0) { out = t; return; }
      const prev = out.slice(-1);
      const needSpace = (i === 1 && /^\d{1,3}$/.test(words[0].text)) || (/[A-Za-z0-9]/.test(prev) && /^[A-Za-z0-9]/.test(t));
      out += (needSpace ? ' ' : '') + t;
    });
    return out;
  }

  function parseDate(text) {
    const s = String(text).normalize('NFKC');
    let m = s.match(/(20\d{2})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
    let roc = false;
    if (!m) { m = s.match(/(?:^|[^\d])(1\d{2})\s*[\/.]\s*(\d{1,2})\s*[\/.]\s*(\d{1,2})/); roc = !!m; }
    if (!m) return null;
    const y = roc ? parseInt(m[1], 10) + 1911 : parseInt(m[1], 10);
    const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const tm = s.slice(m.index + m[0].length).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const time = tm && +tm[1] < 24 && +tm[2] < 60 ? String(tm[1]).padStart(2, '0') + ':' + tm[2] + (tm[3] ? ':' + tm[3] : '') : null;
    return { date, time, roc };
  }

  // 取標籤右側的數字（例如「消費金額 NT$ 330」、「優惠活動折扣金額 NT$ 0 ⌄」）
  function valueAfterLabel(line, labelRe) {
    const words = line.words;
    let i = 0, acc = '';
    for (; i < words.length; i++) { acc += words[i].text; if (labelRe.test(compact(acc))) break; }
    const rest = words.slice(i + 1);
    // 只取緊接在 NT$ 或標籤後的第一個數字，避免把右側的展開圖示誤認成數字
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k].text.normalize('NFKC');
      if (/^NT\$?$|^\$$|^點數$|^點$|^數$/i.test(t)) continue;
      // 標籤被拆成多個字（例如「消費金」「額」）時，略過剩下的純中文字
      if (/^[㐀-鿿]+$/.test(t)) continue;
      const n = cleanNumber(t);
      if (n.value != null) return { value: n.value, flagged: n.substituted || rest[k].conf < NUM_CONF, conf: rest[k].conf, raw: t };
      return { value: null, flagged: true, conf: rest[k].conf, raw: t };
    }
    return null;
  }

  function lineConf(words) { return words.length ? Math.min.apply(null, words.map((w) => w.conf)) : 0; }

  function parsePage(page, opts) {
    opts = opts || {};
    const W = page.width || 1000;
    const out = {
      store: null, date: null, time: null, posNo: null, txnNo: null, invoiceNo: null, spendTotal: null,
      paymentMethod: null, paymentTotal: null, discountTotal: null, points: null,
      items: [], warnings: [], fieldFlags: {}, columns: null, hasItemHeader: false,
    };
    let qtyX = opts.columns ? opts.columns.qtyX : 0.61 * W;
    let amtX = opts.columns ? opts.columns.amtX : 0.9 * W;
    let state = 'head';
    let sawAnySection = false;
    const lines = (page.lines || []).map((ln) => Object.assign({}, ln, {
      words: (ln.words || []).filter((w) => w.text && w.text.trim()),
    })).filter((ln) => ln.words.length);

    const flag = (f, why) => { out.fieldFlags[f] = why; };
    const H = page.height || 2000;
    // 有「名稱／數量／金額」表頭的截圖，只把表頭以下的列當商品列
    const headerIdx = lines.findIndex((ln) => { const c = compact(ln.words.map((w) => w.text).join('')); return /名稱/.test(c) && /數量|金額/.test(c); });

    lines.forEach((ln, idx) => {
      const c = compact(ln.words.map((w) => w.text).join(''));
      const text = ln.words.map((w) => w.text).join(' ');
      const top = Math.min.apply(null, ln.words.map((w) => w.bbox.y0));
      // 手機狀態列（時間、電量）與 App 底部提示文字不是明細內容
      if (top < 0.035 * H) return;
      if (/交易紀錄將於|實際資料以|本公司系統/.test(c)) return;

      // 門市名稱：頁面最上方、尚未進入任何區塊、含「店／公司／門市」
      if (!sawAnySection && !out.store && /店|公司|門市/.test(c) && idx < 3) {
        // 左上角的返回箭頭常被誤認成「人」「和」等字，只取畫面左側 15% 以外的字
        const ws = ln.words.filter((w) => w.conf >= 60 && CJK_RE.test(w.text) && w.bbox.x0 > 0.15 * W);
        if (ws.length) {
          out.store = ws.map((w) => w.text).join('');
          if (lineConf(ws) < 80) flag('store', '門市名稱辨識信心偏低');
        }
        return;
      }

      if (/^交易日期/.test(c) || (!out.date && parseDate(text))) {
        sawAnySection = true;
        const d = parseDate(text);
        if (d) {
          out.date = d.date; out.time = d.time;
          const dw = ln.words.filter((w) => /\d/.test(w.text));
          if (d.roc) flag('date', '民國年已換算成西元，請確認');
          else if (lineConf(dw) < 80) flag('date', '日期辨識信心偏低');
        } else if (/^交易日期/.test(c)) flag('date', '有「交易日期」但無法判讀日期');
        return;
      }
      if (/^交易機台/.test(c)) { sawAnySection = true; const m = c.match(/(\d{3,})$/); if (m) out.posNo = m[1]; return; }
      if (/^交易(序號|編號)/.test(c)) { sawAnySection = true; const m = c.match(/(\d{3,})$/); if (m) out.txnNo = m[1]; return; }
      if (/^發票號碼/.test(c)) {
        sawAnySection = true;
        const m = c.toUpperCase().replace(/^發票號碼/, '').match(/([A-Z]{2})-?([\dOIl]{8})/);
        if (m) {
          const digits = m[2].replace(/O/g, '0').replace(/[Il]/g, '1');
          out.invoiceNo = m[1] + digits;
          const w = ln.words[ln.words.length - 1];
          if (digits !== m[2] || (w && w.conf < 80)) flag('invoiceNo', '發票號碼辨識信心偏低');
        } else {
          // 看得到發票號碼但位數不對（常是漏認一個數字）：不自行補字，留空並標示
          const raw = c.replace(/^發票號碼/, '');
          if (raw) flag('invoiceNo', '發票號碼位數不對（辨識為 ' + raw + '），請對照截圖填入');
        }
        return;
      }
      if (/^消費金(?!.*明細)/.test(c)) {
        sawAnySection = true;
        const v = valueAfterLabel(ln, /消費金/);
        if (v && v.value != null) { out.spendTotal = v.value; if (v.flagged) flag('spendTotal', '消費金額辨識不確定（' + v.raw + '）'); }
        return;
      }
      if (/^優惠活動折扣金額/.test(c)) {
        state = 'after';
        const v = valueAfterLabel(ln, /折扣金額/);
        if (v) {
          out.discountTotal = v.value == null ? null : Math.abs(v.value);
          if (v.flagged || v.value == null) flag('discountTotal', '折扣金額辨識不確定（' + v.raw + '）');
        }
        return;
      }
      if (/^回饋福利點/.test(c)) {
        state = 'after';
        const v = valueAfterLabel(ln, /福利點/);
        if (v && v.value != null) out.points = v.value;
        return;
      }
      if (/^付款方式/.test(c)) { state = 'pay'; sawAnySection = true; return; }

      // 商品明細表頭：名稱／數量／金額
      if (/名稱/.test(c) && /數量|金額/.test(c)) {
        state = 'items'; sawAnySection = true; out.hasItemHeader = true;
        const q = ln.words.filter((w) => /[數量]/.test(w.text));
        const a = ln.words.filter((w) => /[金額]/.test(w.text));
        if (q.length) qtyX = (Math.min.apply(null, q.map((w) => w.bbox.x0)) + Math.max.apply(null, q.map((w) => w.bbox.x1))) / 2;
        if (a.length) amtX = (Math.min.apply(null, a.map((w) => w.bbox.x0)) + Math.max.apply(null, a.map((w) => w.bbox.x1))) / 2;
        return;
      }
      if (/^消費明細/.test(c)) { sawAnySection = true; return; }

      if (state === 'pay') {
        if (/^項目/.test(c)) return;
        if (STOP_RE.test(c)) { state = 'after'; return; }
        const last = ln.words[ln.words.length - 1];
        const n = cleanNumber(last.text);
        if (n.value != null) {
          const name = ln.words.slice(0, -1).map((w) => w.text).join('');
          out.paymentMethod = out.paymentMethod ? out.paymentMethod + '、' + name : name;
          out.paymentTotal = (out.paymentTotal || 0) + n.value;
          if (n.substituted || last.conf < NUM_CONF) flag('paymentTotal', '付款金額辨識不確定（' + last.text + '）');
        }
        return;
      }

      // 沒有表頭的截圖（捲動後的第二張）：在進入其他區塊前，看起來像商品列的就當商品列
      const looksLikeItem = /^\d{1,3}\S*[㐀-鿿]/.test(c) || (/^\d{1,3}$/.test(ln.words[0].text) && CJK_RE.test(c));
      if (headerIdx >= 0 && idx < headerIdx) return;
      if (state === 'items' || (state === 'head' && !out.hasItemHeader && looksLikeItem && !/^交易|^發票|^載具|^愛心|^支付/.test(c))) {
        if (STOP_RE.test(c) && !looksLikeItem) { state = 'after'; return; }
        if (state === 'head') state = 'items';
        parseItemLine(ln, text, out, qtyX, amtX, W);
      }
    });

    out.columns = { qtyX, amtX };
    out.items.forEach((it, i) => { it.lineNo = i + 1; });
    return out;
  }

  function parseItemLine(ln, text, out, qtyX, amtX, W) {
    const span = amtX - qtyX;
    const nameEnd = qtyX - 0.3 * span;
    const qtyEnd = amtX - 0.5 * span;
    // 數量欄裡緊接著名稱的中文或括號，代表是較長的商品名稱延伸過來，歸回名稱；
    // 與名稱有明顯間隔的字則視為數量（可能是數字被誤認成中文，例如 2 → 色）
    const sorted = ln.words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const lineH = Math.max.apply(null, sorted.map((w) => w.bbox.y1 - w.bbox.y0)) || 40;
    const nameSet = new Set();
    sorted.forEach((w, i) => {
      if (cx(w) < nameEnd) { nameSet.add(w); return; }
      const prev = sorted[i - 1];
      if (cx(w) < qtyEnd && prev && nameSet.has(prev) && (CJK_RE.test(w.text) || /^[()（）\[\]]+$/.test(w.text)) && w.bbox.x0 - prev.bbox.x1 < lineH)
        nameSet.add(w);
    });
    const nameWords = sorted.filter((w) => nameSet.has(w));
    const qtyWords = sorted.filter((w) => !nameSet.has(w) && cx(w) < qtyEnd);
    const amtWords = sorted.filter((w) => cx(w) >= qtyEnd);
    const hasDigits = /\d/.test(qtyWords.concat(amtWords).map((w) => w.text).join(''));

    // 沒有數字的列：可能是上一列名稱換行
    if (!hasDigits && !qtyWords.length && !amtWords.length) {
      const prev = out.items[out.items.length - 1];
      if (prev && nameWords.length && CJK_RE.test(text)) {
        prev.rawName += joinName(nameWords);
        prev.ocrText += ' / ' + text;
        prev.flags.push({ field: 'rawName', reason: '名稱可能分成兩行，已合併，請確認' });
      } else out.warnings.push('略過無法判讀的列：「' + text + '」');
      return;
    }

    const y0 = Math.min.apply(null, ln.words.map((w) => w.bbox.y0));
    const y1 = Math.max.apply(null, ln.words.map((w) => w.bbox.y1));
    const pad = Math.round((y1 - y0) * 0.35) + 4;
    const item = {
      ocrText: text,
      rawName: joinName(nameWords),
      deptCode: null, brand: null, barcode: null, spec: null,
      qty: null, unitPrice: null, originalAmount: null, discount: null, paidAmount: null,
      priceUnclear: false, isPromo: false, flags: [],
      cells: {
        qty: { left: Math.max(0, Math.round(nameEnd)), top: Math.max(0, y0 - pad), width: Math.round(qtyEnd - nameEnd), height: y1 - y0 + 2 * pad },
        paidAmount: { left: Math.round(qtyEnd), top: Math.max(0, y0 - pad), width: Math.round(W - qtyEnd), height: y1 - y0 + 2 * pad },
      },
    };
    const sd = L.stripDeptCode(item.rawName);
    item.deptCode = sd.deptCode;
    item.rawName = sd.name;
    const sp = L.parseSpec(item.rawName);
    if (sp) item.spec = sp.raw;
    if (!item.rawName || !CJK_RE.test(item.rawName)) item.flags.push({ field: 'rawName', reason: '沒有辨識到商品名稱' });
    else if (nameWords.some((w) => w.conf < NAME_CONF && !/^\d{1,3}$/.test(w.text)))
      item.flags.push({ field: 'rawName', reason: '名稱有字辨識信心偏低：' + nameWords.filter((w) => w.conf < NAME_CONF).map((w) => w.text).join('、') });

    const q = cleanNumber(qtyWords.map((w) => w.text).join(''));
    if (!qtyWords.length) item.flags.push({ field: 'qty', reason: '沒有辨識到數量' });
    else if (q.value == null) item.flags.push({ field: 'qty', reason: '數量無法判讀（' + qtyWords.map((w) => w.text).join('') + '）' });
    else {
      item.qty = q.value;
      if (q.substituted || lineConf(qtyWords) < NUM_CONF) item.flags.push({ field: 'qty', reason: '數量辨識不確定（' + qtyWords.map((w) => w.text).join('') + '）' });
      if (!(q.value > 0) || q.value > 999 || q.value !== Math.floor(q.value)) item.flags.push({ field: 'qty', reason: '數量 ' + q.value + ' 不合理' });
    }

    const a = cleanNumber(amtWords.map((w) => w.text).join(''));
    if (!amtWords.length) item.flags.push({ field: 'paidAmount', reason: '沒有辨識到金額' });
    else if (a.value == null) item.flags.push({ field: 'paidAmount', reason: '金額無法判讀（' + amtWords.map((w) => w.text).join('') + '）' });
    else {
      item.paidAmount = a.value;
      if (a.substituted || lineConf(amtWords) < NUM_CONF) item.flags.push({ field: 'paidAmount', reason: '金額辨識不確定（' + amtWords.map((w) => w.text).join('') + '）' });
      if (a.value < 0) item.flags.push({ field: 'paidAmount', reason: '負數金額，可能是折扣列，請確認歸屬' });
    }
    if (/[(（]促|贈/.test(item.rawName) && item.paidAmount === 0) item.isPromo = true;
    out.items.push(item);
  }

  /*
   * 數字欄第二次辨識（只辨識數字）的結果併回草稿。
   * 兩次一致 → 解除待確認；不一致或第一次讀不到 → 保留待確認並附上說明。
   */
  function applyRefinement(item, field, second) {
    if (!second || second.value == null) return item;
    const cur = item[field];
    const open = item.flags.filter((f) => f.field === field && !f.resolved);
    if (cur == null) {
      item[field] = second.value;
      item.flags = item.flags.filter((f) => f.field !== field);
      item.flags.push({ field, reason: '第一次辨識失敗，第二次只辨識數字得到 ' + second.value + '，請確認' });
    } else if (cur === second.value) {
      if (open.length && second.conf >= 80 && !open.some((f) => /不合理|負數/.test(f.reason))) item.flags = item.flags.filter((f) => f.field !== field);
    } else {
      item.flags.push({ field, reason: '兩次辨識結果不同：' + cur + ' / ' + second.value + '，請確認' });
    }
    return item;
  }

  function needsRefine(item, field) {
    return item.flags.some((f) => f.field === field && !f.resolved);
  }

  return { parsePage, cleanNumber, parseDate, applyRefinement, needsRefine };
});
