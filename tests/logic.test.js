// 驗收測試（計算邏輯與 OCR 解析）。全部使用模擬資料。執行：node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');
const P = require('../js/parser.js');
const M = require('../js/mock.js');

// 建立一個模擬資料庫：依序「匯入」交易，用與 App 相同的比對規則指派商品
function buildDb(list) {
  const txns = [], items = [], products = [], skipped = [], pending = [];
  let n = 0;
  for (const m of list) {
    const txn = Object.assign({ id: 't' + ++n, importedAt: '2026-10-01T00:00:0' + n + 'Z' }, m.txn);
    const its = m.items.map((it, i) => Object.assign({ id: txn.id + '-' + (i + 1), txnId: txn.id, lineNo: i + 1, isMock: true }, it));
    txn.fingerprint = L.txnFingerprint(txn, its);
    const dup = L.findDuplicateTxn(txn, its, txns);
    if (dup) { skipped.push({ case: m.case, why: dup.why }); continue; }
    for (const it of its) {
      if (it.isPromo) { it.matchStatus = 'promo'; continue; }
      const r = L.matchProduct(it, products);
      if (r.product) { it.productId = r.product.id; r.product.keys.push(L.productKey(it)); }
      else if (r.type === 'similar') { it.matchStatus = 'pending'; pending.push({ item: it, candidates: r.candidates }); }
      else {
        const p = { id: 'p' + (products.length + 1), name: it.rawName, spec: L.effectiveSpec(it), keys: [L.productKey(it)], aliases: [it.rawName], isMock: true, conflicts: r.specConflicts };
        products.push(p); it.productId = p.id;
      }
    }
    txns.push(txn); items.push(...its);
  }
  return { txns, items, products, skipped, pending, tById: Object.fromEntries(txns.map((t) => [t.id, t])) };
}
const db = buildDb(M.transactions());
const prod = (name) => db.products.find((p) => p.name === name);
const hist = (name, mode) => L.productHistory(prod(name), db.items, db.tById, mode);

test('案例 1：相同商品從 30 元漲至 35 元', () => {
  const h = hist('模擬鮮乳 936ml');
  assert.equal(h.previous.price, 30);
  assert.equal(h.latest.price, 35);
  assert.equal(h.cmp.status, 'up');
  assert.equal(h.cmp.diff, 5);
  assert.equal(h.cmp.pct, 16.67);
  assert.equal(h.min, 30); assert.equal(h.max, 35); assert.equal(h.count, 2);
});

test('案例 2：相同商品從 35 元降至 30 元', () => {
  const h = hist('模擬吐司');
  assert.equal(h.cmp.status, 'down');
  assert.equal(h.cmp.diff, -5);
  assert.equal(h.cmp.pct, -14.29);
  // 第三次購買（M3）沒有日期 → 不算有效，也不影響比較
  assert.equal(h.count, 3);
  assert.equal(h.validCount, 2);
  assert.equal(h.rows.find((r) => !r.txn.date).reason, '缺少日期');
});

test('案例 3：相同商品價格不變', () => {
  const h = hist('模擬雞蛋10入');
  assert.equal(h.cmp.status, 'same');
  assert.equal(h.cmp.diff, 0);
  assert.equal(h.cmp.pct, 0);
});

test('案例 4：同名但不同規格的商品不可合併', () => {
  const small = prod('模擬鮮乳 936ml'), big = prod('模擬鮮乳 1836ml');
  assert.ok(small && big && small.id !== big.id);
  assert.equal(big.conflicts.length, 1, '應記錄有同名不同規格的商品');
  assert.equal(hist('模擬鮮乳 1836ml').cmp.status, 'na');
  // 每 100ml 價格
  const r = hist('模擬鮮乳 1836ml').latest;
  assert.equal(r.per100, L.round2(62 / 1836 * 100));
  assert.equal(r.per100Unit, '每100ml');
  assert.equal(L.specKey('1,836 ml'), L.specKey('1836ML'));
  assert.equal(L.specKey('1.836L'), 'ml:1836');
});

