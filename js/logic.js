/*
 * 全聯消費明細抓鬼系統：純計算邏輯（不碰畫面、不碰資料庫）
 * 瀏覽器中為 window.PXLogic，Node 測試中以 require() 載入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PXLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;

  // ---------- 文字正規化 ----------
  function normalizeText(s) {
    if (s == null) return '';
    return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // 全聯明細商品名稱前面常有 2 位數部門代碼，例如「26 進口結球萵苣」
  function stripDeptCode(name) {
    const s = String(name || '').normalize('NFKC').trim();
    const m = s.match(/^(\d{1,3})\s+(.+)$/);
    if (m) return { deptCode: m[1], name: m[2].trim() };
    return { deptCode: null, name: s };
  }

  // ---------- 規格（容量／重量） ----------
  const UNIT_MAP = {
    ml: ['ml', 1], cc: ['ml', 1], '毫升': ['ml', 1],
    l: ['ml', 1000], '公升': ['ml', 1000],
    g: ['g', 1], '公克': ['g', 1], '克': ['g', 1],
    kg: ['g', 1000], '公斤': ['g', 1000],
  };
  const SPEC_RE = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(ml|cc|毫升|kg|公斤|公克|公升|g|克|l)(?![a-z])/i;

  // 入數：「x6」「*6入」「6入」「12包」…
  const COUNT_RE = /[x×*]\s*(\d{1,3})(?!\d)\s*(?:入|瓶|罐|包|盒|顆|粒|片|條|支|袋|捲|杯|組)?|(\d{1,3})\s*(?:入|瓶|罐|包|盒|顆|粒|片|條|支|袋|捲|杯|組)/i;

  // 由名稱或規格字串取出容量／重量與入數；都找不到時回傳 null，不猜測
  function parseSpec(text) {
    if (!text) return null;
    let s = String(text).normalize('NFKC');
    const out = { value: null, unit: null, count: null, raw: null, raws: [] };
    const m = s.match(SPEC_RE);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      const u = UNIT_MAP[m[2].toLowerCase()];
      if (u && num > 0) { out.value = num * u[1]; out.unit = u[0]; out.raws.push(m[0]); s = s.replace(m[0], ' '); }
    }
    const c = s.match(COUNT_RE);
    if (c) { const n = parseInt(c[1] || c[2], 10); if (n > 0) { out.count = n; out.raws.push(c[0]); } }
    if (!out.raws.length) return null;
    out.raw = out.raws.length === 1 ? out.raws[0] : String(text).normalize('NFKC').slice(
      Math.min.apply(null, out.raws.map((r) => String(text).normalize('NFKC').indexOf(r)).filter((i) => i >= 0)));
    out.raw = out.raw.trim();
    return out;
  }

  function specKey(spec) {
    const p = parseSpec(spec);
    if (p) return (p.unit ? p.unit + ':' + Math.round(p.value * 1000) / 1000 : '') + (p.count > 1 ? 'x' + p.count : '');
    return normalizeText(spec).replace(/\s/g, '');
  }

  // 兩個規格是否相同：'same'／'diff'／'unknown'（任一邊沒有規格）
  function specRelation(a, b) {
    if (!a || !b) return 'unknown';
    const pa = parseSpec(a), pb = parseSpec(b);
    if (pa && pb) {
      // 一邊只有容量、一邊只有入數時無法判斷
      if ((pa.unit && pb.unit) || (!pa.unit && !pb.unit)) return specKey(a) === specKey(b) ? 'same' : 'diff';
      return 'unknown';
    }
    return specKey(a) === specKey(b) ? 'same' : 'diff';
  }

  // 名稱去掉規格文字後的比對用名稱
  function baseName(name, spec) {
    let s = stripDeptCode(name).name.normalize('NFKC');
    const p = parseSpec(s);
    if (p) p.raws.forEach((r) => { s = s.replace(r, ' '); });
    if (spec) s = s.split(String(spec).normalize('NFKC')).join(' ');
    return normalizeText(s).replace(/[\s()（）\[\]【】]/g, '');
  }

  // 規格欄空白時，才從名稱中找容量／重量（例如「鮮乳 936ml」）
  function effectiveSpec(item) {
    if (item.spec) return item.spec;
    const p = parseSpec(stripDeptCode(item.rawName).name);
    return p ? p.raw : null;
  }

  function productKey(item) {
    const spec = effectiveSpec(item);
    return [baseName(item.rawName, spec), normalizeText(item.brand), specKey(spec)].join('|');
  }

  // 雙字元組相似度（0~1）
  function similarity(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.6 : 0;
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const ga = grams(a), gb = grams(b);
    let inter = 0;
    for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
    let dice = (2 * inter) / (a.length - 1 + b.length - 1);
    if (a.includes(b) || b.includes(a)) dice = Math.max(dice, 0.6);
    return dice;
  }

  // 價格差超過這個比例（且規格無法確認相同）時，視為可能是不同容量／規格
  const PRICE_TOL = 0.3;

  /*
   * 逐項比較一筆商品列與一個已知商品：條碼、名稱、品牌、規格（容量／重量／入數）、價格。
   * 每項結果：same 相同、diff 不同、unknown 缺資料、similar 名稱相似。
   * verdict：same 可自動歸入、check 需要使用者確認、conflict 絕不視為同一商品。
   * opts.itemPrice / opts.refPrice：本次與該商品上次的每件價格（可省略）
   */
  function compareToProduct(item, product, opts) {
    opts = opts || {};
    const dims = [];
    const ib = item.barcode ? String(item.barcode).trim() : '', pb = product.barcode ? String(product.barcode).trim() : '';
    dims.push({ key: 'barcode', label: '條碼', a: ib || null, b: pb || null, result: ib && pb ? (ib === pb ? 'same' : 'diff') : 'unknown' });
    const spec = effectiveSpec(item);
    const bn = baseName(item.rawName, spec);
    let nameSim = 0;
    for (const k of product.keys || []) nameSim = Math.max(nameSim, similarity(bn, k.split('|')[0]));
    if (!(product.keys || []).length) nameSim = similarity(bn, baseName(product.name, product.spec));
    dims.push({ key: 'name', label: '名稱', a: item.rawName, b: product.name, result: nameSim >= 1 ? 'same' : nameSim >= 0.5 ? 'similar' : 'diff', score: nameSim });
    const ibr = normalizeText(item.brand), pbr = normalizeText(product.brand);
    dims.push({ key: 'brand', label: '品牌', a: item.brand || null, b: product.brand || null, result: ibr && pbr ? (ibr === pbr ? 'same' : 'diff') : 'unknown' });
    dims.push({ key: 'spec', label: '容量／重量／入數', a: spec || null, b: product.spec || null, result: specRelation(spec, product.spec) });
    let pr = { key: 'price', label: '價格', a: isNum(opts.itemPrice) ? opts.itemPrice : null, b: isNum(opts.refPrice) ? opts.refPrice : null, result: 'unknown', pct: null };
    if (pr.a > 0 && pr.b > 0) {
      pr.pct = round2(((pr.a - pr.b) / pr.b) * 100);
      pr.result = Math.abs(pr.a - pr.b) / pr.b > PRICE_TOL ? 'diff' : 'same';
    }
    dims.push(pr);
    const d = Object.fromEntries(dims.map((x) => [x.key, x]));
    let verdict, reason = null;
    if (d.barcode.result === 'same') verdict = 'same';
    else if (d.barcode.result === 'diff') { verdict = 'conflict'; reason = '條碼不同'; }
    else if (d.spec.result === 'diff') { verdict = 'conflict'; reason = '規格不同'; }
    else if (d.brand.result === 'diff') { verdict = 'conflict'; reason = '品牌不同'; }
    else if (d.name.result === 'diff') { verdict = 'conflict'; reason = '名稱不同'; }
    else if (d.name.result === 'similar') { verdict = 'check'; reason = '名稱相似'; }
    else if (d.spec.result !== 'same' && d.price.result === 'diff') {
      verdict = 'check'; reason = '價差 ' + (pr.pct > 0 ? '+' : '') + pr.pct + '%，可能是不同容量／規格';
    } else if (d.spec.result === 'unknown' && spec && !product.spec) {
      verdict = 'check'; reason = '這筆有規格（' + spec + '），已知商品沒有規格';
    } else verdict = 'same';
    return { dims, verdict, reason };
  }

  /*
   * 商品比對：
   * 1. 條碼一致 → 同一商品；條碼不同 → 絕不合併
   * 2. 名稱一致，且品牌、規格沒有衝突、價格沒有異常 → 同一商品
   * 3. 規格、品牌兩邊都有且不同 → 絕不視為同一商品
   * 4. 同名商品有兩種以上（例如不同容量）、規格無法確認、或價差過大 → 待使用者確認
   * opts.priceOf(product) 回傳該商品上次的每件價格；item 的價格由 金額÷數量 計算
   */
  function matchProduct(item, products, opts) {
    opts = opts || {};
    const pool = products.filter((p) => !!p.isMock === !!item.isMock);
    if (item.barcode) {
      const b = String(item.barcode).trim();
      const hit = pool.find((p) => p.barcode && String(p.barcode).trim() === b);
      if (hit) return { type: 'barcode', product: hit, candidates: [], specConflicts: [] };
    }
    const key = productKey(item);
    const itemPrice = isNum(item.paidAmount) && isNum(item.qty) && item.qty > 0 && item.paidAmount > 0 ? item.paidAmount / item.qty : null;
    const sames = [], checks = [], specConflicts = [];
    for (const p of pool) {
      if ((p.notSame || []).includes(key)) continue;
      const c = compareToProduct(item, p, { itemPrice, refPrice: opts.priceOf ? opts.priceOf(p) : null });
      const name = c.dims[1];
      if (c.verdict === 'same') sames.push({ product: p, score: name.score, cmp: c });
      else if (c.verdict === 'check') checks.push({ product: p, score: name.score, cmp: c });
      else if (name.result !== 'diff' && c.reason !== '名稱不同') specConflicts.push(p);
    }
    // 只有一個完全符合、且沒有其他同名候選（例如另一種容量）才自動歸入
    if (sames.length === 1 && !checks.some((x) => x.score >= 1)) {
      return { type: 'exact', product: sames[0].product, candidates: [], specConflicts, cmp: sames[0].cmp };
    }
    // 同名不同容量（例如 936ml／1858ml）而明細沒有容量：各容量都已設定、且只有一個價格相符時，依價格對應
    if (sames.length === 1 && sames[0].product.spec && sames[0].cmp.dims[4].result === 'same') {
      const rivals = checks.filter((x) => x.score >= 1);
      if (rivals.length && rivals.every((x) => x.product.spec && x.cmp.dims[4].result === 'diff' && x.cmp.dims[3].result !== 'same')) {
        const s0 = sames[0];
        return { type: 'price', product: s0.product, candidates: [], specConflicts, cmp: s0.cmp,
          note: '明細沒有容量，依價格對應到 ' + s0.product.spec + '（' + rivals.map((x) => x.product.spec + ' 上次 ' + x.cmp.dims[4].b + ' 元').join('、') + '）' };
      }
    }
    const cands = sames.concat(checks);
    // 價格最接近的排前面
    const gap = (x) => { const pr = x.cmp.dims[4]; return pr.pct == null ? 1e9 : Math.abs(pr.pct); };
    cands.sort((x, y) => y.score - x.score || gap(x) - gap(y));
    if (cands.length) {
      const reason = sames.length > 1 || (sames.length && checks.length) ? '有 ' + cands.length + ' 個同名或相似商品（可能是不同容量），請選擇' : cands[0].cmp.reason;
      return { type: 'similar', product: null, candidates: cands.slice(0, 5), specConflicts, reason };
    }
    return { type: 'none', product: null, candidates: [], specConflicts };
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /*
   * 單筆商品列的價格口徑。
   * paidAmount = 明細上該列「金額」（整列小計，非單價）
   * unitPrice  = 截圖上明確顯示的單價（全聯明細通常沒有，保持空值）
   * 可比較價格 = 每件實付均價 = 金額 ÷ 數量（計算值，可追溯到原始列）
   */
  function linePrice(item) {
    const out = { paidPerUnit: null, listPerUnit: null, reason: null, derived: false };
    const flags = (item.flags || []).filter((f) => !f.resolved);
    if (item.priceUnclear) out.reason = '價格口徑不明';
    else if (flags.some((f) => f.field === 'qty' || f.field === 'paidAmount' || f.field === 'unitPrice'))
      out.reason = '數字待確認';
    else if (!isNum(item.qty) || item.qty <= 0) out.reason = '缺少數量';
    else if (!isNum(item.paidAmount)) out.reason = '缺少金額';
    else if (item.paidAmount <= 0) out.reason = '金額為零或負數';
    if (!out.reason) {
      out.paidPerUnit = item.paidAmount / item.qty;
      out.derived = item.qty !== 1;
    }
    if (isNum(item.unitPrice) && item.unitPrice > 0) out.listPerUnit = item.unitPrice;
    else if (isNum(item.originalAmount) && item.originalAmount > 0 && isNum(item.qty) && item.qty > 0)
      out.listPerUnit = item.originalAmount / item.qty;
    return out;
  }

  // 價格差額與漲跌百分比；資料不足一律「無法比較」
  function comparePrices(prev, cur) {
    if (!isNum(prev) || !isNum(cur)) return { status: 'na', diff: null, pct: null, reason: '缺少基準價格或本次價格' };
    if (prev <= 0 || cur <= 0) return { status: 'na', diff: null, pct: null, reason: '價格為零或負數' };
    const diff = round2(cur - prev);
    const pct = round2((diff / prev) * 100);
    const status = diff > EPS ? 'up' : diff < -EPS ? 'down' : 'same';
    return { status, diff, pct, reason: null };
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  function sortKey(p) {
    return [p.txn.date || '', p.txn.time || '', p.txn.importedAt || '', String(p.item.lineNo || 0).padStart(4, '0')].join('|');
  }

  /*
   * 某商品的完整歷史：每次購買與「前一次有效購買」比較。
   * 只有日期明確、數字已確認、金額 > 0 的紀錄才算有效。
   */
  function productHistory(product, items, txnsById, mode) {
    mode = mode || 'paid';
    const specP = parseSpec(product.spec);
    const rows = items
      .filter((i) => i.productId === product.id)
      .map((item) => ({ item, txn: txnsById[item.txnId] || {} }))
      .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const validSoFar = [];
    const prices = [];
    for (const r of rows) {
      // 「上次」必須是另一筆交易；同一筆交易裡的重複列不互相比較
      let prevValid = null;
      for (let k = validSoFar.length - 1; k >= 0; k--) if (validSoFar[k].item.txnId !== r.item.txnId) { prevValid = validSoFar[k]; break; }
      const lp = linePrice(r.item);
      r.price = mode === 'list' ? lp.listPerUnit : lp.paidPerUnit;
      r.priceInfo = lp;
      r.reason = lp.reason;
      if (!r.txn.date) { r.price = null; r.reason = r.reason || '缺少日期'; }
      if (r.price == null && !r.reason) r.reason = mode === 'list' ? '截圖沒有原價' : '無法計算';
      r.per100 = r.price != null && specP && specP.unit ? round2((r.price / (specP.value * (specP.count || 1))) * 100) : null;
      r.per100Unit = specP && specP.unit ? (specP.unit === 'ml' ? '每100ml' : '每100g') : null;
      if (r.price != null) {
        r.prev = prevValid;
        r.cmp = prevValid ? comparePrices(prevValid.price, r.price) : { status: 'na', diff: null, pct: null, reason: '沒有上次紀錄' };
        if (prevValid && r.cmp.status !== 'na') {
          const d1 = r.item.discount || 0, d0 = prevValid.item.discount || 0;
          if ((d1 > 0 || d0 > 0) && d1 !== d0) r.cmp.note = '兩次優惠條件不同';
          if ((r.txn.discountTotal || 0) > 0 || (prevValid.txn.discountTotal || 0) > 0)
            r.cmp.note = (r.cmp.note ? r.cmp.note + '；' : '') + '有整筆折扣未分攤';
          // 價差過大：明細常沒有容量，可能把不同容量的商品當成同一個。使用者確認前不算漲跌
          const ok = product.priceJumpOk || [];
          if (Math.abs(r.cmp.pct) > PRICE_TOL * 100 && !ok.includes(r.item.id)) {
            r.cmp.status = 'check';
            r.cmp.reason = '價差 ' + (r.cmp.pct > 0 ? '+' : '') + r.cmp.pct + '%，可能是不同容量／規格';
          }
        }
        validSoFar.push(r);
        prices.push(r.price);
      } else {
        r.prev = null;
        r.cmp = { status: 'na', diff: null, pct: null, reason: r.reason };
      }
    }
    const valid = rows.filter((r) => r.price != null);
    const latest = valid[valid.length - 1] || null;
    return {
      rows,
      count: rows.length,
      validCount: valid.length,
      min: prices.length ? Math.min.apply(null, prices) : null,
      max: prices.length ? Math.max.apply(null, prices) : null,
      latest,
      previous: latest ? latest.prev : null,
      status: latest && latest.prev ? latest.cmp.status : 'na',
      cmp: latest && latest.prev ? latest.cmp : { status: 'na', reason: latest ? '只有一次有效紀錄' : '沒有有效紀錄' },
    };
  }

  // ---------- 重複匯入偵測 ----------
  function txnFingerprint(txn, items) {
    const lines = items
      .map((i) => [baseName(i.rawName, i.spec), i.qty == null ? '' : i.qty, i.paidAmount == null ? '' : i.paidAmount].join(':'))
      .sort();
    const total = txn.spendTotal != null ? txn.spendTotal : txn.paymentTotal;
    return [normalizeText(txn.store), txn.date || '', txn.time || '', total == null ? '' : total, lines.join(',')].join('#');
  }

  function findDuplicateTxn(txn, items, existingTxns) {
    const fp = txnFingerprint(txn, items);
    for (const t of existingTxns) {
      if (t.id === txn.id || !!t.isMock !== !!txn.isMock) continue;
      if (txn.invoiceNo && t.invoiceNo && txn.invoiceNo === t.invoiceNo) return { txn: t, why: '發票號碼相同' };
      // 交易序號每台機器每天會重複使用，必須連同機台與日期一起比對
      if (txn.txnNo && t.txnNo && txn.txnNo === t.txnNo && (txn.posNo || '') === (t.posNo || '') && (txn.date || '') === (t.date || ''))
        return { txn: t, why: '交易日期、機台與交易序號相同' };
      if (t.fingerprint === fp) return { txn: t, why: '門市、日期、金額與商品明細完全相同' };
    }
    return null;
  }

  // 同一筆交易中重複出現的商品列（可能是分行顯示、不同折扣或重複辨識）
  function findRepeatedLines(items) {
    const seen = new Map();
    const dups = [];
    items.forEach((it, idx) => {
      const k = productKey(it);
      if (seen.has(k)) dups.push([seen.get(k), idx]);
      else seen.set(k, idx);
    });
    return dups;
  }

  // ---------- 多張截圖合併 ----------
  // 兩張截圖的同一列可能被辨識成略有差異的名稱：數量與金額必須相同，名稱另外計算相似度
  function sameNumbers(a, b) { return a.qty === b.qty && a.paidAmount === b.paidAmount && a.paidAmount != null; }
  function similarName(a, b) { return similarity(baseName(a.rawName), baseName(b.rawName)) >= 0.6; }

  /*
   * 把同一筆交易的多張截圖解析結果合併成一筆交易。
   * 上一張最後幾列與下一張最前幾列相同時，視為捲動截圖的重疊，標記 overlap（預設不寫入）。
   */
  /*
   * 一次選了好幾筆交易的截圖時，依截圖順序分組：
   * 有「交易日期／交易序號／發票號碼」的截圖是一筆交易的第一張；後面沒有這些欄位的截圖是同一筆的續頁。
   * 回傳每組的截圖索引，例如 [[0,1],[2,3,4]]。
   */
  function splitPages(pages) {
    const groups = [];
    let cur = null;
    pages.forEach((pg, i) => {
      const starter = !!(pg && (pg.date || pg.txnNo || pg.invoiceNo));
      if (!cur || (starter && cur.hasStarter)) { cur = { idx: [], hasStarter: false }; groups.push(cur); }
      cur.idx.push(i);
      if (starter) cur.hasStarter = true;
    });
    return groups.map((g) => g.idx);
  }

  function mergePages(pages) {
    const HEAD = ['store', 'date', 'time', 'posNo', 'txnNo', 'invoiceNo', 'spendTotal', 'paymentMethod', 'paymentTotal', 'discountTotal', 'points'];
    const merged = { items: [], warnings: [], fieldFlags: {} };
    HEAD.forEach((f) => { merged[f] = null; });
    let prevItems = [];
    pages.forEach((pg, pi) => {
      for (const f of HEAD) {
        if (pg[f] == null || pg[f] === '') continue;
        if (merged[f] == null) {
          merged[f] = pg[f];
          if (pg.fieldFlags && pg.fieldFlags[f]) merged.fieldFlags[f] = pg.fieldFlags[f];
        } else if (merged[f] !== pg[f]) {
          merged.fieldFlags[f] = '不同截圖辨識到不同的值（' + merged[f] + ' / ' + pg[f] + '），請確認';
          merged.warnings.push('第 ' + (pi + 1) + ' 張截圖的「' + f + '」與前面不同');
        }
      }
      const items = (pg.items || []).map((it) => Object.assign({}, it, { page: pi }));
      // 找最長重疊：上一張尾端 k 列與這一張開頭 k 列的數量、金額都相同，且至少一半的名稱相似
      let overlap = 0;
      for (let k = Math.min(prevItems.length, items.length); k > 0; k--) {
        let ok = true, names = 0;
        for (let j = 0; j < k; j++) {
          const a = prevItems[prevItems.length - k + j], b = items[j];
          if (!sameNumbers(a, b)) { ok = false; break; }
          if (similarName(a, b)) names++;
        }
        if (ok && names * 2 >= k) { overlap = k; break; }
      }
      for (let j = 0; j < items.length; j++) {
        if (j < overlap) items[j].overlap = true;
        merged.items.push(items[j]);
      }
      if (overlap) merged.warnings.push('第 ' + (pi + 1) + ' 張截圖開頭有 ' + overlap + ' 列與上一張重疊，已預設不重複計入');
      if (pg.warnings) pg.warnings.forEach((w) => merged.warnings.push('第 ' + (pi + 1) + ' 張：' + w));
      prevItems = items;
    });
    return merged;
  }

  // 明細金額合計 vs 付款金額的交叉檢查
  function crossCheck(draft) {
    const lines = draft.items.filter((i) => !i.overlap && !i.excluded);
    const paid = isNum(draft.spendTotal) ? draft.spendTotal : draft.paymentTotal;
    if (!isNum(paid) || !lines.length || lines.some((i) => !isNum(i.paidAmount))) return null;
    const sum = lines.reduce((s, i) => s + i.paidAmount, 0);
    const expect = sum - (draft.discountTotal || 0);
    return { sum: round2(sum), expect: round2(expect), paid, ok: Math.abs(expect - paid) < 0.005 };
  }

  // ---------- CSV ----------
  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(txns, items, products) {
    const tById = Object.fromEntries(txns.map((t) => [t.id, t]));
    const pById = Object.fromEntries(products.map((p) => [p.id, p]));
    const head = ['模擬資料', '交易ID', '消費日期', '時間', '門市', '交易機台', '交易序號', '發票號碼', '消費金額', '付款方式', '付款金額', '整筆折扣',
      '列號', '原始名稱', '統一商品名稱', '部門代碼', '品牌', '規格', '條碼', '數量', '單價(截圖)', '原價小計', '折扣', '金額(實付小計)',
      '每件實付均價(計算)', '價格口徑不明', '待確認欄位', '商品比對狀態', '來源截圖數', '匯入時間'];
    const rows = [head];
    const sorted = items.slice().sort((a, b) => {
      const ta = tById[a.txnId] || {}, tb = tById[b.txnId] || {};
      return ((ta.date || '') + (ta.time || '') + a.txnId + String(a.lineNo).padStart(4, '0')).localeCompare((tb.date || '') + (tb.time || '') + b.txnId + String(b.lineNo).padStart(4, '0'));
    });
    for (const i of sorted) {
      const t = tById[i.txnId] || {};
      const p = pById[i.productId] || {};
      const lp = linePrice(i);
      rows.push([t.isMock ? '是' : '', t.id, t.date, t.time, t.store, t.posNo, t.txnNo, t.invoiceNo, t.spendTotal, t.paymentMethod, t.paymentTotal, t.discountTotal,
        i.lineNo, i.rawName, p.name, i.deptCode, i.brand, i.spec, i.barcode, i.qty, i.unitPrice, i.originalAmount, i.discount, i.paidAmount,
        lp.paidPerUnit == null ? '' : round2(lp.paidPerUnit), i.priceUnclear ? '是' : '',
        (i.flags || []).filter((f) => !f.resolved).map((f) => f.field).join(' '),
        i.matchStatus, (t.imageIds || []).length, t.importedAt]);
    }
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  // ---------- 備份檔驗證 ----------
  function validateBackup(obj) {
    if (!obj || typeof obj !== 'object') return '檔案不是有效的 JSON 物件';
    if (obj.app !== 'px-ghost') return '這不是抓鬼系統的備份檔';
    const d = obj.data;
    if (!d || !Array.isArray(d.transactions) || !Array.isArray(d.items) || !Array.isArray(d.products))
      return '備份檔缺少交易、商品明細或商品資料';
    for (const i of d.items) if (!i.id || !i.txnId) return '商品明細缺少 id 或交易 id';
    for (const t of d.transactions) if (!t.id) return '交易缺少 id';
    return null;
  }

  // 由文字取出數字，只接受明確的數字字元；回傳 null 表示無法判讀
  function parseAmount(s) {
    if (s == null) return null;
    const t = String(s).normalize('NFKC').replace(/[,\s$]|NT\$?/gi, '');
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return parseFloat(t);
  }

  return {
    normalizeText, stripDeptCode, parseSpec, specKey, specRelation, compareToProduct, PRICE_TOL, baseName, effectiveSpec, productKey, similarity, matchProduct,
    linePrice, comparePrices, productHistory, txnFingerprint, findDuplicateTxn, findRepeatedLines,
    mergePages, splitPages, crossCheck, toCSV, validateBackup, parseAmount, round2,
  };
});
