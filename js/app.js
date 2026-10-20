/*
 * 全聯消費明細抓鬼系統 V1.0：畫面與操作
 * 依賴：PXLogic（logic.js）、PXParser（parser.js）、PXDB（db.js）、PXOcr（ocr.js）、PXMock（mock.js）
 */
(function () {
  'use strict';
  const L = PXLogic, DB = PXDB;

  const FIELD_LABELS = {
    store: '門市', date: '消費日期', time: '時間', posNo: '交易機台', txnNo: '交易序號', invoiceNo: '發票號碼',
    spendTotal: '消費金額', paymentMethod: '付款方式', paymentTotal: '付款金額', discountTotal: '整筆優惠折扣', points: '回饋點數',
    rawName: '商品名稱', deptCode: '部門代碼', brand: '品牌', spec: '規格', barcode: '條碼', qty: '數量', unitPrice: '單價（截圖有顯示才填）',
    originalAmount: '原價小計', discount: '折扣金額', paidAmount: '金額（實付小計）', priceUnclear: '價格口徑不明',
    name: '統一商品名稱', note: '備註',
  };
  const TXN_FIELDS = ['store', 'date', 'time', 'posNo', 'txnNo', 'invoiceNo', 'spendTotal', 'paymentMethod', 'paymentTotal', 'discountTotal'];
  const NUM_FIELDS = new Set(['spendTotal', 'paymentTotal', 'discountTotal', 'points', 'qty', 'unitPrice', 'originalAmount', 'discount', 'paidAmount']);
  const ITEM_FIELDS = ['rawName', 'deptCode', 'brand', 'spec', 'barcode', 'qty', 'unitPrice', 'originalAmount', 'discount', 'paidAmount'];
  const KEY_FIELDS = ['rawName', 'brand', 'spec', 'barcode'];

  const S = {
    txns: [], items: [], products: [], tById: {}, pById: {},
    route: { name: 'home', param: null }, draft: null, restore: null, dupBlock: null, queue: [], queueTotal: 0,
    filter: { changes: 'all', q: '', from: '', to: '', mode: 'paid' },
    showMock: true, lastBackupAt: null, ocrState: null, notice: null,
  };
  const app = document.getElementById('app');

  // ---------- 小工具 ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const nowISO = () => new Date().toISOString();
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) {
    if (n == null || n === '' || !isFinite(n)) return '—';
    const r = L.round2(n);
    return (Number.isInteger(r) ? String(r) : r.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function signed(n) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '±') + money(Math.abs(n)); }
  function fmtTime(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleString('zh-TW', { hour12: false }); }
  function dateLabel(t) { return t.date ? t.date + (t.time ? ' ' + t.time : '') : '未填日期'; }
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式等 */ } }
  function toast(msg, ms) {
    // 同時只顯示一則，新的取代舊的，避免文字疊在一起
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg; el.setAttribute('role', 'status');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 2600);
  }
  function parseNum(v) {
    if (v == null) return null;
    const s = String(v).trim().replace(/,/g, '');
    if (s === '') return null;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function vis(x) { return S.showMock || !x.isMock; }
  function mockBadge(x) { return x && x.isMock ? '<span class="badge mock">模擬</span>' : ''; }

  // ---------- 資料載入 ----------
  async function loadAll() {
    const [t, i, p] = await Promise.all([DB.getAll('transactions'), DB.getAll('items'), DB.getAll('products')]);
    S.txns = t; S.items = i; S.products = p;
    S.tById = Object.fromEntries(t.map((x) => [x.id, x]));
    S.pById = Object.fromEntries(p.map((x) => [x.id, x]));
    S.lastBackupAt = await DB.getMeta('lastBackupAt', null);
    const hasReal = t.some((x) => !x.isMock);
    S.showMock = lsGet('pxg.showMock', !hasReal);
  }

  function histories(mode) {
    const out = [];
    for (const p of S.products) {
      if (!vis(p)) continue;
      out.push({ product: p, h: L.productHistory(p, S.items, S.tById, mode || 'paid') });
    }
    return out;
  }

  function openFlags(x) { return (x.flags || []).filter((f) => !f.resolved); }
  function openFieldFlags(t) { return Object.entries(t.fieldFlags || {}).filter(([, v]) => v && !(typeof v === 'object' && v.resolved)); }
  function flagText(v) { return typeof v === 'object' ? v.reason : v; }

  function pendingInfo() {
    const items = S.items.filter((i) => { const t = S.tById[i.txnId]; return t && vis(t); });
    const match = items.filter((i) => i.matchStatus === 'pending' || i.matchStatus === 'deferred');
    const flagged = items.filter((i) => openFlags(i).length);
    const txns = S.txns.filter(vis);
    const noDate = txns.filter((t) => !t.date);
    const txnFlags = txns.filter((t) => openFieldFlags(t).some(([f]) => !(f === 'date' && !t.date)));
    return { match, flagged, noDate, txnFlags, total: match.length + flagged.length + noDate.length + txnFlags.length };
  }

  // ---------- 路由 ----------
  function go(name, param, opts) {
    S.route = { name, param: param || null };
    const h = '#' + name + (param ? '-' + param : '');
    try { if (location.hash !== h) history.pushState(null, '', h); } catch (e) { /* 部分內嵌環境不允許 */ }
    render();
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
  }
  function routeFromHash() {
    const h = (location.hash || '').replace(/^#/, '');
    const m = h.match(/^([a-z]+)(?:-(.+))?$/);
    if (m && VIEWS[m[1]]) S.route = { name: m[1], param: m[2] || null };
  }
  window.addEventListener('popstate', () => { routeFromHash(); render(); });

  function topbar(title, back) {
    return '<header class="topbar">' + (back !== false ? '<button class="back" data-act="back" aria-label="返回">‹ 返回</button>' : '') +
      '<h1>' + esc(title) + '</h1>' +
      (S.route.name !== 'home' ? '<button class="back" data-act="nav" data-to="home">首頁</button>' : '') + '</header>';
  }

  function render() {
    const v = VIEWS[S.route.name] || VIEWS.home;
    try { app.innerHTML = v(S.route.param); }
    catch (e) { console.error(e); app.innerHTML = topbar('發生錯誤') + '<main><div class="notice bad">畫面產生失敗：' + esc(e.message) + '</div></main>'; }
    if (S.route.name === 'product') drawLater();
  }

  // ---------- 價格比較徽章 ----------
  function cmpBadge(cmp) {
    if (!cmp || cmp.status === 'na') return '<span class="badge na">無法比較' + (cmp && cmp.reason ? '：' + esc(cmp.reason) : '') + '</span>';
    if (cmp.status === 'same') return '<span class="badge same">＝ 價格不變</span>';
    const up = cmp.status === 'up';
    return '<span class="badge ' + cmp.status + '">' + (up ? '▲ 上漲 ' : '▼ 下降 ') + signed(cmp.diff) + '（' + (cmp.pct > 0 ? '+' : '') + cmp.pct + '%）</span>';
  }

  // =====================================================================
  // 首頁
  // =====================================================================
  function viewHome() {
    const hs = histories();
    const c = { up: 0, down: 0, same: 0 };
    hs.forEach(({ h }) => { if (c[h.status] != null) c[h.status]++; });
    const pend = pendingInfo();
    const txns = S.txns.filter(vis), products = S.products.filter(vis);
    const mockCount = S.txns.filter((t) => t.isMock).length;
    const realCount = S.txns.length - mockCount;
    let backupNote = '';
    if (realCount) {
      const days = S.lastBackupAt ? Math.floor((Date.now() - new Date(S.lastBackupAt)) / 864e5) : null;
      if (days == null) backupNote = '<div class="notice">你還沒有備份過。資料只存在這個瀏覽器，清除瀏覽資料或換手機就會遺失。<button class="btn small" data-act="nav" data-to="backup">去備份</button></div>';
      else if (days >= 14) backupNote = '<div class="notice">上次備份是 ' + days + ' 天前，建議再備份一次。<button class="btn small" data-act="nav" data-to="backup">去備份</button></div>';
    }
    const latest = txns.slice().sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''))[0];
    let latestHtml = '';
    if (latest) {
      const rows = S.items.filter((i) => i.txnId === latest.id).sort((a, b) => a.lineNo - b.lineNo).slice(0, 8).map((i) => {
        const cmp = itemCmp(i);
        return '<div class="spread"><span>' + esc(i.rawName) + ' <span class="muted small">×' + esc(i.qty == null ? '?' : i.qty) + '</span></span>' + cmpBadge(cmp) + '</div>';
      }).join('');
      latestHtml = '<section class="card"><div class="spread"><h2>最近一次匯入</h2>' + mockBadge(latest) +
        '<button class="btn small" data-act="nav" data-to="txn" data-id="' + latest.id + '">看明細</button></div>' +
        '<p class="small muted">' + esc(latest.store || '未填門市') + '・' + esc(dateLabel(latest)) + '</p>' + rows + '</section>';
    }
    return topbar('抓鬼首頁', false) + '<main>' +
      '<div class="hero"><div class="brand">全聯消費明細<em>抓鬼</em>系統</div><p class="muted small">上傳全聯 App 消費明細截圖，自動比對同一商品上次買多少錢。</p></div>' +
      backupNote +
      (S.notice ? '<div class="notice info">' + S.notice + '</div>' : '') +
      '<div class="tiles">' +
      tile('交易', txns.length, '', 'txns') + tile('商品', products.length, '', 'products') + tile('待確認', pend.total, pend.total ? 'warn' : '', 'review') +
      tile('上漲', c.up, 'up', 'changes', 'up') + tile('下降', c.down, 'down', 'changes', 'down') + tile('不變', c.same, '', 'changes', 'same') +
      '</div>' +
      '<p class="small muted">上漲／下降／不變：每個商品「最近一次」與「前一次」有效購買的比較。</p>' +
      '<nav class="menu">' +
      '<button class="btn primary" data-act="nav" data-to="import">匯入消費截圖 <small>相簿選圖・可多張</small></button>' +
      '<button class="btn" data-act="nav" data-to="changes">查看商品價格變化 <small>上次 vs 本次</small></button>' +
      '<button class="btn" data-act="nav" data-to="products">查看所有商品 <small>' + products.length + ' 項</small></button>' +
      '<button class="btn" data-act="nav" data-to="txns">查看歷史交易 <small>' + txns.length + ' 筆</small></button>' +
      '<button class="btn" data-act="nav" data-to="backup">匯出資料與備份 <small>JSON・CSV</small></button>' +
      '<button class="btn" data-act="nav" data-to="backup" data-focus="restore">還原備份 <small>從 JSON 檔</small></button>' +
      (pend.total ? '<button class="btn" data-act="nav" data-to="review">處理待確認 <small>' + pend.total + ' 項</small></button>' : '') +
      '<button class="btn" data-act="nav" data-to="help">使用說明與資料保存 <small>必讀</small></button>' +
      '</nav>' + latestHtml +
      '<label class="check"><input type="checkbox" id="showMock" data-act="toggleMock"' + (S.showMock ? ' checked' : '') + '> 顯示模擬資料（' + mockCount + ' 筆模擬交易）</label>' +
      '</main>';
  }
  function tile(label, n, cls, to, filter) {
    return '<button class="tile ' + cls + '" data-act="nav" data-to="' + to + '"' + (filter ? ' data-filter="' + filter + '"' : '') + '><b>' + n + '</b><span>' + label + '</span></button>';
  }

  // 某商品明細列與上一次有效購買的比較
  function itemCmp(item, mode) {
    if (item.isPromo || item.matchStatus === 'promo') return { status: 'na', reason: '促銷／贈品列' };
    if (!item.productId) return { status: 'na', reason: item.matchStatus === 'pending' || item.matchStatus === 'deferred' ? '商品待確認' : '未對應商品' };
    const p = S.pById[item.productId];
    if (!p) return { status: 'na', reason: '找不到商品' };
    const h = L.productHistory(p, S.items, S.tById, mode || 'paid');
    const r = h.rows.find((x) => x.item.id === item.id);
    return r ? Object.assign({}, r.cmp, { prev: r.prev, row: r }) : { status: 'na', reason: '無資料' };
  }

  // =====================================================================
  // 匯入截圖
  // =====================================================================
  function newDraft(isMock) {
    return { id: uid(), isMock: !!isMock, images: [], txn: blankTxn(), items: [], warnings: [], stage: 'pick', columns: null };
  }
  function blankTxn() { const t = {}; TXN_FIELDS.forEach((f) => { t[f] = null; }); t.points = null; t.fieldFlags = {}; return t; }

  function viewImport() {
    const d = S.draft;
    let body = '';
    if (!d || !d.images.length && d.stage === 'pick') {
      body = '<section class="card"><h2>步驟 1：選擇截圖</h2>' +
        '<p class="small">在全聯 App 打開一筆交易的「消費明細」並截圖。一筆交易如果需要捲動，請截多張，<b>一起選取</b>，系統會合併成同一筆交易，並自動排除截圖重疊的列。</p>' +
        '<p class="small">也可以一次選好幾筆交易的截圖：請依交易順序選取，每筆的第一張要有「交易日期」。系統會自動分成好幾筆，再一筆一筆讓你核對。</p>' +
        filePicker('pick') +
        '<p class="small muted">截圖只在這支手機上辨識與保存，不會上傳到任何伺服器。</p></section>' +
        '<section class="card flat"><h2>沒有截圖也可以</h2><div class="row">' +
        '<button class="btn" data-act="manualDraft">手動輸入一筆交易</button>' +
        '<button class="btn" data-act="mockShots">用模擬截圖試用 OCR</button></div>' +
        '<p class="small muted">模擬截圖由程式產生，內容標示為模擬資料，不會和真實紀錄混在一起。</p></section>';
    } else {
      body = draftImagesCard(d) + (d.stage === 'review' ? reviewForm(d) : '');
    }
    return topbar('匯入消費截圖') + '<main>' + body + '</main>';
  }

  function filePicker(mode) {
    return '<label class="btn primary block" for="file-' + mode + '" style="justify-content:center">' +
      (mode === 'pick' ? '從相簿選擇截圖（可多張）' : '再加入截圖到同一筆交易') + '</label>' +
      '<input id="file-' + mode + '" type="file" accept="image/*" multiple hidden data-act="files" data-mode="' + mode + '">';
  }

  function draftImagesCard(d) {
    const st = S.ocrState;
    const thumbs = d.images.map((im, i) => '<div class="thumb"><img src="' + im.url + '" alt="截圖 ' + (i + 1) + '" data-act="view" data-src="' + im.url + '">' +
      '<span class="cap">' + (i + 1) + '．' + esc(statusText(im)) + '</span>' +
      (d.stage === 'pick' ? '<button class="x" data-act="rmImage" data-i="' + i + '" aria-label="移除">×</button>' : '') + '</div>').join('');
    const dups = d.images.filter((im) => im.dupOf).map((im) => '<div class="notice bad">「' + esc(im.name) + '」已經在 ' + esc(im.dupOf) + ' 匯入過。若是誤選請移除。</div>').join('');
    let actions = '';
    if (d.stage === 'pick') {
      actions = '<div class="row"><button class="btn primary" data-act="runOcr"' + (st && st.running ? ' disabled' : '') + '>開始辨識（' + d.images.length + ' 張）</button>' +
        '<button class="btn" data-act="skipOcr">不辨識，直接手動輸入</button>' +
        '<button class="btn" data-act="cancelDraft">取消</button></div>' + filePicker('add');
    } else {
      actions = filePicker('add');
    }
    const prog = st && st.running ? '<div class="stack"><div class="small">' + esc(st.text) + '</div><div class="progress"><i style="width:' + Math.round((st.p || 0) * 100) + '%"></i></div>' +
      '<p class="small muted">第一次使用要下載約 12 MB 的辨識模型，之後會快很多。</p></div>' : '';
    const err = st && st.error ? '<div class="notice bad">辨識失敗：' + esc(st.error) + '<br>你仍然可以按「不辨識，直接手動輸入」，對照截圖手動填寫。</div>' : '';
    const pos = S.queueTotal > 1 ? '<div class="notice">這次選取的截圖分成 ' + S.queueTotal + ' 筆交易，現在核對第 ' + (S.queueTotal - S.queue.length) + ' / ' + S.queueTotal + ' 筆。保存或放棄後會接著下一筆。</div>' : '';
    return '<section class="card"><div class="spread"><h2>' + (d.isMock ? '模擬截圖 ' : '') + '這筆交易的截圖（' + d.images.length + ' 張）</h2>' + mockBadge(d) + '</div>' + pos +
      '<div class="thumbs">' + thumbs + '</div>' + dups + prog + err + actions + '</section>';
  }
  function statusText(im) { return { wait: '待辨識', ocr: '辨識中', done: '已辨識', error: '失敗', manual: '手動' }[im.status] || ''; }

  async function addFiles(files, mode) {
    if (!files || !files.length) return;
    if (!S.draft) S.draft = newDraft(false);
    const d = S.draft;
    const existing = await DB.getAll('images').catch(() => []);
    const added = [];
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|webp|gif)$/i.test(f.name)) { toast('「' + f.name + '」不是圖片，已略過'); continue; }
      // 先把相簿檔案讀進記憶體：iPhone 上相簿檔案的參照過一陣子可能失效，導致之後保存失敗
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || 'image/jpeg' });
      const hash = await hashBlob(blob);
      if (d.images.some((im) => im.hash === hash)) { toast('同一張截圖選了兩次，已略過一張'); continue; }
      const old = existing.find((x) => x.hash === hash);
      const im = { id: uid(), name: f.name || '截圖', type: f.type || 'image/jpeg', blob, url: URL.createObjectURL(blob), hash, status: 'wait',
        dupOf: old ? (S.tById[old.txnId] ? dateLabel(S.tById[old.txnId]) + ' 的交易' : '先前的交易') : null };
      d.images.push(im); added.push(im);
    }
    render();
    if (mode === 'add' && d.stage === 'review' && added.length) await ocrImages(added, true);
  }

  async function hashBlob(blob) {
    const buf = await blob.arrayBuffer();
    try {
      if (crypto && crypto.subtle) {
        const h = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* 非安全連線時退回簡易雜湊 */ }
    const a = new Uint8Array(buf);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 16777619); h2 = Math.imul(h2 + a[i], 2246822519); }
    return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16);
  }

  async function ocrImages(images, append) {
    const d = S.draft;
    S.ocrState = { running: true, text: '準備辨識引擎…', p: 0 };
    render();
    const pages = [];
    try {
      for (let k = 0; k < images.length; k++) {
        const im = images[k];
        im.status = 'ocr';
        S.ocrState.text = '辨識第 ' + (k + 1) + ' / ' + images.length + ' 張…';
        render();
        const parsed = await PXOcr.recognize(im.blob, { columns: d.columns }, (m) => {
          if (S.ocrState) { S.ocrState.text = ocrStatusText(m, k, images.length); S.ocrState.p = (k + (m.progress || 0)) / images.length; updateProgress(); }
        });
        if (parsed.hasItemHeader) d.columns = parsed.columns;
        parsed.items.forEach((it) => { it.source = { imageId: im.id, rect: it.cells ? lineRect(it.cells, parsed.size) : null }; });
        im.status = 'done';
        im.size = parsed.size;
        pages.push(parsed);
      }
      if (!append) {
        // 一次選了多筆交易：依「交易日期」所在的截圖分組，第一組先核對，其餘排隊
        const groups = L.splitPages(pages);
        S.queue = groups.slice(1).map((g) => ({ isMock: d.isMock, images: g.map((i) => images[i]), pages: g.map((i) => pages[i]) }));
        S.queueTotal = groups.length;
        if (groups.length > 1) { d.images = groups[0].map((i) => images[i]); pages.splice(0, pages.length, ...groups[0].map((i) => pages[i])); }
      }
      absorbPages(d, pages, append);
      S.ocrState = null;
      d.stage = 'review';
      await makeCrops(d);
    } catch (e) {
      console.error(e);
      images.forEach((im) => { if (im.status === 'ocr' || im.status === 'wait') im.status = 'error'; });
      S.ocrState = { running: false, error: (e && e.message) || String(e) };
    }
    render();
  }
  function ocrStatusText(m, k, n) {
    const map = { 'loading tesseract core': '載入辨識引擎', 'initializing tesseract': '初始化', 'loading language traineddata': '下載繁體中文模型', 'initializing api': '初始化', 'recognizing text': '辨識文字' };
    return '第 ' + (k + 1) + ' / ' + n + ' 張：' + (map[m.status] || m.status) + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : '');
  }
  function updateProgress() {
    const bar = app.querySelector('.progress > i');
    const txt = app.querySelector('.progress') && app.querySelector('.progress').previousElementSibling;
    if (bar && S.ocrState) bar.style.width = Math.round((S.ocrState.p || 0) * 100) + '%';
    if (txt && S.ocrState) txt.textContent = S.ocrState.text;
  }
  function lineRect(cells, size) {
    const c = cells.qty || cells.paidAmount;
    return { top: c.top, height: c.height, width: size.width, imgH: size.height };
  }

  // 把新的辨識結果併入草稿：同一筆交易，表頭只補空白欄位，商品列排除與前面重疊的部分
  function absorbPages(d, pages, append) {
    const prevPage = append && d.items.length ? Object.assign({}, d.txn, { items: d.items.filter((i) => !i.overlap && !i.excluded) }) : null;
    const merged = L.mergePages(prevPage ? [prevPage].concat(pages) : pages);
    const startIdx = prevPage ? prevPage.items.length : 0;
    const newItems = merged.items.slice(startIdx).map((it) => Object.assign(it, { key: uid(), excluded: !!it.overlap }));
    if (!append) d.txn = blankTxn();
    for (const f of TXN_FIELDS.concat(['points'])) {
      if ((d.txn[f] == null || d.txn[f] === '') && merged[f] != null) {
        d.txn[f] = merged[f];
        if (merged.fieldFlags[f]) d.txn.fieldFlags[f] = { reason: merged.fieldFlags[f], resolved: false };
      } else if (append && merged.fieldFlags[f] && d.txn[f] !== merged[f] && merged[f] != null) {
        d.txn.fieldFlags[f] = { reason: merged.fieldFlags[f], resolved: false };
      }
    }
    d.items = append ? d.items.concat(newItems) : newItems;
    d.warnings = (append ? d.warnings : []).concat(merged.warnings);
    if (!d.txn.date) d.txn.fieldFlags.date = d.txn.fieldFlags.date || { reason: '截圖沒有顯示日期，請由全聯 App 交易列表查看後手動填入（沒填也能保存，但不會拿來比價）', resolved: false };
    renumber(d);
  }
  function renumber(d) { let n = 0; d.items.forEach((it) => { if (!it.excluded) it.lineNo = ++n; else it.lineNo = null; }); }

  async function makeCrops(d) {
    for (const it of d.items) {
      if (!it.source || !it.source.rect || it.cropUrl) continue;
      const im = d.images.find((x) => x.id === it.source.imageId);
      if (im) it.cropUrl = await cropLine(im.blob, it.source.rect);
    }
  }
  async function cropLine(blob, rect) {
    try {
      const bmp = await (window.createImageBitmap ? createImageBitmap(blob) : null);
      if (!bmp) return null;
      const scale = Math.min(1, 640 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.max(8, Math.round(rect.height * scale));
      c.getContext('2d').drawImage(bmp, 0, rect.top, bmp.width, rect.height, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.8);
    } catch (e) { return null; }
  }

  function txnField(prefix, f, t, flags) {
    const fl = flags && flags[f];
    const open = fl && !(typeof fl === 'object' && fl.resolved);
    const type = f === 'date' ? 'date' : f === 'time' ? 'time' : 'text';
    const im = NUM_FIELDS.has(f) ? ' inputmode="decimal"' : f === 'posNo' || f === 'txnNo' ? ' inputmode="numeric"' : '';
    return '<label class="field' + (open ? ' flagged' : '') + '"><span>' + FIELD_LABELS[f] + (open ? '・待確認' : '') + '</span>' +
      '<input id="' + prefix + '-' + f + '" type="' + type + '"' + im + ' value="' + esc(t[f] == null ? '' : t[f]) + '" data-bind="' + prefix + '.' + f + '" placeholder="截圖沒有就留空"></label>' +
      (open ? '<div class="flagrow"><span>' + esc(flagText(fl)) + '</span><button class="btn small" data-act="resolveTxnFlag" data-scope="' + prefix + '" data-f="' + f + '">確認無誤</button></div>' : '');
  }

  function itemEditor(it, idx, prefix) {
    const fl = openFlags(it);
    const ff = (f) => fl.some((x) => x.field === f);
    const inp = (f, extra) => {
      const im = NUM_FIELDS.has(f) ? ' inputmode="decimal"' : f === 'barcode' ? ' inputmode="numeric"' : '';
      return '<label class="field' + (ff(f) ? ' flagged' : '') + (extra || '') + '"><span>' + FIELD_LABELS[f] + (ff(f) ? '・待確認' : '') + '</span>' +
        '<input id="' + prefix + '-' + idx + '-' + f + '"' + im + ' value="' + esc(it[f] == null ? '' : it[f]) + '" data-bind="' + prefix + '.' + idx + '.' + f + '"></label>';
    };
    const lp = L.linePrice(it);
    const per = lp.paidPerUnit != null ? '每件實付均價 ' + money(lp.paidPerUnit) + (lp.derived ? '（金額 ÷ 數量，計算值）' : '') : '目前無法計算每件價格：' + (lp.reason || '');
    return '<div class="card itemcard' + (fl.length ? ' has-flag' : '') + (it.excluded ? ' excluded' : '') + '">' +
      '<div class="spread"><h3>' + (it.excluded ? '（不寫入）' : '第 ' + (it.lineNo || '?') + ' 列') + '</h3>' +
      (it.overlap ? '<span class="badge warn">與上一張截圖重疊</span>' : '') + (it.isPromo ? '<span class="badge na">促銷／贈品列</span>' : '') + '</div>' +
      (it.cropUrl ? '<img class="crop" src="' + it.cropUrl + '" alt="原始截圖這一列">' : '') +
      (it.ocrText ? '<p class="small muted">OCR 原文：' + esc(it.ocrText) + '</p>' : '') +
      inp('rawName') +
      '<div class="grid3">' + inp('qty') + inp('paidAmount') + inp('discount') + '</div>' +
      '<details><summary class="small">更多欄位（規格、品牌、條碼、單價、原價）</summary><div class="grid2">' +
      inp('spec') + inp('brand') + inp('barcode') + inp('deptCode') + inp('unitPrice') + inp('originalAmount') + '</div></details>' +
      '<label class="check"><input type="checkbox" id="' + prefix + '-' + idx + '-priceUnclear" data-bind="' + prefix + '.' + idx + '.priceUnclear" data-type="bool"' + (it.priceUnclear ? ' checked' : '') + '> 價格口徑不明（無法確定金額是單價還是小計）</label>' +
      '<p class="small muted">' + esc(per) + '</p>' +
      (fl.length ? '<div class="flags">' + fl.map((f) => '<div class="flagrow"><span>' + esc(FIELD_LABELS[f.field] || f.field) + '：' + esc(f.reason) + '</span>' +
        '<button class="btn small" data-act="resolveItemFlag" data-scope="' + prefix + '" data-i="' + idx + '" data-f="' + f.field + '">確認無誤</button></div>').join('') + '</div>' : '') +
      (prefix === 'd' ? '<div class="row"><button class="btn small" data-act="toggleExclude" data-i="' + idx + '">' + (it.excluded ? '改為寫入' : '這列不寫入') + '</button>' +
        '<button class="btn small danger" data-act="rmDraftItem" data-i="' + idx + '">刪除這列</button></div>' : '') +
      '</div>';
  }

  function reviewForm(d) {
    const included = d.items.filter((i) => !i.excluded);
    const cc = L.crossCheck(Object.assign({}, d.txn, { items: d.items }));
    const reps = L.findRepeatedLines(included);
    const flaggedCount = included.filter((i) => openFlags(i).length).length + Object.values(d.txn.fieldFlags || {}).filter((f) => f && !f.resolved).length;
    let checks = '';
    if (cc) checks += cc.ok ? '<div class="notice ok">商品金額合計 ' + money(cc.sum) + (d.txn.discountTotal ? ' − 折扣 ' + money(d.txn.discountTotal) : '') + ' ＝ 付款 ' + money(cc.paid) + '，數字一致。</div>'
      : '<div class="notice bad">商品金額合計 ' + money(cc.sum) + (d.txn.discountTotal ? ' − 折扣 ' + money(d.txn.discountTotal) : '') + ' ＝ ' + money(cc.expect) + '，但付款金額是 ' + money(cc.paid) + '。可能有數字辨識錯誤或漏截一段明細。</div>';
    if (reps.length) checks += '<div class="notice">同一筆交易中有相同商品出現多列（' + reps.map(([a, b]) => '第 ' + included[a].lineNo + ' 與第 ' + included[b].lineNo + ' 列').join('、') + '）。請確認是分行顯示、不同折扣，還是重複辨識；重複辨識請刪除多的那一列。</div>';
    if (d.warnings.length) checks += '<details><summary class="small">辨識過程提醒（' + d.warnings.length + '）</summary><ul class="small">' + d.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></details>';
    const dup = S.dupBlock ? '<div class="notice bad"><b>這筆交易可能已經匯入過</b><br>' + esc(S.dupBlock.why) + '：' + esc(dateLabel(S.dupBlock.txn)) + '，' + esc(S.dupBlock.txn.store || '') +
      '<div class="row" style="margin-top:8px"><button class="btn small" data-act="nav" data-to="txn" data-id="' + S.dupBlock.txn.id + '">查看那筆交易</button>' +
      '<button class="btn small danger" data-act="commit" data-force="1">我確定是另一次消費，仍要保存</button></div></div>' : '';
    return '<section class="card"><h2>步驟 2：核對交易資料</h2><p class="small muted">黃色欄位是 OCR 不確定的地方，請對照截圖修改，或按「確認無誤」。截圖沒有的欄位請保持空白。</p>' +
      '<div class="grid2">' + TXN_FIELDS.map((f) => txnField('t', f, d.txn, d.txn.fieldFlags)).join('') + '</div></section>' +
      '<section class="stack"><div class="spread"><h2>步驟 3：核對商品（' + included.length + ' 列）</h2><button class="btn small" data-act="addDraftItem">＋ 新增一列</button></div>' +
      '<p class="small muted">「金額」是整列小計。買 2 件共 196 元，數量填 2、金額填 196，系統會算出每件 98 元。</p>' +
      checks + d.items.map((it, i) => itemEditor(it, i, 'd')).join('') + '</section>' +
      '<section class="card"><h2>步驟 4：確認寫入</h2>' +
      (flaggedCount ? '<p class="small">還有 ' + flaggedCount + ' 個待確認欄位。可以先保存，這些列會標示「待確認」且暫不拿來比價。</p>' : '<p class="small">全部欄位都已確認。</p>') +
      dup + '<div class="row"><button class="btn primary" data-act="commit">確認並保存到資料庫</button><button class="btn" data-act="cancelDraft">放棄這筆</button></div></section>';
  }

  function blankItem() {
    return { key: uid(), ocrText: null, rawName: '', deptCode: null, brand: null, barcode: null, spec: null, qty: null, unitPrice: null,
      originalAmount: null, discount: null, paidAmount: null, priceUnclear: false, isPromo: false, flags: [], excluded: false };
  }

  // ---------- 產生模擬截圖（給沒有真實截圖時試用 OCR） ----------
  async function mockScreenshots() {
    const blobs = [];
    for (let k = 0; k < PXMock.SCREENSHOTS.length; k++) {
      const spec = PXMock.SCREENSHOTS[k];
      const W = 966, rowH = 105;
      const H = 140 + (spec.header ? 260 : 120) + spec.rows.length * rowH + (spec.footer ? 230 : 40);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#1f2a6b'; g.textBaseline = 'middle';
      const font = (w, s) => '"' + w + '" ' + s + 'px "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif';
      g.font = font('bold', 46).replace('"bold"', 'bold'); g.textAlign = 'center'; g.fillText('【模擬】測試門市', W / 2, 66);
      g.textAlign = 'left';
      let y = 150;
      if (spec.header) {
        g.font = '44px "PingFang TC", "Noto Sans CJK TC", sans-serif';
        g.fillText('交易日期', 54, y); g.textAlign = 'right'; g.fillText('2026/04/01 12:30', 912, y); g.textAlign = 'left'; y += 105;
      }
      g.font = 'bold 44px "PingFang TC", "Noto Sans CJK TC", sans-serif';
      g.fillText('消費明細', 54, y); y += 100;
      g.fillText('名稱', 54, y); g.textAlign = 'center'; g.fillText('數量', 586, y); g.textAlign = 'right'; g.fillText('金額', 912, y); g.textAlign = 'left'; y += rowH;
      g.font = '44px "PingFang TC", "Noto Sans CJK TC", sans-serif';
      for (const r of spec.rows) {
        g.fillText(r[0] + ' ' + r[1], 54, y); g.textAlign = 'center'; g.fillText(r[2], 586, y); g.textAlign = 'right'; g.fillText(r[3], 912, y); g.textAlign = 'left'; y += rowH;
      }
      if (spec.footer) {
        g.font = 'bold 44px "PingFang TC", "Noto Sans CJK TC", sans-serif'; g.fillText('付款方式', 54, y); y += 95;
        g.font = '44px "PingFang TC", "Noto Sans CJK TC", sans-serif'; g.fillText('模擬付款', 54, y); g.textAlign = 'right'; g.fillText(spec.total, 912, y); g.textAlign = 'left';
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      blobs.push(new File([blob], '模擬截圖' + (k + 1) + '.png', { type: 'image/png' }));
    }
    S.draft = newDraft(true);
    await addFiles(blobs, 'pick');
  }

  // ---------- 保存草稿 ----------
  async function commitDraft(force) {
    const d = S.draft;
    if (!d) return;
    const bad = [];
    for (const f of TXN_FIELDS) if (NUM_FIELDS.has(f) && Number.isNaN(d.txn[f])) bad.push(FIELD_LABELS[f]);
    const incl = d.items.filter((i) => !i.excluded);
    incl.forEach((it, i) => ITEM_FIELDS.forEach((f) => { if (NUM_FIELDS.has(f) && Number.isNaN(it[f])) bad.push('第 ' + (i + 1) + ' 列' + FIELD_LABELS[f]); }));
    if (bad.length) { toast('這些欄位不是數字：' + bad.join('、'), 4000); return; }
    if (!incl.length) { toast('至少要有一列商品才能保存'); return; }
    if (incl.some((i) => !String(i.rawName || '').trim())) { toast('有商品列沒有名稱，請填寫或刪除該列'); return; }

    const now = nowISO();
    const txnId = uid();
    const txn = { id: txnId, isMock: d.isMock, importedAt: now, updatedAt: now, editLog: [], imageIds: d.images.map((im) => im.id) };
    TXN_FIELDS.concat(['points']).forEach((f) => { txn[f] = d.txn[f] === '' ? null : d.txn[f]; });
    txn.fieldFlags = {};
    for (const [f, v] of Object.entries(d.txn.fieldFlags || {})) if (v && !v.resolved && !(f === 'date' && txn.date)) txn.fieldFlags[f] = v;
    const items = incl.map((it, i) => toItemRecord(it, txnId, i + 1, now, d.isMock));
    txn.fingerprint = L.txnFingerprint(txn, items);
    if (!force) {
      const dup = L.findDuplicateTxn(txn, items, S.txns);
      if (dup) { S.dupBlock = dup; render(); toast('偵測到可能重複匯入，請看步驟 4 的說明', 3500); return; }
    }
    const products = S.products.slice();
    const changed = assignProducts(items, products, d.isMock);
    const images = d.images.map((im) => ({ id: im.id, txnId, name: im.name, type: im.type, blob: im.blob, hash: im.hash, importedAt: now, isMock: d.isMock }));
    try {
      await DB.write({ put: { transactions: [txn], items, products: changed, images } });
    } catch (e) {
      toast('保存失敗：' + (e.message || e) + '。辨識結果還在畫面上，請再按一次「確認並保存」；仍失敗請先匯出備份。', 6000); return;
    }
    d.images.forEach((im) => { try { URL.revokeObjectURL(im.url); } catch (e) { /* ignore */ } });
    S.draft = null; S.dupBlock = null;
    await loadAll();
    if (await nextQueued()) { toast('已保存 ' + items.length + ' 列商品，接著核對下一筆', 3000); render(); return; }
    toast('已保存 ' + items.length + ' 列商品');
    go('txn', txnId);
  }

  // 多筆交易一起匯入時，取出下一筆讓使用者核對
  async function nextQueued() {
    const q = S.queue.shift();
    if (!q) { S.queueTotal = 0; return false; }
    const d = newDraft(q.isMock);
    d.images = q.images;
    absorbPages(d, q.pages, false);
    d.stage = 'review';
    S.draft = d;
    await makeCrops(d);
    window.scrollTo(0, 0);
    return true;
  }

  function toItemRecord(it, txnId, lineNo, now, isMock) {
    const rec = { id: uid(), txnId, lineNo, isMock: !!isMock, createdAt: now, updatedAt: now, editLog: [] };
    ITEM_FIELDS.forEach((f) => { rec[f] = it[f] === '' || it[f] === undefined ? null : it[f]; });
    if (typeof rec.rawName === 'string') rec.rawName = rec.rawName.trim();
    rec.ocrText = it.ocrText || null;
    rec.priceUnclear = !!it.priceUnclear;
    rec.isPromo = !!it.isPromo;
    rec.flags = (it.flags || []).filter((f) => !f.resolved).map((f) => ({ field: f.field, reason: f.reason }));
    rec.source = it.source || null;
    if (!rec.spec) { const sp = L.parseSpec(rec.rawName); if (sp) rec.spec = sp.raw; }
    return rec;
  }

  /*
   * 為新的商品列找對應商品（就地修改 items 與 products），回傳需要寫入的商品
   */
  function assignProducts(items, products, isMock) {
    const changed = new Map();
    for (const item of items) {
      item.candidateIds = [];
      item.matchNote = null;
      if (item.isPromo) { item.matchStatus = 'promo'; item.productId = null; continue; }
      const m = L.matchProduct(Object.assign({}, item, { isMock: !!isMock }), products);
      if (m.type === 'barcode' || m.type === 'exact') {
        item.productId = m.product.id; item.matchStatus = 'auto';
        addAlias(m.product, item); changed.set(m.product.id, m.product);
      } else if (m.type === 'similar') {
        item.productId = null; item.matchStatus = 'pending';
        item.candidateIds = m.candidates.map((c) => c.product.id);
      } else {
        const p = newProduct(item, isMock);
        products.push(p); changed.set(p.id, p);
        item.productId = p.id; item.matchStatus = 'new';
        if (m.specConflicts && m.specConflicts.length) item.matchNote = '已有同名但不同規格的商品（' + m.specConflicts.map((x) => x.name + (x.spec ? ' ' + x.spec : '')).join('、') + '），依規則分開建立，不合併比價';
      }
    }
    return Array.from(changed.values());
  }
  function newProduct(item, isMock) {
    const now = nowISO();
    return { id: uid(), name: item.rawName, brand: item.brand || null, spec: L.effectiveSpec(item), barcode: item.barcode || null,
      keys: [L.productKey(item)], aliases: [item.rawName], notSame: [], isMock: !!isMock, note: null, createdAt: now, updatedAt: now };
  }
  function addAlias(p, item) {
    const k = L.productKey(item);
    if (!p.keys.includes(k)) p.keys.push(k);
    if (!p.aliases.includes(item.rawName)) p.aliases.push(item.rawName);
    if (!p.barcode && item.barcode) p.barcode = item.barcode;
    p.updatedAt = nowISO();
  }
  function specConflict(item, p) {
    const a = L.specKey(L.effectiveSpec(item));
    const b = L.specKey(p.spec);
    return a && b && a !== b;
  }

  // =====================================================================
  // 交易列表與明細
  // =====================================================================
  function viewTxns() {
    const f = S.filter;
    const q = L.normalizeText(f.q);
    let list = S.txns.filter(vis);
    if (f.from) list = list.filter((t) => t.date && t.date >= f.from);
    if (f.to) list = list.filter((t) => t.date && t.date <= f.to);
    if (q) list = list.filter((t) => L.normalizeText(t.store).includes(q) || S.items.some((i) => i.txnId === t.id && L.normalizeText(i.rawName).includes(q)));
    list.sort((a, b) => ((b.date || '') + (b.time || '') + b.importedAt).localeCompare((a.date || '') + (a.time || '') + a.importedAt));
    const rows = list.map((t) => {
      const its = S.items.filter((i) => i.txnId === t.id);
      const pend = its.filter((i) => openFlags(i).length || i.matchStatus === 'pending' || i.matchStatus === 'deferred').length + (t.date ? 0 : 1) + openFieldFlags(t).length;
      return '<button class="li" data-act="nav" data-to="txn" data-id="' + t.id + '"><div class="spread"><span class="title">' + esc(dateLabel(t)) + '</span>' +
        '<span class="num">NT$ ' + money(t.spendTotal != null ? t.spendTotal : t.paymentTotal) + '</span></div>' +
        '<div class="meta">' + esc(t.store || '未填門市') + '・' + its.length + ' 項・' + (t.imageIds || []).length + ' 張截圖 ' + mockBadge(t) + (pend ? ' <span class="badge warn">待確認 ' + pend + '</span>' : '') + '</div></button>';
    }).join('');
    return topbar('歷史交易') + '<main>' + searchBar(true) + '<p class="small muted">' + list.length + ' 筆交易</p><div class="list">' + (rows || '<p class="muted">沒有符合的交易。</p>') + '</div></main>';
  }

  function searchBar(withDates) {
    return '<div class="stack"><input type="search" id="q" placeholder="搜尋商品名稱或門市" value="' + esc(S.filter.q) + '" data-filter-input="q">' +
      (withDates ? '<div class="grid2"><label class="field"><span>從日期</span><input type="date" id="from" value="' + esc(S.filter.from) + '" data-filter-input="from"></label>' +
        '<label class="field"><span>到日期</span><input type="date" id="to" value="' + esc(S.filter.to) + '" data-filter-input="to"></label></div>' : '') + '</div>';
  }

  function viewTxn(id) {
    const t = S.tById[id];
    if (!t) return topbar('交易') + '<main><p>找不到這筆交易，可能已被刪除。</p></main>';
    const its = S.items.filter((i) => i.txnId === id).sort((a, b) => a.lineNo - b.lineNo);
    const editing = S.editTxn === id;
    const head = editing
      ? '<section class="card"><h2>修改交易資料</h2><div class="grid2">' + TXN_FIELDS.map((f) => txnField('e', f, S.txnEdit, t.fieldFlags)).join('') + '</div>' +
        '<div class="row"><button class="btn primary" data-act="saveTxn" data-id="' + id + '">保存修改</button><button class="btn" data-act="cancelTxnEdit">取消</button></div></section>'
      : '<section class="card"><div class="spread"><h2>' + esc(t.store || '未填門市') + '</h2>' + mockBadge(t) + '</div><dl class="kv">' +
        TXN_FIELDS.filter((f) => f !== 'store').map((f) => '<dt>' + FIELD_LABELS[f] + '</dt><dd>' + (t[f] == null || t[f] === '' ? '<span class="muted">（空白）</span>' : esc(NUM_FIELDS.has(f) ? money(t[f]) : t[f])) + '</dd>').join('') +
        '<dt>匯入時間</dt><dd>' + esc(fmtTime(t.importedAt)) + '</dd></dl>' +
        openFieldFlags(t).map(([f, v]) => '<div class="flagrow"><span>' + esc(FIELD_LABELS[f] || f) + '：' + esc(flagText(v)) + '</span><button class="btn small" data-act="resolveSavedTxnFlag" data-id="' + id + '" data-f="' + f + '">確認無誤</button></div>').join('') +
        '<div class="row"><button class="btn small" data-act="editTxn" data-id="' + id + '">修改交易資料</button></div>' + logHtml(t.editLog) + '</section>';
    const rows = its.map((i) => {
      const cmp = itemCmp(i);
      const lp = L.linePrice(i);
      const p = S.pById[i.productId];
      const prev = cmp.prev;
      return '<div class="card itemcard' + (openFlags(i).length ? ' has-flag' : '') + '">' +
        '<div class="spread"><h3>' + esc(i.rawName) + (i.spec && !String(i.rawName).includes(i.spec) ? ' <span class="muted small">' + esc(i.spec) + '</span>' : '') + '</h3>' + cmpBadge(cmp) + '</div>' +
        '<div class="small muted">數量 <span class="num">' + esc(i.qty == null ? '—' : i.qty) + '</span>・金額 <span class="num">' + money(i.paidAmount) + '</span>' +
        (i.discount ? '・折扣 <span class="num">' + money(i.discount) + '</span>' : '') +
        (lp.paidPerUnit != null ? '・每件 <span class="num">' + money(lp.paidPerUnit) + '</span>' : '') + '</div>' +
        (prev ? '<div class="small">上次：' + esc(prev.txn.date) + ' 每件 <span class="num">' + money(prev.price) + '</span>' + (cmp.note ? '・<span class="badge warn">' + esc(cmp.note) + '</span>' : '') + '</div>' : '') +
        (p ? '<div class="small">商品：<a href="#product-' + p.id + '" data-act="nav" data-to="product" data-id="' + p.id + '">' + esc(p.name) + '</a></div>' : '') +
        (i.matchNote ? '<div class="small muted">' + esc(i.matchNote) + '</div>' : '') +
        (i.matchStatus === 'pending' || i.matchStatus === 'deferred' ? '<div class="flagrow"><span>不確定是不是已有的商品</span><button class="btn small" data-act="nav" data-to="review">去確認</button></div>' : '') +
        openFlags(i).map((f) => '<div class="flagrow"><span>' + esc(FIELD_LABELS[f.field] || f.field) + '：' + esc(f.reason) + '</span><button class="btn small" data-act="resolveSavedItemFlag" data-id="' + i.id + '" data-f="' + f.field + '">確認無誤</button></div>').join('') +
        (i.source && i.source.rect ? '<img class="crop" data-crop="' + i.id + '" alt="原始截圖這一列" hidden>' : '') +
        logHtml(i.editLog) +
        '<div class="row"><button class="btn small" data-act="nav" data-to="item" data-id="' + i.id + '">修改</button>' +
        '<button class="btn small danger" data-act="delItem" data-id="' + i.id + '">刪除這列</button></div></div>';
    }).join('');
    setTimeout(() => loadTxnImages(t, its), 0);
    return topbar('交易明細') + '<main>' +
      (S.route.justSaved ? '' : '') + head +
      '<section class="stack"><h2>商品（' + its.length + ' 列）與上次價格比較</h2>' + rows + '</section>' +
      '<section class="card"><h2>來源截圖</h2><div class="thumbs" id="txnThumbs"><span class="small muted">' + ((t.imageIds || []).length ? '載入中…' : '這筆是手動輸入，沒有截圖') + '</span></div></section>' +
      '<section class="card flat"><h2>刪除整筆交易</h2><p class="small muted">會一併刪除這筆的商品列與截圖。建議先備份。</p><div><button class="btn danger" data-act="delTxn" data-id="' + id + '">刪除這筆交易</button></div></section>' +
      '</main>';
  }

  function logHtml(log) {
    if (!log || !log.length) return '';
    return '<details><summary class="small">修改紀錄（' + log.length + '）</summary><div class="log">' +
      log.slice().reverse().map((e) => '<div>' + esc(fmtTime(e.at)) + '：' + esc(e.summary) + '</div>').join('') + '</div></details>';
  }

  const objectUrls = [];
  async function loadTxnImages(t, its) {
    const box = document.getElementById('txnThumbs');
    if (!box || !(t.imageIds || []).length) return;
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const ims = await DB.byIndex('images', 'txnId', t.id).catch(() => []);
    if (!document.getElementById('txnThumbs')) return;
    box.innerHTML = ims.map((im, k) => {
      const u = URL.createObjectURL(im.blob); objectUrls.push(u);
      return '<div class="thumb"><img src="' + u + '" alt="截圖 ' + (k + 1) + '" data-act="view" data-src="' + u + '"><span class="cap">' + (k + 1) + '．' + esc(im.name) + '</span></div>';
    }).join('') || '<span class="small muted">截圖已不存在（可能是還原了不含截圖的備份）</span>';
    for (const i of its) {
      const el = app.querySelector('img[data-crop="' + i.id + '"]');
      const im = ims.find((x) => x.id === i.source.imageId);
      if (el && im) { const u = await cropLine(im.blob, i.source.rect); if (u) { el.src = u; el.hidden = false; } }
    }
  }

  // ---------- 修改單一商品列 ----------
  function viewItem(id) {
    const i = S.items.find((x) => x.id === id);
    if (!i) return topbar('修改商品列') + '<main><p>找不到這一列。</p></main>';
    if (!S.itemEdit || S.itemEdit.id !== id) S.itemEdit = JSON.parse(JSON.stringify(i));
    const t = S.tById[i.txnId] || {};
    return topbar('修改商品列') + '<main><p class="small muted">' + esc(t.store || '') + '・' + esc(dateLabel(t)) + '・第 ' + i.lineNo + ' 列</p>' +
      itemEditor(S.itemEdit, 0, 'ie') +
      '<p class="small muted">原始 OCR 文字不會被修改：' + esc(i.ocrText || '（手動輸入）') + '</p>' +
      '<div class="row"><button class="btn primary" data-act="saveItem" data-id="' + id + '">保存修改</button><button class="btn" data-act="back">取消</button></div></main>';
  }

  function diffFields(before, after, fields) {
    const ch = [];
    for (const f of fields) {
      const a = before[f] == null || before[f] === '' ? null : before[f];
      const b = after[f] == null || after[f] === '' ? null : after[f];
      if (a !== b) ch.push({ field: f, from: a, to: b });
    }
    return ch;
  }
  const show = (v) => (v == null ? '（空白）' : v === true ? '是' : v === false ? '否' : String(v));

  async function saveItem(id) {
    const i = S.items.find((x) => x.id === id);
    const e = S.itemEdit;
    for (const f of ITEM_FIELDS) if (NUM_FIELDS.has(f) && Number.isNaN(e[f])) { toast(FIELD_LABELS[f] + '不是數字'); return; }
    if (!String(e.rawName || '').trim()) { toast('商品名稱不能空白'); return; }
    const ch = diffFields(i, e, ITEM_FIELDS.concat(['priceUnclear']));
    const resolvedNow = (i.flags || []).filter((f) => !f.resolved).length - (e.flags || []).filter((f) => !f.resolved).length;
    if (!ch.length && !resolvedNow) { toast('沒有變更'); go('txn', i.txnId); return; }
    const updated = Object.assign({}, i);
    ITEM_FIELDS.concat(['priceUnclear']).forEach((f) => { updated[f] = e[f] === '' ? null : e[f]; });
    updated.rawName = String(updated.rawName).trim();
    updated.flags = (e.flags || []).filter((f) => !f.resolved && !ch.some((c) => c.field === f.field)).map((f) => ({ field: f.field, reason: f.reason }));
    const summary = ch.map((c) => (FIELD_LABELS[c.field] || c.field) + ' ' + show(c.from) + ' → ' + show(c.to)).join('；') || '確認待確認欄位';
    updated.editLog = (i.editLog || []).concat([{ at: nowISO(), summary, changes: ch }]);
    updated.updatedAt = nowISO();
    const ops = { put: { items: [updated], products: [] }, del: { products: [] } };
    if (ch.some((c) => KEY_FIELDS.includes(c.field)) && !updated.isPromo) {
      const oldPid = updated.productId;
      updated.productId = null;
      const others = S.products.filter((p) => p.id !== oldPid || S.items.some((x) => x.productId === oldPid && x.id !== id));
      ops.put.products = assignProducts([updated], others, updated.isMock);
      if (oldPid && !S.items.some((x) => x.productId === oldPid && x.id !== id) && updated.productId !== oldPid) ops.del.products.push(oldPid);
    }
    await DB.write(ops);
    S.itemEdit = null;
    await loadAll();
    toast('已更新：' + summary, 4000);
    go('txn', i.txnId);
  }

  async function deleteItem(id) {
    const i = S.items.find((x) => x.id === id);
    if (!i) return;
    const ops = { del: { items: [id], products: [] } };
    if (i.productId && !S.items.some((x) => x.productId === i.productId && x.id !== id)) ops.del.products.push(i.productId);
    await DB.write(ops);
    await loadAll();
    toast('已刪除「' + i.rawName + '」這一列');
    render();
  }

  async function deleteTxn(id) {
    const its = S.items.filter((i) => i.txnId === id);
    const ids = new Set(its.map((i) => i.id));
    const orphan = Array.from(new Set(its.map((i) => i.productId).filter(Boolean))).filter((pid) => !S.items.some((x) => x.productId === pid && !ids.has(x.id)));
    const ims = await DB.byIndex('images', 'txnId', id).catch(() => []);
    await DB.write({ del: { transactions: [id], items: Array.from(ids), images: ims.map((x) => x.id), products: orphan } });
    await loadAll();
    toast('已刪除這筆交易');
    go('txns');
  }

  async function saveTxn(id) {
    const t = S.tById[id];
    const e = S.txnEdit;
    for (const f of TXN_FIELDS) if (NUM_FIELDS.has(f) && Number.isNaN(e[f])) { toast(FIELD_LABELS[f] + '不是數字'); return; }
    const ch = diffFields(t, e, TXN_FIELDS);
    if (!ch.length) { S.editTxn = null; render(); return; }
    const u = Object.assign({}, t);
    TXN_FIELDS.forEach((f) => { u[f] = e[f] === '' ? null : e[f]; });
    u.fieldFlags = Object.assign({}, t.fieldFlags);
    ch.forEach((c) => { delete u.fieldFlags[c.field]; });
    const summary = ch.map((c) => FIELD_LABELS[c.field] + ' ' + show(c.from) + ' → ' + show(c.to)).join('；');
    u.editLog = (t.editLog || []).concat([{ at: nowISO(), summary, changes: ch }]);
    u.updatedAt = nowISO();
    u.fingerprint = L.txnFingerprint(u, S.items.filter((i) => i.txnId === id));
    await DB.write({ put: { transactions: [u] } });
    S.editTxn = null;
    await loadAll();
    toast('已更新：' + summary, 4000);
    render();
  }

  // =====================================================================
  // 商品與價格變化
  // =====================================================================
  function viewChanges() {
    const f = S.filter;
    const q = L.normalizeText(f.q);
    let hs = histories(f.mode);
    if (q) hs = hs.filter(({ product }) => L.normalizeText(product.name).includes(q) || (product.aliases || []).some((a) => L.normalizeText(a).includes(q)));
    if (f.from) hs = hs.filter(({ h }) => h.latest && h.latest.txn.date >= f.from);
    if (f.to) hs = hs.filter(({ h }) => h.latest && h.latest.txn.date <= f.to);
    const counts = { all: hs.length, up: 0, down: 0, same: 0, na: 0 };
    hs.forEach(({ h }) => { counts[h.status]++; });
    if (f.changes !== 'all') hs = hs.filter(({ h }) => h.status === f.changes);
    const order = { up: 0, down: 1, same: 2, na: 3 };
    hs.sort((a, b) => order[a.h.status] - order[b.h.status] || Math.abs(b.h.cmp.pct || 0) - Math.abs(a.h.cmp.pct || 0));
    const chip = (k, label) => '<button class="chip' + (f.changes === k ? ' on' : '') + '" data-act="setFilter" data-k="changes" data-v="' + k + '">' + label + '（' + counts[k] + '）</button>';
    const rows = hs.map(({ product: p, h }) => {
      const cur = h.latest, prev = h.previous;
      return '<button class="li" data-act="nav" data-to="product" data-id="' + p.id + '"><div class="spread"><span class="title">' + esc(p.name) + (p.spec ? ' <span class="muted small">' + esc(p.spec) + '</span>' : '') + ' ' + mockBadge(p) + '</span>' + cmpBadge(h.cmp) + '</div>' +
        '<div class="pair"><div><div class="lbl">上次 ' + esc(prev ? prev.txn.date : '—') + '</div><div class="val">' + money(prev && prev.price) + '</div></div>' +
        '<div><div class="lbl">本次 ' + esc(cur ? cur.txn.date : '—') + '</div><div class="val">' + money(cur && cur.price) + '</div></div></div>' +
        sparkline(h) +
        '<div class="meta">差額 ' + signed(h.cmp.diff) + '・歷史最低 ' + money(h.min) + '・最高 ' + money(h.max) + '・購買 ' + h.count + ' 次（有效 ' + h.validCount + '）</div></button>';
    }).join('');
    return topbar('商品價格變化') + '<main>' + searchBar(true) +
      '<div class="chips">' + chip('all', '全部') + chip('up', '上漲') + chip('down', '下降') + chip('same', '不變') + chip('na', '無法比較') + '</div>' +
      modeSwitch() + changeChart(hs) +
      '<div class="list">' + (rows || '<p class="muted">沒有符合的商品。</p>') + '</div></main>';
  }
  /*
   * 漲跌幅度一覽：以 0% 為中線，上漲往右（紅）、下降往左（綠），長度＝漲跌百分比。
   * 方向同時用左右位置與 ▲▼ 文字表示，不只靠顏色。點一列進入該商品頁。
   */
  function changeChart(hs) {
    const list = hs.filter(({ h }) => h.status === 'up' || h.status === 'down')
      .sort((a, b) => b.h.cmp.pct - a.h.cmp.pct);
    if (!list.length) return '';
    const max = Math.max.apply(null, list.map(({ h }) => Math.abs(h.cmp.pct)));
    const same = hs.filter(({ h }) => h.status === 'same').length;
    const rows = list.map(({ product: p, h }) => {
      const up = h.cmp.pct > 0;
      const w = Math.max(2, (Math.abs(h.cmp.pct) / max) * 45).toFixed(1); // 留一半以上給數值文字，手機也不會超出
      const label = (up ? '▲ +' : '▼ ') + h.cmp.pct + '%';
      const tip = p.name + '：' + money(h.previous.price) + ' → ' + money(h.latest.price) + '（' + signed(h.cmp.diff) + '，' + (up ? '+' : '') + h.cmp.pct + '%）';
      return '<button class="cc-row" data-act="nav" data-to="product" data-id="' + p.id + '" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
        '<span class="cc-name">' + esc(p.name) + '</span>' +
        '<span class="cc-half neg">' + (up ? '' : '<i class="cc-bar down" style="width:' + w + '%"></i><em class="cc-val">' + label + '</em>') + '</span>' +
        '<span class="cc-half pos">' + (up ? '<i class="cc-bar up" style="width:' + w + '%"></i><em class="cc-val">' + label + '</em>' : '') + '</span></button>';
    }).join('');
    return '<section class="card cc"><div class="spread"><h2>漲跌幅度一覽</h2><span class="small muted">點商品看走勢</span></div>' +
      '<div class="cc-axis"><span></span><span class="small muted">◀ 下降</span><span class="small muted">上漲 ▶</span></div>' +
      '<div class="cc-rows">' + rows + '</div>' +
      '<p class="small muted">長度代表漲跌百分比（' + (S.filter.mode === 'list' ? '原價單價' : '每件實付均價') + '，最近一次 vs 前一次）。' + (same ? '另有 ' + same + ' 項價格不變。' : '') + '</p></section>';
  }

  // 卡片裡的小走勢線：每次有效購買的價格，最後一點用漲跌顏色標示
  function sparkline(h) {
    const pts = h.rows.filter((r) => r.price != null);
    if (pts.length < 2) return '';
    const W = 300, H = 40, pad = 5;
    let lo = Math.min.apply(null, pts.map((r) => r.price)), hi = Math.max.apply(null, pts.map((r) => r.price));
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    const d = pts.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(r.price).toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    // 線條隨卡片寬度拉伸；圓點用 HTML 疊上去，才不會被拉成橢圓
    return '<div class="spark" role="img" aria-label="價格走勢：' + esc(pts.map((r) => r.txn.date + ' ' + money(r.price)).join('、')) + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><path d="' + d + '" vector-effect="non-scaling-stroke"/></svg>' +
      pts.map((r, i) => '<i class="' + (i === pts.length - 1 ? 'last ' + h.status : '') + '" style="left:' + (x(i) / W * 100).toFixed(2) + '%;top:' + y(r.price).toFixed(1) + 'px"></i>').join('') +
      '</div><div class="spark-lbl small muted"><span>' + esc(pts[0].txn.date) + ' ' + money(pts[0].price) + '</span><span>' + pts.length + ' 次</span><span>' + esc(last.txn.date) + ' ' + money(last.price) + '</span></div>';
  }

  function modeSwitch() {
    return '<div class="chips"><button class="chip' + (S.filter.mode === 'paid' ? ' on' : '') + '" data-act="setFilter" data-k="mode" data-v="paid">比較每件實付均價</button>' +
      '<button class="chip' + (S.filter.mode === 'list' ? ' on' : '') + '" data-act="setFilter" data-k="mode" data-v="list">比較原價單價</button></div>' +
      '<p class="small muted">' + (S.filter.mode === 'paid' ? '每件實付均價 ＝ 金額 ÷ 數量。有折扣時是折扣後的價格。' : '原價只在截圖有顯示單價或原價時才有；全聯明細通常沒有，所以多半會顯示「無法比較」。') + '</p>';
  }

  function viewProducts() {
    const q = L.normalizeText(S.filter.q);
    let ps = S.products.filter(vis);
    if (q) ps = ps.filter((p) => L.normalizeText(p.name).includes(q) || (p.aliases || []).some((a) => L.normalizeText(a).includes(q)) || (p.barcode || '').includes(q));
    ps.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const rows = ps.map((p) => {
      const h = L.productHistory(p, S.items, S.tById, 'paid');
      return '<button class="li" data-act="nav" data-to="product" data-id="' + p.id + '"><div class="spread"><span class="title">' + esc(p.name) + (p.spec ? ' <span class="muted small">' + esc(p.spec) + '</span>' : '') + ' ' + mockBadge(p) + '</span>' +
        '<span class="num">' + (h.latest ? 'NT$ ' + money(h.latest.price) : '—') + '</span></div>' +
        '<div class="meta">購買 ' + h.count + ' 次' + (h.latest ? '・最近 ' + esc(h.latest.txn.date) : '') + ((p.aliases || []).length > 1 ? '・' + p.aliases.length + ' 種原始名稱' : '') + '</div></button>';
    }).join('');
    return topbar('所有商品') + '<main>' + searchBar(false) + '<p class="small muted">' + ps.length + ' 項商品</p><div class="list">' + (rows || '<p class="muted">還沒有商品。</p>') + '</div></main>';
  }

  function viewProduct(id) {
    const p = S.pById[id];
    if (!p) return topbar('商品') + '<main><p>找不到這個商品。</p></main>';
    const h = L.productHistory(p, S.items, S.tById, S.filter.mode);
    const editing = S.editProduct === id;
    const pe = S.productEdit || p;
    const per = h.rows.some((r) => r.per100 != null);
    const rows = h.rows.slice().reverse().map((r) => '<tr><td>' + esc(r.txn.date || '未填') + '</td><td>' + esc(r.item.rawName) + '</td><td class="n">' + esc(r.item.qty == null ? '—' : r.item.qty) + '</td>' +
      '<td class="n">' + money(r.item.paidAmount) + '</td><td class="n">' + money(r.item.discount) + '</td><td class="n"><b>' + money(r.price) + '</b></td>' + (per ? '<td class="n">' + money(r.per100) + '</td>' : '') +
      '<td>' + (r.price == null ? '<span class="badge na">' + esc(r.reason || '無法比較') + '</span>' : r.prev ? cmpBadge(r.cmp) : '<span class="badge na">第一筆</span>') + '</td>' +
      '<td><a href="#txn-' + r.item.txnId + '" data-act="nav" data-to="txn" data-id="' + r.item.txnId + '">' + esc(r.txn.store || '交易') + '</a></td></tr>').join('');
    const others = S.products.filter((x) => x.id !== id && !!x.isMock === !!p.isMock).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const edit = editing
      ? '<section class="card"><h2>修改商品資料</h2><div class="grid2">' +
        ['name', 'brand', 'spec', 'barcode', 'note'].map((f) => '<label class="field"><span>' + FIELD_LABELS[f] + '</span><input id="pe-' + f + '" value="' + esc(pe[f] == null ? '' : pe[f]) + '" data-bind="pe.' + f + '"></label>').join('') +
        '</div><p class="small muted">只改統一管理用的資料；每筆交易的原始名稱不會被改寫。</p>' +
        '<div class="row"><button class="btn primary" data-act="saveProduct" data-id="' + id + '">保存</button><button class="btn" data-act="cancelProductEdit">取消</button></div></section>'
      : '';
    return topbar('商品價格歷史') + '<main>' +
      '<section class="card"><div class="spread"><h2>' + esc(p.name) + '</h2>' + mockBadge(p) + '</div>' +
      '<dl class="kv"><dt>規格</dt><dd>' + esc(p.spec || '（空白）') + '</dd><dt>品牌</dt><dd>' + esc(p.brand || '（空白）') + '</dd><dt>條碼</dt><dd>' + esc(p.barcode || '（空白）') + '</dd>' +
      '<dt>原始名稱</dt><dd>' + (p.aliases || []).map(esc).join('、') + '</dd></dl>' +
      (p.note ? '<p class="small">' + esc(p.note) + '</p>' : '') +
      '<div class="pair"><div><div class="lbl">上次 ' + esc(h.previous ? h.previous.txn.date : '—') + '</div><div class="val">' + money(h.previous && h.previous.price) + '</div></div>' +
      '<div><div class="lbl">本次 ' + esc(h.latest ? h.latest.txn.date : '—') + '</div><div class="val">' + money(h.latest && h.latest.price) + '</div></div></div>' +
      '<div class="row">' + cmpBadge(h.cmp) + (h.cmp.note ? '<span class="badge warn">' + esc(h.cmp.note) + '</span>' : '') + '</div>' +
      '<dl class="kv"><dt>價格差額</dt><dd>' + signed(h.cmp.diff) + '</dd><dt>漲跌百分比</dt><dd>' + (h.cmp.pct == null ? '無法比較' : (h.cmp.pct > 0 ? '+' : '') + h.cmp.pct + '%') + '</dd>' +
      '<dt>歷史最低價</dt><dd>' + money(h.min) + '</dd><dt>歷史最高價</dt><dd>' + money(h.max) + '</dd><dt>歷史購買次數</dt><dd>' + h.count + '（有效 ' + h.validCount + '）</dd></dl>' +
      (!editing ? '<div class="row"><button class="btn small" data-act="editProduct" data-id="' + id + '">修改統一名稱／規格</button></div>' : '') + '</section>' + edit +
      modeSwitch() +
      '<section class="card"><h2>價格走勢（每件' + (S.filter.mode === 'paid' ? '實付均價' : '原價') + '）</h2><div id="chart"></div></section>' +
      '<section class="stack"><h2>歷史價格表</h2><div class="tablewrap"><table><thead><tr><th>日期</th><th>原始名稱</th><th class="n">數量</th><th class="n">金額</th><th class="n">折扣</th><th class="n">每件</th>' + (per ? '<th class="n">' + esc(h.rows[0].per100Unit) + '</th>' : '') + '<th>與上次比</th><th>來源</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
      '<section class="card flat"><h2>合併到另一個商品</h2><p class="small muted">確定兩者是同一商品時使用。規格不同的商品不能合併。</p>' +
      '<select id="mergeTarget"><option value="">選擇要併入的商品…</option>' + others.map((o) => '<option value="' + o.id + '">' + esc(o.name + (o.spec ? ' ' + o.spec : '')) + '</option>').join('') + '</select>' +
      '<div><button class="btn small" data-act="mergeProduct" data-id="' + id + '">合併</button></div></section>' +
      '</main>';
  }

  function drawLater() {
    const p = S.pById[S.route.param];
    const box = document.getElementById('chart');
    if (!p || !box) return;
    const h = L.productHistory(p, S.items, S.tById, S.filter.mode);
    const pts = h.rows.filter((r) => r.price != null);
    if (pts.length < 2) { box.innerHTML = '<p class="small muted">至少要有兩次有效購買紀錄才能畫走勢。</p>'; return; }
    const W = 340, H = 180, padL = 44, padR = 14, padT = 14, padB = 30;
    const ts = pts.map((r) => new Date(r.txn.date + 'T00:00:00').getTime());
    const t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    let lo = Math.min.apply(null, pts.map((r) => r.price)), hi = Math.max.apply(null, pts.map((r) => r.price));
    if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
    const x = (t) => padL + (t1 === t0 ? (W - padL - padR) / 2 : ((t - t0) / (t1 - t0)) * (W - padL - padR));
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const line = pts.map((r, i) => (i ? 'L' : 'M') + x(ts[i]).toFixed(1) + ' ' + y(r.price).toFixed(1)).join(' ');
    const area = line + ' L' + x(ts[ts.length - 1]).toFixed(1) + ' ' + (H - padB) + ' L' + x(ts[0]).toFixed(1) + ' ' + (H - padB) + ' Z';
    const ticks = [lo, (lo + hi) / 2, hi];
    box.innerHTML = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="價格走勢">' +
      ticks.map((v) => '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + money(v) + '</text>').join('') +
      '<path class="area" d="' + area + '"/><path class="linep" d="' + line + '"/>' +
      pts.map((r, i) => '<circle class="dot' + (i === pts.length - 1 ? ' last' : '') + '" cx="' + x(ts[i]) + '" cy="' + y(r.price) + '" r="4"><title>' + r.txn.date + '：' + money(r.price) + '</title></circle>').join('') +
      '<text x="' + padL + '" y="' + (H - 8) + '">' + pts[0].txn.date + '</text><text x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end">' + pts[pts.length - 1].txn.date + '</text></svg>';
  }

  async function saveProduct(id) {
    const p = S.pById[id], e = S.productEdit;
    if (!String(e.name || '').trim()) { toast('統一商品名稱不能空白'); return; }
    const u = Object.assign({}, p);
    ['name', 'brand', 'spec', 'barcode', 'note'].forEach((f) => { u[f] = e[f] === '' ? null : (typeof e[f] === 'string' ? e[f].trim() : e[f]); });
    u.updatedAt = nowISO();
    await DB.write({ put: { products: [u] } });
    S.editProduct = null; S.productEdit = null;
    await loadAll();
    toast('商品資料已更新');
    render();
  }

  async function mergeProduct(fromId, toId) {
    const a = S.pById[fromId], b = S.pById[toId];
    if (!a || !b) { toast('請先選擇要併入的商品'); return; }
    const sa = L.specKey(a.spec), sb = L.specKey(b.spec);
    if (sa && sb && sa !== sb) { toast('規格不同（' + a.spec + ' / ' + b.spec + '），不能合併', 4000); return; }
    const its = S.items.filter((i) => i.productId === fromId).map((i) => Object.assign({}, i, { productId: toId, matchStatus: 'manual',
      editLog: (i.editLog || []).concat([{ at: nowISO(), summary: '商品由「' + a.name + '」合併到「' + b.name + '」' }]) }));
    const u = Object.assign({}, b, { keys: Array.from(new Set(b.keys.concat(a.keys))), aliases: Array.from(new Set(b.aliases.concat(a.aliases))), updatedAt: nowISO() });
    if (!u.spec && a.spec) u.spec = a.spec;
    if (!u.barcode && a.barcode) u.barcode = a.barcode;
    await DB.write({ put: { items: its, products: [u] }, del: { products: [fromId] } });
    await loadAll();
    toast('已合併到「' + b.name + '」');
    go('product', toId);
  }

  // =====================================================================
  // 待確認
  // =====================================================================
  function viewReview() {
    const pend = pendingInfo();
    const matchCards = pend.match.map((i) => {
      const t = S.tById[i.txnId] || {};
      const cands = (i.candidateIds || []).map((id) => S.pById[id]).filter(Boolean);
      const others = S.products.filter((p) => !!p.isMock === !!i.isMock && !cands.includes(p)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
      return '<div class="card"><div class="spread"><h3>' + esc(i.rawName) + (i.spec ? ' <span class="muted small">' + esc(i.spec) + '</span>' : '') + '</h3>' +
        (i.matchStatus === 'deferred' ? '<span class="badge na">暫時不處理</span>' : '<span class="badge warn">待確認</span>') + '</div>' +
        '<p class="small muted">' + esc(t.store || '') + '・' + esc(dateLabel(t)) + '・金額 ' + money(i.paidAmount) + '</p>' +
        (cands.length ? '<p class="small">名稱相似的已知商品：</p>' + cands.map((p) => '<div class="spread"><span>' + esc(p.name) + (p.spec ? ' ' + esc(p.spec) : '') + '</span>' +
          '<button class="btn small" data-act="sameProduct" data-id="' + i.id + '" data-p="' + p.id + '">是同一商品</button></div>').join('') : '') +
        (others.length ? '<details><summary class="small">從所有商品中選</summary><div class="row"><select id="pick-' + i.id + '"><option value="">選擇商品…</option>' +
          others.map((p) => '<option value="' + p.id + '">' + esc(p.name + (p.spec ? ' ' + p.spec : '')) + '</option>').join('') + '</select>' +
          '<button class="btn small" data-act="samePicked" data-id="' + i.id + '">是同一商品</button></div></details>' : '') +
        '<div class="row"><button class="btn small" data-act="diffProduct" data-id="' + i.id + '">是不同商品</button>' +
        (i.matchStatus !== 'deferred' ? '<button class="btn small" data-act="deferProduct" data-id="' + i.id + '">暫時不處理</button>' : '') + '</div></div>';
    }).join('');
    const flagCards = pend.flagged.map((i) => {
      const t = S.tById[i.txnId] || {};
      return '<button class="li" data-act="nav" data-to="txn" data-id="' + i.txnId + '"><span class="title">' + esc(i.rawName) + '</span><span class="meta">' + esc(dateLabel(t)) + '・' +
        openFlags(i).map((f) => esc((FIELD_LABELS[f.field] || f.field) + '：' + f.reason)).join('；') + '</span></button>';
    }).join('');
    const dateCards = pend.noDate.map((t) => '<div class="card"><div class="spread"><h3>' + esc(t.store || '未填門市') + '</h3>' + mockBadge(t) + '</div>' +
      '<p class="small muted">匯入於 ' + esc(fmtTime(t.importedAt)) + '・NT$ ' + money(t.spendTotal != null ? t.spendTotal : t.paymentTotal) + '</p>' +
      '<div class="row"><input type="date" id="nd-' + t.id + '" aria-label="消費日期"><button class="btn small" data-act="setDate" data-id="' + t.id + '">填入日期</button>' +
      '<button class="btn small" data-act="nav" data-to="txn" data-id="' + t.id + '">看明細</button></div></div>').join('');
    const txnFlagCards = pend.txnFlags.map((t) => '<button class="li" data-act="nav" data-to="txn" data-id="' + t.id + '"><span class="title">' + esc(dateLabel(t)) + '・' + esc(t.store || '') + '</span><span class="meta">' +
      openFieldFlags(t).map(([f, v]) => esc((FIELD_LABELS[f] || f) + '：' + flagText(v))).join('；') + '</span></button>').join('');
    return topbar('待確認') + '<main>' +
      (pend.total ? '' : '<div class="notice ok">目前沒有待確認的項目。</div>') +
      (matchCards ? '<section class="stack"><h2>是不是同一商品？（' + pend.match.length + '）</h2>' + matchCards + '</section>' : '') +
      (flagCards ? '<section class="stack"><h2>OCR 不確定的數字或名稱（' + pend.flagged.length + '）</h2><p class="small muted">這些列暫時不拿來比價，點進去修改或確認。</p><div class="list">' + flagCards + '</div></section>' : '') +
      (dateCards ? '<section class="stack"><h2>缺少消費日期（' + pend.noDate.length + '）</h2><p class="small muted">沒有日期就無法判斷先後，不會拿來比價。</p>' + dateCards + '</section>' : '') +
      (txnFlagCards ? '<section class="stack"><h2>交易資料待確認（' + pend.txnFlags.length + '）</h2><div class="list">' + txnFlagCards + '</div></section>' : '') +
      '</main>';
  }

  async function resolveMatch(itemId, how, pid) {
    const i = S.items.find((x) => x.id === itemId);
    if (!i) return;
    const u = Object.assign({}, i);
    const ops = { put: { items: [u], products: [] } };
    const now = nowISO();
    if (how === 'same') {
      const p = S.pById[pid];
      if (!p) { toast('請先選擇商品'); return; }
      if (specConflict(i, p)) { toast('規格不同（' + (L.effectiveSpec(i) || '') + ' / ' + p.spec + '），依規則不能當成同一商品', 4500); return; }
      const pu = Object.assign({}, p, { keys: p.keys.slice(), aliases: p.aliases.slice() });
      addAlias(pu, i);
      u.productId = p.id; u.matchStatus = 'manual';
      u.editLog = (i.editLog || []).concat([{ at: now, summary: '確認為同一商品：「' + p.name + '」' }]);
      ops.put.products.push(pu);
    } else if (how === 'diff') {
      const p = newProduct(i, i.isMock);
      const key = L.productKey(i);
      for (const cid of i.candidateIds || []) {
        const c = S.pById[cid];
        if (c) ops.put.products.push(Object.assign({}, c, { notSame: Array.from(new Set((c.notSame || []).concat([key]))) }));
      }
      ops.put.products.push(p);
      u.productId = p.id; u.matchStatus = 'manual-new';
      u.editLog = (i.editLog || []).concat([{ at: now, summary: '確認為不同商品，另建新商品' }]);
    } else {
      u.matchStatus = 'deferred';
    }
    u.updatedAt = now;
    await DB.write(ops);
    await loadAll();
    toast(how === 'same' ? '已歸入同一商品' : how === 'diff' ? '已建立為新商品' : '已標記為暫時不處理');
    render();
  }

  // =====================================================================
  // 備份、還原、CSV
  // =====================================================================
  function viewBackup() {
    const r = S.restore;
    const mockN = S.txns.filter((t) => t.isMock).length;
    const realN = S.txns.length - mockN;
    const restoreCard = r
      ? '<section class="card" id="restore" style="border:2px solid var(--accent)"><h2>還原預覽：請選擇下面其中一個按鈕</h2><p class="small">備份時間：' + esc(fmtTime(r.obj.exportedAt)) + '<br>交易 ' + r.obj.data.transactions.length + ' 筆、商品明細 ' + r.obj.data.items.length + ' 列、商品 ' + r.obj.data.products.length + ' 項、截圖 ' + (r.obj.data.images || []).length + ' 張</p>' +
        (r.obj.data.transactions.length
          ? '<div class="stack"><button class="btn" data-act="doRestore" data-mode="merge">合併（保留現有資料，只加入沒有的）</button>' +
            '<button class="btn danger" data-act="doRestore" data-mode="replace">取代（先清空目前全部資料）</button><button class="btn" data-act="cancelRestore">取消</button></div></section>'
          // 空的備份檔還原了也不會有資料，用「取代」還會清掉現有資料，所以直接擋下
          : '<div class="notice bad">這個備份檔是空的（0 筆交易），可能是在還沒有資料的瀏覽器裡匯出的。請改選有資料的備份檔。</div>' +
            '<div class="stack"><button class="btn" data-act="cancelRestore">改選其他檔案</button></div></section>')
      : '<section class="card" id="restore"><h2>還原備份</h2><p class="small muted">選擇先前匯出的 .json 備份檔。選好後會先顯示內容，確認後才寫入。</p>' +
        '<label class="btn block" for="restoreFile" style="justify-content:center">選擇備份檔</label><input id="restoreFile" type="file" hidden data-act="restoreFile"></section>';
    return topbar('備份與資料') + '<main>' + (r ? restoreCard : '') +
      '<section class="card"><h2>資料保存在哪裡</h2><div class="prose small">' +
      '<p>所有資料（交易、商品、截圖）只存在<b>這支手機的這個瀏覽器</b>裡（IndexedDB），沒有雲端同步，也不會上傳。</p>' +
      '<ul><li>清除 Safari「網站資料」或「瀏覽記錄與網站資料」會刪掉全部紀錄。</li><li>換手機、換瀏覽器、用無痕模式，都看不到原本的資料。</li>' +
      '<li>iPhone Safari 對很久沒開啟的網站，可能會自動清掉資料。加到主畫面並定期開啟可降低風險。</li><li>所以請定期按下方「匯出 JSON 備份」，把檔案存到「檔案」App 或 iCloud 雲碟。</li></ul>' +
      '<p id="storageInfo" class="muted">讀取儲存空間資訊…</p><div><button class="btn small" data-act="persist">請瀏覽器保留資料</button></div></div></section>' +
      '<section class="card"><h2>匯出</h2><p class="small">目前：真實交易 ' + realN + ' 筆、模擬交易 ' + mockN + ' 筆。上次備份：' + esc(S.lastBackupAt ? fmtTime(S.lastBackupAt) : '從未備份') + '</p>' +
      '<div class="stack"><button class="btn primary" data-act="exportJson" data-img="1">匯出 JSON 備份（含截圖，可完整還原）</button>' +
      '<button class="btn" data-act="exportJson" data-img="0">匯出 JSON 備份（不含截圖，檔案較小）</button>' +
      '<button class="btn" data-act="exportCsv">匯出 CSV（可用 Excel／Numbers 開啟）</button></div>' +
      '<p class="small muted">CSV 只用來查看與分析，無法用來還原。還原請用 JSON。</p></section>' +
      (r ? '' : restoreCard) +
      '<section class="card flat"><h2>模擬資料</h2><p class="small muted">用來試用與驗收的假資料，門市名稱為「【模擬】測試門市」，和真實資料分開比對。</p>' +
      '<div class="row"><button class="btn" data-act="loadMock">載入模擬資料</button><button class="btn danger" data-act="clearMock">刪除所有模擬資料</button></div></section>' +
      '<section class="card flat"><h2>刪除全部資料</h2><p class="small muted">無法復原，請先匯出備份。</p><div><button class="btn danger" data-act="wipeAll">刪除全部資料</button></div></section>' +
      '</main>';
  }

  async function fillStorageInfo() {
    const el = document.getElementById('storageInfo');
    if (!el) return;
    const i = await DB.storageInfo();
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    el.textContent = (i.usage != null ? '已使用約 ' + mb(i.usage) + (i.quota ? '，可用上限約 ' + mb(i.quota) : '') + '。' : '') +
      (i.persisted === true ? '瀏覽器已同意保留資料。' : i.persisted === false ? '瀏覽器尚未承諾保留資料（空間不足或久未使用時可能被清除）。' : '');
  }

  async function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }
  function dataURLToBlob(u) {
    const m = String(u).match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!m) return null;
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] || 'application/octet-stream' });
  }
  function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }

  // 讓使用者把檔案存下來：在 claude.ai 內用平台的下載功能，其他地方用一般下載
  async function saveFile(filename, data, mime) {
    if (window.claude && typeof window.claude.use === 'function') {
      try {
        const dl = await window.claude.use('downloads');
        if (dl) { await dl.save({ filename, data }); return true; }
      } catch (e) {
        if (e && e.code === 'declined') { toast('已取消下載'); return false; }
      }
    }
    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
      return true;
    } catch (e) { toast('無法下載：' + e.message, 4000); return false; }
  }

  async function exportJson(withImages) {
    toast('正在準備備份檔…');
    const [txns, items, products, images] = await Promise.all(['transactions', 'items', 'products', 'images'].map((s) => DB.getAll(s)));
    const imgs = [];
    if (withImages) for (const im of images) imgs.push({ id: im.id, txnId: im.txnId, name: im.name, type: im.type, hash: im.hash, importedAt: im.importedAt, isMock: im.isMock, dataUrl: await blobToDataURL(im.blob) });
    const obj = { app: 'px-ghost', version: 1, exportedAt: nowISO(), includesImages: !!withImages,
      note: '全聯消費明細抓鬼系統備份。isMock=true 的資料為模擬資料。', data: { transactions: txns, items, products, images: imgs } };
    const ok = await saveFile('px-ghost-backup-' + stamp() + '.json', JSON.stringify(obj), 'application/json');
    if (ok) { await DB.setMeta('lastBackupAt', nowISO()); S.lastBackupAt = nowISO(); toast('備份檔已產生，請存到「檔案」App 或雲端'); render(); }
  }
  async function exportCsv() {
    const csv = L.toCSV(S.txns, S.items, S.products);
    await saveFile('px-ghost-items-' + stamp() + '.csv', csv, 'text/csv');
  }

  async function readRestoreFile(file) {
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      const err = L.validateBackup(obj);
      if (err) { toast('無法還原：' + err, 4500); return; }
      S.restore = { obj };
      render();
      // 預覽放在頁面最上方並捲過去，避免選完檔案後看不到下一步
      window.scrollTo(0, 0);
      if (obj.data.transactions.length) toast('已讀取備份（' + obj.data.transactions.length + ' 筆交易），請選擇「合併」或「取代」', 5000);
    } catch (e) { toast('這個檔案不是抓鬼系統的 JSON 備份檔（' + e.message + '）', 5000); }
  }
  async function doRestore(mode) {
    try { await restoreData(mode); } catch (e) {
      console.error(e);
      toast('還原失敗：' + (e.message || e) + '。目前資料沒有變動，請再試一次。', 6000);
    }
  }
  async function restoreData(mode) {
    toast('正在還原，請稍候…', 8000);
    const d = S.restore.obj.data;
    const images = (d.images || []).map((im) => ({ id: im.id, txnId: im.txnId, name: im.name, type: im.type, hash: im.hash, importedAt: im.importedAt, isMock: im.isMock, blob: dataURLToBlob(im.dataUrl) })).filter((x) => x.blob);
    let put, del;
    if (mode === 'replace') {
      // 刪除舊資料與寫入新資料放在同一個資料庫交易裡：寫入失敗時舊資料原封不動
      del = {};
      for (const st of ['transactions', 'items', 'products', 'images']) del[st] = (await DB.getAll(st)).map((x) => x.id);
      put = { transactions: d.transactions, items: d.items, products: d.products, images };
    } else {
      const has = (arr) => new Set(arr.map((x) => x.id));
      const ht = has(S.txns), hi = has(S.items), hp = has(S.products);
      const himg = new Set((await DB.getAll('images')).map((x) => x.id));
      put = { transactions: d.transactions.filter((x) => !ht.has(x.id)), items: d.items.filter((x) => !hi.has(x.id)), products: d.products.filter((x) => !hp.has(x.id)), images: images.filter((x) => !himg.has(x.id)) };
    }
    await DB.write({ put, del });
    S.restore = null;
    await loadAll();
    toast('還原完成：加入 ' + put.transactions.length + ' 筆交易、' + put.items.length + ' 列商品', 4000);
    go('home');
  }

  async function loadMock() {
    const list = PXMock.transactions();
    let added = 0; const skipped = [];
    for (const m of list) {
      const now = nowISO();
      const txnId = uid();
      const txn = Object.assign({ id: txnId, importedAt: now, updatedAt: now, editLog: [], imageIds: [] }, m.txn);
      txn.fieldFlags = {};
      for (const [f, v] of Object.entries(m.txn.fieldFlags || {})) txn.fieldFlags[f] = { reason: v, resolved: false };
      const items = m.items.map((it, i) => toItemRecord(it, txnId, i + 1, now, true));
      txn.fingerprint = L.txnFingerprint(txn, items);
      const dup = L.findDuplicateTxn(txn, items, S.txns);
      if (dup) { skipped.push(m.case + '（' + dup.why + '）'); continue; }
      const products = S.products.slice();
      const changed = assignProducts(items, products, true);
      await DB.write({ put: { transactions: [txn], items, products: changed } });
      await loadAll();
      added++;
    }
    S.showMock = true; lsSet('pxg.showMock', true);
    S.notice = '已載入 ' + added + ' 筆模擬交易。' + (skipped.length ? '防重複機制擋下：' + esc(skipped.join('、')) + '。' : '');
    toast('已載入模擬資料');
    go('home');
  }
  async function clearMock() {
    const t = S.txns.filter((x) => x.isMock).map((x) => x.id);
    const tset = new Set(t);
    const i = S.items.filter((x) => x.isMock || tset.has(x.txnId)).map((x) => x.id);
    const p = S.products.filter((x) => x.isMock).map((x) => x.id);
    const im = (await DB.getAll('images')).filter((x) => x.isMock || tset.has(x.txnId)).map((x) => x.id);
    await DB.write({ del: { transactions: t, items: i, products: p, images: im } });
    await loadAll();
    S.notice = null;
    toast('已刪除 ' + t.length + ' 筆模擬交易');
    render();
  }

  // =====================================================================
  // 說明
  // =====================================================================
  function viewHelp() {
    return topbar('使用說明') + '<main><section class="card prose"><h2>匯入全聯 App 截圖</h2><ol>' +
      '<li>打開全聯 App →（PX Pay）消費紀錄 → 點一筆交易，打開「消費明細」。</li>' +
      '<li>截圖。明細很長就往下捲，再截一張；上下兩張有重疊沒關係。建議第一張包含「交易日期」，最後一張包含「付款方式」。</li>' +
      '<li>回到本系統 →「匯入消費截圖」→ 從相簿一次選取這筆交易的所有截圖。</li>' +
      '<li>按「開始辨識」。第一次需下載約 12 MB 辨識模型。</li>' +
      '<li>核對：黃色欄位是 OCR 不確定的地方。每一列上方有原始截圖片段可對照。改完或確認無誤後按「確認並保存」。</li></ol></section>' +
      '<section class="card prose"><h2>價格怎麼算</h2><ul>' +
      '<li>全聯明細的「金額」是整列小計，不是單價。買 2 件 196 元，每件 98 元。</li>' +
      '<li>可比較價格＝每件實付均價＝金額 ÷ 數量。</li><li>價格差額＝本次 − 上次；漲跌百分比＝差額 ÷ 上次 × 100%。</li>' +
      '<li>缺日期、缺數量、金額為 0（例如印花贈品）、數字待確認、標示「價格口徑不明」的列，都顯示「無法比較」。</li>' +
      '<li>名稱一樣但規格不同（936ml 與 1836ml）一定分開；有容量時另外顯示每 100ml／100g 價格。</li>' +
      '<li>有整筆折扣（優惠活動折扣金額）時，系統不會自行分攤到商品，會標示提醒。</li></ul></section>' +
      '<section class="card prose"><h2>OCR 的限制</h2><ul>' +
      '<li>辨識在手機上進行（Tesseract 繁體中文模型），不需付費、不上傳。</li>' +
      '<li>實測全聯截圖：大部分商品名稱與數字可正確辨識；少數筆畫多的字（例如「萵苣」）或細的數字會認錯，系統會標示待確認。</li>' +
      '<li>系統會用「商品金額合計 − 折扣 ＝ 付款金額」交叉檢查，不一致時會提醒。</li>' +
      '<li>辨識失敗或環境不支援時，可以改用手動輸入。</li></ul></section>' +
      '<section class="card prose"><h2>資料安全</h2><p>資料只存在這個瀏覽器。請定期到「匯出資料與備份」匯出 JSON。換手機時，在新手機打開本系統 →「還原備份」選擇該檔案即可。</p>' +
      '<div><button class="btn" data-act="nav" data-to="backup">前往備份</button></div></section></main>';
  }

  const VIEWS = { home: viewHome, import: viewImport, txns: viewTxns, txn: viewTxn, item: viewItem, changes: viewChanges, products: viewProducts, product: viewProduct, review: viewReview, backup: viewBackup, help: viewHelp };

  // =====================================================================
  // 事件
  // =====================================================================
  function bindTarget(path) {
    const [scope, a, b] = path.split('.');
    if (scope === 't' && S.draft) return [S.draft.txn, a];
    if (scope === 'd' && S.draft) return [S.draft.items[+a], b];
    if (scope === 'e') return [S.txnEdit, a];
    if (scope === 'ie') return [S.itemEdit, b];
    if (scope === 'pe') return [S.productEdit, a];
    return [null, null];
  }

  app.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.filterInput) {
      S.filter[el.dataset.filterInput] = el.value;
      clearTimeout(S._ft);
      S._ft = setTimeout(() => {
        const id = el.id, pos = el.selectionStart;
        render();
        const n = document.getElementById(id);
        if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch (err) { /* date input */ } }
      }, 250);
      return;
    }
    if (!el.dataset.bind) return;
    const [obj, f] = bindTarget(el.dataset.bind);
    if (!obj) return;
    if (el.dataset.type === 'bool') obj[f] = el.checked;
    else if (NUM_FIELDS.has(f)) obj[f] = parseNum(el.value);
    else obj[f] = el.value.trim() === '' ? null : el.value;
  });

  // 使用者改了某個待確認欄位，就視為已人工確認
  app.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.act === 'files') { addFiles(Array.from(el.files || []), el.dataset.mode); el.value = ''; return; }
    if (el.dataset.act === 'restoreFile') { if (el.files[0]) readRestoreFile(el.files[0]); el.value = ''; return; }
    if (el.dataset.act === 'toggleMock') { S.showMock = el.checked; lsSet('pxg.showMock', el.checked); render(); return; }
    if (!el.dataset.bind) return;
    const [obj, f] = bindTarget(el.dataset.bind);
    if (!obj) return;
    if (obj.flags) obj.flags.forEach((fl) => { if (fl.field === f) fl.resolved = true; });
    if (obj.fieldFlags && obj.fieldFlags[f]) { if (typeof obj.fieldFlags[f] === 'object') obj.fieldFlags[f].resolved = true; else delete obj.fieldFlags[f]; }
    if (S.draft && el.dataset.bind.startsWith('d.')) { const it = S.draft.items[+el.dataset.bind.split('.')[1]]; if (it && it.overlap === undefined) it.overlap = false; }
    const y = window.scrollY;
    const id = el.id;
    if (S.route.name === 'import' || S.route.name === 'item' || S.route.name === 'txn') { render(); window.scrollTo(0, y); const n = document.getElementById(id); if (n && el.type !== 'checkbox') n.blur(); }
  });

  // 刪除類按鈕需要按兩次
  function armed(el) {
    if (el.dataset.armed === '1') return true;
    el.dataset.armed = '1'; el.classList.add('armed');
    const old = el.textContent; el.textContent = '再按一次確認（' + old.replace(/（.*$/, '') + '）';
    setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.classList.remove('armed'); el.textContent = old; } }, 8000);
    return false;
  }

  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const act = el.dataset.act;
    if (el.tagName === 'A') e.preventDefault();
    try {
      switch (act) {
        case 'nav':
          if (el.dataset.filter) S.filter.changes = el.dataset.filter;
          else if (el.dataset.to === 'changes') S.filter.changes = 'all';
          if (['changes', 'products', 'txns'].includes(el.dataset.to) && S.route.name !== el.dataset.to) { S.filter.q = ''; S.filter.from = ''; S.filter.to = ''; }
          if (el.dataset.to === 'home') S.notice = S.route.name === 'home' ? S.notice : null;
          go(el.dataset.to, el.dataset.id);
          if (el.dataset.focus) { const n = document.getElementById(el.dataset.focus); if (n) n.scrollIntoView(); }
          break;
        case 'back':
          if (history.length > 1) history.back(); else go('home');
          break;
        case 'view': {
          const v = document.createElement('div');
          v.className = 'viewer';
          v.innerHTML = '<button class="btn small">關閉</button><img alt="截圖原圖" src="' + el.dataset.src + '">';
          v.addEventListener('click', () => v.remove());
          document.body.appendChild(v);
          break;
        }
        case 'rmImage': S.draft.images.splice(+el.dataset.i, 1); if (!S.draft.images.length) S.draft = null; render(); break;
        case 'runOcr': await ocrImages(S.draft.images, false); break;
        case 'skipOcr':
          S.draft.images.forEach((im) => { im.status = 'manual'; });
          S.draft.stage = 'review';
          if (!S.draft.items.length) S.draft.items.push(blankItem());
          if (!S.draft.txn.date) S.draft.txn.fieldFlags.date = { reason: '請填入消費日期（沒填也能保存，但不會拿來比價）', resolved: false };
          renumber(S.draft); render(); break;
        case 'manualDraft':
          S.draft = newDraft(false); S.draft.stage = 'review'; S.draft.items.push(blankItem()); renumber(S.draft); render(); break;
        case 'mockShots': await mockScreenshots(); break;
        case 'cancelDraft': if (!armed(el)) break; S.draft = null; S.ocrState = null; S.dupBlock = null;
          if (await nextQueued()) toast('已放棄這筆，接著核對下一筆'); render(); break;
        case 'addDraftItem': S.draft.items.push(blankItem()); renumber(S.draft); render(); break;
        case 'rmDraftItem': if (!armed(el)) break; S.draft.items.splice(+el.dataset.i, 1); renumber(S.draft); render(); break;
        case 'toggleExclude': { const it = S.draft.items[+el.dataset.i]; it.excluded = !it.excluded; renumber(S.draft); render(); break; }
        case 'resolveItemFlag': {
          const it = el.dataset.scope === 'd' ? S.draft.items[+el.dataset.i] : S.itemEdit;
          it.flags.forEach((f) => { if (f.field === el.dataset.f) f.resolved = true; });
          const y = window.scrollY; render(); window.scrollTo(0, y); break;
        }
        case 'resolveTxnFlag': {
          const t = el.dataset.scope === 't' ? S.draft.txn : S.txnEdit;
          const fl = t.fieldFlags[el.dataset.f];
          if (typeof fl === 'object') fl.resolved = true; else delete t.fieldFlags[el.dataset.f];
          const y = window.scrollY; render(); window.scrollTo(0, y); break;
        }
        case 'commit': await commitDraft(el.dataset.force === '1'); break;
        case 'resolveSavedItemFlag': {
          const i = S.items.find((x) => x.id === el.dataset.id);
          const u = Object.assign({}, i, { flags: i.flags.filter((f) => f.field !== el.dataset.f) });
          u.editLog = (i.editLog || []).concat([{ at: nowISO(), summary: '確認「' + (FIELD_LABELS[el.dataset.f] || el.dataset.f) + '」無誤' }]);
          await DB.write({ put: { items: [u] } }); await loadAll(); render(); break;
        }
        case 'resolveSavedTxnFlag': {
          const t = S.tById[el.dataset.id];
          const ff = Object.assign({}, t.fieldFlags); delete ff[el.dataset.f];
          const u = Object.assign({}, t, { fieldFlags: ff, editLog: (t.editLog || []).concat([{ at: nowISO(), summary: '確認「' + (FIELD_LABELS[el.dataset.f] || el.dataset.f) + '」無誤' }]) });
          await DB.write({ put: { transactions: [u] } }); await loadAll(); render(); break;
        }
        case 'editTxn': S.editTxn = el.dataset.id; S.txnEdit = JSON.parse(JSON.stringify(S.tById[el.dataset.id])); render(); break;
        case 'cancelTxnEdit': S.editTxn = null; render(); break;
        case 'saveTxn': await saveTxn(el.dataset.id); break;
        case 'saveItem': await saveItem(el.dataset.id); break;
        case 'delItem': if (!armed(el)) break; await deleteItem(el.dataset.id); break;
        case 'delTxn': if (!armed(el)) break; await deleteTxn(el.dataset.id); break;
        case 'setFilter': S.filter[el.dataset.k] = el.dataset.v; render(); break;
        case 'editProduct': S.editProduct = el.dataset.id; S.productEdit = JSON.parse(JSON.stringify(S.pById[el.dataset.id])); render(); break;
        case 'cancelProductEdit': S.editProduct = null; S.productEdit = null; render(); break;
        case 'saveProduct': await saveProduct(el.dataset.id); break;
        case 'mergeProduct': { const to = document.getElementById('mergeTarget').value; if (!to) { toast('請先選擇要併入的商品'); break; } if (!armed(el)) break; await mergeProduct(el.dataset.id, to); break; }
        case 'sameProduct': await resolveMatch(el.dataset.id, 'same', el.dataset.p); break;
        case 'samePicked': await resolveMatch(el.dataset.id, 'same', document.getElementById('pick-' + el.dataset.id).value); break;
        case 'diffProduct': await resolveMatch(el.dataset.id, 'diff'); break;
        case 'deferProduct': await resolveMatch(el.dataset.id, 'defer'); break;
        case 'setDate': {
          const v = document.getElementById('nd-' + el.dataset.id).value;
          if (!v) { toast('請先選日期'); break; }
          const t = S.tById[el.dataset.id];
          const ff = Object.assign({}, t.fieldFlags); delete ff.date;
          const u = Object.assign({}, t, { date: v, fieldFlags: ff, updatedAt: nowISO(), editLog: (t.editLog || []).concat([{ at: nowISO(), summary: '消費日期 （空白） → ' + v }]) });
          u.fingerprint = L.txnFingerprint(u, S.items.filter((i) => i.txnId === t.id));
          await DB.write({ put: { transactions: [u] } }); await loadAll(); toast('已填入日期 ' + v); render(); break;
        }
        case 'exportJson': await exportJson(el.dataset.img === '1'); break;
        case 'exportCsv': await exportCsv(); break;
        // 目前沒有資料時「取代」不會刪掉任何東西，不需要按兩次
        case 'doRestore': if (el.dataset.mode === 'replace' && S.txns.length && !armed(el)) break; await doRestore(el.dataset.mode); break;
        case 'cancelRestore': S.restore = null; render(); break;
        case 'persist': { const r = await DB.requestPersist(); toast(r ? '瀏覽器已同意保留資料' : '瀏覽器沒有同意（Safari 通常要加到主畫面並常用才會同意）', 4000); fillStorageInfo(); break; }
        case 'loadMock': await loadMock(); break;
        case 'clearMock': if (!armed(el)) break; await clearMock(); break;
        case 'wipeAll': if (!armed(el)) break; await DB.clear(['transactions', 'items', 'products', 'images']); await loadAll(); toast('已刪除全部資料'); go('home'); break;
        default: break;
      }
    } catch (err) {
      console.error(err);
      toast('操作失敗：' + (err && err.message ? err.message : err), 5000);
    }
    if (S.route.name === 'backup') fillStorageInfo();
  });

  window.addEventListener('beforeunload', (e) => { if (S.draft && S.draft.images.length) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- 啟動 ----------
  (async function start() {
    try {
      await DB.open();
      await loadAll();
    } catch (e) {
      app.innerHTML = topbar('無法開啟資料庫', false) + '<main><div class="notice bad">這個瀏覽器無法使用本機資料庫（' + esc(e.message || e) + '）。可能是無痕模式或已封鎖網站資料。請改用一般模式的 Safari 開啟。</div></main>';
      return;
    }
    routeFromHash();
    if (S.route.name === 'import' && !S.draft) S.route = { name: 'import', param: null };
    render();
    if (S.route.name === 'backup') fillStorageInfo();
  })();

  // 測試用的唯讀介面
  window.PXApp = { state: S, go, reload: async () => { await loadAll(); render(); } };
})();