test('案例 5：OCR 數字辨識錯誤會標示待確認，不當成正確資料', () => {
  // App 層：有待確認旗標的列不拿來比價
  const soy = db.items.find((i) => i.rawName === '模擬豆漿');
  assert.equal(L.linePrice(soy).reason, '數字待確認');
  // 解析層：模擬 OCR 把 5 認成 S、把數量 2 認成「色」
  const page = mkPage([
    [w('消費明細', 95, 54)],
    [w('名稱', 93, 54), w('數量', 93, 545, 90), w('金額', 93, 830, 90)],
    [w('11', 93, 54), w('模擬豆漿', 93, 135, 160), w('1', 96, 580, 20), w('2S', 70, 860, 40)],
    [w('22', 93, 54), w('模擬吐司', 93, 135, 160), w('色', 42, 575, 30), w('70', 92, 860, 40)],
    [w('33', 93, 54), w('模擬雞蛋', 93, 135, 160), w('1', 96, 580, 20), w('6O', 75, 860, 40)],
  ]);
  const r = P.parsePage(page);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].paidAmount, null);
  assert.ok(r.items[0].flags.some((f) => f.field === 'paidAmount'));
  assert.equal(r.items[1].qty, null);
  assert.ok(r.items[1].flags.some((f) => f.field === 'qty'));
  assert.equal(r.items[1].rawName, '模擬吐司', '誤認成中文的數量不可併入名稱');
  assert.equal(r.items[2].paidAmount, 60, 'O→0 替換後要有值');
  assert.ok(r.items[2].flags.some((f) => f.field === 'paidAmount'), '但仍必須待確認');
  // 第二次只辨識數字的結果：一致 → 解除；不一致 → 保留
  const it = r.items[1];
  P.applyRefinement(it, 'qty', { value: 2, conf: 60 });
  assert.equal(it.qty, 2);
  assert.ok(it.flags.some((f) => f.field === 'qty'), '補上的值仍需人工確認');
});

test('案例 6：一筆交易的多張截圖合併為一筆，重疊列不重複計入', () => {
  const p1 = P.parsePage(mkPage([
    [w('【模擬】測試門市', 92, 300, 360)],
    [w('交易日期', 96, 53), w('2026/04/01', 90, 517, 250), w('12:30', 91, 781, 110)],
    [w('消費明細', 95, 54)],
    [w('名稱', 93, 54), w('數量', 93, 545, 90), w('金額', 93, 830, 90)],
    [w('11', 93, 54), w('模擬鮮乳', 93, 135, 160), w('1', 96, 580, 20), w('30', 93, 860, 40)],
    [w('22', 93, 54), w('模擬吐司', 93, 135, 160), w('2', 96, 580, 20), w('70', 93, 860, 40)],
    [w('33', 93, 54), w('模擬雞蛋', 93, 135, 160), w('1', 96, 580, 20), w('60', 93, 860, 40)],
  ]));
  const p2 = P.parsePage(mkPage([
    [w('【模擬】測試門市', 92, 300, 360)],
    [w('22', 93, 54), w('模擬吐司', 93, 135, 160), w('2', 96, 580, 20), w('70', 93, 860, 40)],
    [w('33', 93, 54), w('模擬雞蛋', 90, 135, 160), w('1', 96, 580, 20), w('60', 93, 860, 40)],
    [w('44', 93, 54), w('模擬香蕉', 93, 135, 160), w('3', 96, 580, 20), w('75', 93, 860, 40)],
    [w('付款方式', 97, 54)],
    [w('項目', 96, 54), w('金額$', 93, 800, 110)],
    [w('模擬付款', 96, 54), w('235', 93, 840, 70)],
    [w('優惠活動折扣金額', 95, 53), w('NT$', 92, 707, 80), w('0', 90, 811, 20), w('⌄', 60, 880, 30)],
  ]), { columns: p1.columns });
  const m = L.mergePages([p1, p2]);
  const kept = m.items.filter((i) => !i.overlap);
  assert.deepEqual(kept.map((i) => i.rawName), ['模擬鮮乳', '模擬吐司', '模擬雞蛋', '模擬香蕉']);
  assert.equal(m.items.filter((i) => i.overlap).length, 2);
  assert.equal(m.date, '2026-04-01'); assert.equal(m.time, '12:30');
  assert.equal(m.paymentTotal, 235);
  assert.equal(m.discountTotal, 0, '折扣金額右側的展開圖示不可當成數字');
  const cc = L.crossCheck(m);
  assert.ok(cc.ok, '合計 30+70+60+75=235 應與付款一致');
});

