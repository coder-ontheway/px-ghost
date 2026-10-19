/*
 * 模擬資料（全部標示 isMock，門市名稱為「【模擬】測試門市」，不含任何真實消費紀錄）
 * 用於驗收測試與試用；可在「備份與資料」頁一鍵刪除。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PXMock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const STORE = '【模擬】測試門市';

  function it(rawName, qty, paidAmount, extra) {
    return Object.assign({ rawName, deptCode: null, brand: null, barcode: null, spec: null, qty, unitPrice: null,
      originalAmount: null, discount: null, paidAmount, priceUnclear: false, isPromo: false, flags: [] }, extra || {});
  }
  function tx(id, date, time, items, extra) {
    return { case: id, txn: Object.assign({ store: STORE, date, time, posNo: null, txnNo: null, invoiceNo: null, spendTotal: null,
      paymentMethod: '模擬付款', paymentTotal: items.reduce((s, i) => s + (i.paidAmount || 0), 0), discountTotal: 0, points: null,
      isMock: true, fieldFlags: {} }, extra || {}), items };
  }

  function transactions() {
    return [
      tx('M1 基準交易', '2026-01-05', '10:00', [
        it('模擬鮮乳 936ml', 1, 30, { spec: '936ml' }),
        it('模擬吐司', 1, 35),
        it('模擬雞蛋10入', 1, 60),
        it('模擬可樂 600ml', 2, 100, { spec: '600ml' }),
        it('模擬洗碗精', 1, 80, { originalAmount: 80, discount: 0 }),
      ], { invoiceNo: 'ZZ00000001' }),
      tx('M2 價格變動', '2026-02-10', '18:30', [
        it('模擬鮮乳 936ml', 1, 35, { spec: '936ml' }),
        it('模擬吐司', 1, 30),
        it('模擬雞蛋10入', 1, 60),
        it('模擬鮮乳 1836ml', 1, 62, { spec: '1836ml' }),
        it('模擬可樂 600ml', 1, 55, { spec: '600ml' }),
        it('模擬洗碗精', 1, 70, { originalAmount: 80, discount: 10 }),
      ], { invoiceNo: 'ZZ00000002' }),
      tx('M3 缺少日期與價格', null, null, [
        it('模擬吐司', 1, 32),
        it('模擬餅乾', 1, null),
      ], { fieldFlags: { date: '模擬：截圖沒有日期' } }),
      tx('M4 OCR 錯誤、重複列與零元贈品', '2026-03-01', '09:15', [
        it('模擬香蕉', 1, 25),
        it('模擬香蕉', 1, 25),
        it('模擬贈品印花(促)', 1, 0, { isPromo: true }),
        it('模擬鮮奶 936ml', 1, 33, { spec: '936ml' }),
        it('模擬豆漿', 1, 25, { flags: [{ field: 'paidAmount', reason: '金額辨識不確定（2S），模擬 OCR 把 5 認成 S' }] }),
      ]),
      // M5 與 M1 完全相同，用來測試防止重複匯入，載入時應被擋下
      tx('M5 重複匯入 M1', '2026-01-05', '10:00', [
        it('模擬鮮乳 936ml', 1, 30, { spec: '936ml' }),
        it('模擬吐司', 1, 35),
        it('模擬雞蛋10入', 1, 60),
        it('模擬可樂 600ml', 2, 100, { spec: '600ml' }),
        it('模擬洗碗精', 1, 80, { originalAmount: 80, discount: 0 }),
      ], { invoiceNo: 'ZZ00000001' }),
    ];
  }

  // 產生模擬截圖用的內容（兩張，有兩列重疊，第二張沒有表頭以外的交易資訊）
  const SCREENSHOTS = [
    { header: true, rows: [['11', '模擬鮮乳', '1', '30'], ['22', '模擬吐司', '2', '70'], ['33', '模擬雞蛋', '1', '60']], footer: false },
    { header: false, rows: [['22', '模擬吐司', '2', '70'], ['33', '模擬雞蛋', '1', '60'], ['44', '模擬香蕉', '3', '75']], footer: true, total: '235' },
  ];

  return { transactions, SCREENSHOTS, STORE };
});