test('案例 7：同一筆交易重複匯入會被擋下', () => {
  assert.equal(db.skipped.length, 1);
  assert.match(db.skipped[0].case, /M5/);
  assert.equal(db.skipped[0].why, '發票號碼相同');
  // 沒有發票號碼時，用門市＋日期＋金額＋明細比對
  const t = { store: 'X', date: '2026-01-01', time: null, paymentTotal: 10 };
  const its = [{ rawName: 'A', qty: 1, paidAmount: 10 }];
  const prev = Object.assign({ id: 'a', fingerprint: L.txnFingerprint(t, its) }, t);
  assert.ok(L.findDuplicateTxn(Object.assign({ id: 'b' }, t), its, [prev]));
  // 同樣的東西但不同日期 → 是另一次消費
  assert.equal(L.findDuplicateTxn(Object.assign({ id: 'c' }, t, { date: '2026-01-02' }), its, [prev]), null);
  // 交易序號相同但機台或日期不同 → 不是重複
  const a = { id: 'x', txnNo: '000789', posNo: '305501', date: '2026-10-07', fingerprint: 'q' };
  assert.equal(L.findDuplicateTxn({ id: 'y', txnNo: '000789', posNo: '305501', date: '2026-10-08' }, [], [a]), null);
  assert.ok(L.findDuplicateTxn({ id: 'y', txnNo: '000789', posNo: '305501', date: '2026-10-07' }, [], [a]));
});

test('案例 8：數量大於一件時，金額是小計不是單價', () => {
  const h = hist('模擬可樂 600ml');
  const first = h.rows[0];
  assert.equal(first.item.qty, 2); assert.equal(first.item.paidAmount, 100);
  assert.equal(first.price, 50, '2 件共 100 元 → 每件 50 元');
  assert.ok(first.priceInfo.derived);
  assert.equal(h.latest.price, 55);
  assert.equal(h.cmp.diff, 5); assert.equal(h.cmp.pct, 10);
});

test('案例 9：折扣造成實付價不同，原價與實付分開比較', () => {
  const paid = hist('模擬洗碗精', 'paid');
  assert.equal(paid.cmp.status, 'down');
  assert.equal(paid.cmp.diff, -10);
  assert.equal(paid.cmp.pct, -12.5);
  assert.equal(paid.latest.cmp.note, '兩次優惠條件不同');
  const list = hist('模擬洗碗精', 'list');
  assert.equal(list.cmp.status, 'same', '原價都是 80，原價口徑沒有漲跌');
  // 沒有原價資料時不推算
  assert.equal(L.linePrice({ qty: 1, paidAmount: 70, discount: 10 }).listPerUnit, null);
});

test('案例 10：缺少價格或日期 → 無法比較，不產生錯誤百分比', () => {
  const cookie = db.items.find((i) => i.rawName === '模擬餅乾');
  assert.equal(L.linePrice(cookie).reason, '缺少金額');
  const h = hist('模擬餅乾');
  assert.equal(h.cmp.status, 'na'); assert.equal(h.cmp.pct, undefined);
  assert.deepEqual(L.comparePrices(null, 30), { status: 'na', diff: null, pct: null, reason: '缺少基準價格或本次價格' });
  assert.equal(L.comparePrices(0, 30).status, 'na');
  assert.equal(L.comparePrices(30, 0).status, 'na');
  assert.equal(L.linePrice({ qty: 0, paidAmount: 30 }).reason, '缺少數量');
  assert.equal(L.linePrice({ qty: 1, paidAmount: 30, priceUnclear: true }).reason, '價格口徑不明');
});

test('案例 11：零元贈品（印花）不列入比價', () => {
  const promo = db.items.find((i) => i.rawName === '模擬贈品印花(促)');
  assert.equal(promo.matchStatus, 'promo');
  assert.equal(L.linePrice(promo).reason, '金額為零或負數');
});

test('案例 12：名稱相似但無法確定 → 待確認，不自動合併', () => {
  const p = db.pending.find((x) => x.item.rawName === '模擬鮮奶 936ml');
  assert.ok(p, '模擬鮮奶應進入待確認');
  assert.equal(p.candidates[0].product.name, '模擬鮮乳 936ml');
  assert.equal(p.item.productId, undefined);
  // 規格不同的不可列為候選
  assert.ok(!p.candidates.some((c) => c.product.name === '模擬鮮乳 1836ml'));
});

test('案例 13：同一筆交易中重複出現的商品列會被找出', () => {
  const t = db.txns.find((x) => x.case === undefined && db.items.some((i) => i.txnId === x.id && i.rawName === '模擬香蕉'));
  const its = db.items.filter((i) => i.txnId === t.id);
  const d = L.findRepeatedLines(its);
  assert.equal(d.length, 1);
  assert.equal(its[d[0][0]].rawName, '模擬香蕉');
  // 同一筆交易裡的兩列不互相當作「上次」
  assert.equal(hist('模擬香蕉').cmp.status, 'na');
  assert.equal(hist('模擬香蕉').latest.prev, null);
});

test('CSV 匯出：欄位跳脫、BOM、模擬資料標記', () => {
  const csv = L.toCSV(db.txns, db.items, db.products);
  assert.ok(csv.startsWith('﻿模擬資料,'));
  const lines = csv.split('\r\n');
  assert.equal(lines.length, db.items.length + 1);
  assert.ok(lines.slice(1).every((l) => l.startsWith('是,')));
  assert.equal(L.toCSV([{ id: 't', store: 'a,"b"' }], [{ id: 'i', txnId: 't', rawName: 'x' }], []).split('\r\n')[1].includes('"a,""b"""'), true);
});

test('備份檔驗證', () => {
  assert.equal(L.validateBackup({ app: 'px-ghost', data: { transactions: [], items: [], products: [] } }), null);
  assert.ok(L.validateBackup({ app: 'other' }));
  assert.ok(L.validateBackup(null));
});

test('日期解析：西元與民國年', () => {
  assert.deepEqual(P.parseDate('交易日期 2026/10/07 22:49'), { date: '2026-10-07', time: '22:49', roc: false });
  assert.deepEqual(P.parseDate('115/10/07'), { date: '2026-10-07', time: null, roc: true });
  assert.equal(P.parseDate('2026/13/40'), null);
});

// ---------- 模擬 OCR 結果的建構工具 ----------
let y = 0;
function w(text, conf, x0, width) { return { text, conf, bbox: { x0, x1: x0 + (width || text.length * 44), y0: 0, y1: 0 } }; }
function mkPage(rows) {
  y = 40;
  const lines = rows.map((ws) => {
    const yy = y; y += 105;
    ws.forEach((x) => { x.bbox.y0 = yy; x.bbox.y1 = yy + 46; });
    return { text: ws.map((x) => x.text).join(' '), words: ws };
  });
  return { width: 966, height: y + 40, lines };
}

test('一次選多筆交易的截圖會自動分組，續頁留在同一筆', () => {
  const pg = (o) => Object.assign({ date: null, txnNo: null, invoiceNo: null, items: [] }, o);
  const pages = [pg({ date: '2026-09-02' }), pg({}), pg({ date: '2026-09-07', txnNo: '000833' }), pg({}), pg({}), pg({ invoiceNo: 'ZZ00000002' })];
  assert.deepEqual(L.splitPages(pages), [[0, 1], [2, 3, 4], [5]]);
  assert.deepEqual(L.splitPages([pg({}), pg({})]), [[0, 1]]);
  assert.deepEqual(L.splitPages([pg({}), pg({ date: '2026-09-02' }), pg({})]), [[0, 1, 2]]);
});

test('同名不同容量：比對名稱、規格、條碼、價格，避免誤認為同一品項', () => {
  const milk = { id: 'm1', name: '模擬鮮乳', keys: ['模擬鮮乳||'], spec: null, isMock: true };
  const price = { 'm1': 99, 'm2': 167 };
  const opt = { priceOf: (p) => price[p.id] };
  // 明細沒有容量、價差 +68.69% → 待確認，不自動合併
  const r1 = L.matchProduct({ rawName: '模擬鮮乳', qty: 1, paidAmount: 167, isMock: true }, [milk], opt);
  assert.equal(r1.type, 'similar');
  assert.match(r1.reason, /可能是不同容量/);
  // 價差在 30% 內 → 自動歸入
  assert.equal(L.matchProduct({ rawName: '模擬鮮乳', qty: 1, paidAmount: 105, isMock: true }, [milk], opt).type, 'exact');
  // 兩種容量都設定好後，明細沒有容量時依價格對應，並留下說明
  const a = Object.assign({}, milk, { spec: '936ml' });
  const b = { id: 'm2', name: '模擬鮮乳', keys: ['模擬鮮乳||ml:1858'], spec: '1858ml', isMock: true };
  const r2 = L.matchProduct({ rawName: '模擬鮮乳', qty: 1, paidAmount: 165, isMock: true }, [a, b], opt);
  assert.equal(r2.type, 'price');
  assert.equal(r2.product.id, 'm2');
  assert.match(r2.note, /依價格對應到 1858ml/);
  // 明細有容量時直接依容量
  assert.equal(L.matchProduct({ rawName: '模擬鮮乳 936ml', qty: 1, paidAmount: 99, isMock: true }, [a, b], opt).product.id, 'm1');
  // 條碼不同絕不合併；條碼相同直接歸入
  const c = Object.assign({}, a, { barcode: '4710000000001' });
  assert.notEqual(L.matchProduct({ rawName: '模擬鮮乳', barcode: '4710000000002', qty: 1, paidAmount: 99, isMock: true }, [c], opt).product, c);
  assert.equal(L.matchProduct({ rawName: '別的名字', barcode: '4710000000001', isMock: true }, [c], opt).type, 'barcode');
  // 品牌不同不合併
  const d = Object.assign({}, a, { brand: '甲牌' });
  assert.equal(L.compareToProduct({ rawName: '模擬鮮乳', brand: '乙牌' }, d).verdict, 'conflict');
  // 入數也是規格
  assert.equal(L.specRelation('200ml*6入', '200ml'), 'diff');
  assert.equal(L.specRelation('936ml', '0.936L'), 'same');
  assert.equal(L.specKey('600ml x4瓶'), 'ml:600x4');
});

test('同一商品價差超過 30%：標示規格待確認，不算漲跌，確認後照常比價', () => {
  const p = { id: 'p', name: '模擬鮮乳', spec: null };
  const tById = { t1: { id: 't1', date: '2026-09-02' }, t2: { id: 't2', date: '2026-09-18' } };
  const items = [{ id: 'i1', txnId: 't1', productId: 'p', qty: 1, paidAmount: 99 }, { id: 'i2', txnId: 't2', productId: 'p', qty: 1, paidAmount: 167 }];
  const h = L.productHistory(p, items, tById);
  assert.equal(h.status, 'check');
  assert.equal(h.cmp.pct, 68.69);
  const h2 = L.productHistory(Object.assign({ priceJumpOk: ['i2'] }, p), items, tById);
  assert.equal(h2.status, 'up');
});
