// 瀏覽器端到端驗收：保存、重新整理、比價、待確認、修改、刪除、匯出、還原、模擬截圖 OCR。
// 執行：npx http-server -p 8765 . 後，NODE_PATH=$(npm root -g) node tests/e2e.js [截圖路徑…]
// 額外給的截圖只會在暫時的瀏覽器裡辨識並印出結果，不會被保存。
'use strict';
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8765/';
const OUT = process.env.OUT || path.join(__dirname, '..', 'test-output');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const ctx = await browser.newContext(Object.assign({}, devices['iPhone 13'], { acceptDownloads: true, defaultBrowserType: undefined }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push('✓ ' + name); } catch (e) { results.push('✗ ' + name + '：' + e.message); } };
  const tiles = async () => page.$$eval('.tile', (ts) => Object.fromEntries(ts.map((t) => [t.querySelector('span').textContent, +t.querySelector('b').textContent])));
  const click = (sel) => page.locator(sel).first().click();
  const clickText = (t) => page.getByRole('button', { name: t }).first().click();
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });

  await page.goto(BASE);
  await page.waitForSelector('.tile');
  await shot('01-home-empty');

  await step('載入模擬資料，重複的 M5 被擋下', async () => {
    await clickText('匯出資料與備份');
    await clickText('載入模擬資料');
    await page.waitForSelector('.notice.info');
    const n = await page.textContent('.notice.info');
    assert.match(n, /已載入 4 筆模擬交易/);
    assert.match(n, /M5 重複匯入 M1（發票號碼相同）/);
    const t = await tiles();
    assert.equal(t['交易'], 4);
    assert.equal(t['上漲'], 2); assert.equal(t['下降'], 2); assert.equal(t['不變'], 1);
    assert.ok(t['待確認'] >= 3, '待確認應包含：相似商品、OCR 錯誤、缺日期');
    await shot('02-home-mock');
  });

  await step('重新整理後資料仍在', async () => {
    await page.reload(); await page.waitForSelector('.tile');
    assert.equal((await tiles())['交易'], 4);
  });

  await step('價格變化頁：鮮乳 30→35（+5，+16.67%）', async () => {
    await clickText('查看商品價格變化');
    const card = page.locator('.li', { hasText: '模擬鮮乳 936ml' });
    const txt = await card.textContent();
    assert.match(txt, /上漲 \+5（\+16\.67%）/);
    assert.match(txt, /上次 2026-01-05.*30.*本次 2026-02-10.*35/s);
    const coke = await page.locator('.li', { hasText: '模擬可樂' }).textContent();
    assert.match(coke, /\+5（\+10%）/);
    await shot('03-changes');
    await click('.chip[data-v="down"]');
    assert.equal(await page.locator('.list .li').count(), 2);
  });

  await step('商品頁：歷史表、最低最高、走勢圖、每100ml', async () => {
    await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬鮮乳 1836ml'); PXApp.go('product', p.id); });
    assert.match(await page.textContent('main'), /每100ml/);
    await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬鮮乳 936ml'); PXApp.go('product', p.id); });
    const m = await page.textContent('main');
    assert.match(m, /歷史最低價30歷史最高價35歷史購買次數2/);
    assert.equal(await page.locator('#chart svg circle').count(), 2);
    await shot('04-product');
  });

  await step('待確認：鮮奶確認為同一商品後，鮮乳變 3 次購買且下降', async () => {
    await page.evaluate(() => PXApp.go('review'));
    await shot('05-review');
    const card = page.locator('.card', { hasText: '模擬鮮奶 936ml' });
    await card.getByRole('button', { name: '是同一商品' }).first().click();
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬鮮乳 936ml'); const h = PXLogic.productHistory(p, PXApp.state.items, PXApp.state.tById); return [h.count, h.cmp.status, h.cmp.diff]; });
    assert.deepEqual(h, [3, 'down', -2]);
  });

  await step('規格不同不能當成同一商品', async () => {
    const r = await page.evaluate(() => PXLogic.matchProduct({ rawName: '模擬鮮乳', spec: '1836ml', isMock: true }, PXApp.state.products).type);
    assert.equal(r, 'exact');
    const r2 = await page.evaluate(() => PXLogic.matchProduct({ rawName: '模擬鮮乳', spec: '2000ml', isMock: true }, PXApp.state.products).type);
    assert.equal(r2, 'none');
  });

  await step('修改商品列：吐司 35→36，有修改紀錄且比價重算', async () => {
    const id = await page.evaluate(() => { const t = PXApp.state.txns.find((x) => x.date === '2026-01-05'); PXApp.go('txn', t.id); return t.id; });
    const card = page.locator('.card', { hasText: '模擬吐司' }).first();
    await card.getByRole('button', { name: '修改' }).click();
    await page.fill('#ie-0-paidAmount', '36');
    await page.locator('#ie-0-paidAmount').dispatchEvent('change');
    await clickText('保存修改');
    await page.waitForSelector('.toast >> text=已更新');
    assert.match(await page.textContent('.toast >> text=已更新'), /金額（實付小計） 35 → 36/);
    assert.match(await page.textContent('main'), /修改紀錄（1）/);
    const d = await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬吐司'); return PXLogic.productHistory(p, PXApp.state.items, PXApp.state.tById).cmp; });
    assert.equal(d.diff, -6); assert.equal(d.pct, -16.67);
    await shot('06-txn-edited');
    assert.ok(id);
  });

  await step('修改交易：補上缺少的日期', async () => {
    await page.evaluate(() => PXApp.go('review'));
    const card = page.locator('.card', { hasText: '缺' }).first();
    const tid = await page.evaluate(() => PXApp.state.txns.find((t) => !t.date).id);
    await page.fill('#nd-' + tid, '2026-03-15');
    await page.locator('[data-act="setDate"]').first().click();
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬吐司'); const h = PXLogic.productHistory(p, PXApp.state.items, PXApp.state.tById); return [h.validCount, h.latest.txn.date, h.cmp.diff]; });
    assert.deepEqual(h, [3, '2026-03-15', 2]);
    assert.ok(card);
  });

  await step('刪除商品列（按兩次確認）', async () => {
    const tid = await page.evaluate(() => { const i = PXApp.state.items.find((x) => x.rawName === '模擬餅乾'); PXApp.go('txn', i.txnId); return i.txnId; });
    const btn = page.locator('.card', { hasText: '模擬餅乾' }).getByRole('button', { name: '刪除這列' });
    await btn.click();
    await page.getByRole('button', { name: '再按一次確認' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => PXApp.state.items.some((x) => x.rawName === '模擬餅乾')), false);
    assert.equal(await page.evaluate(() => PXApp.state.products.some((x) => x.name === '模擬餅乾')), false, '沒有紀錄的商品應一併移除');
    assert.ok(tid);
  });

  let backupPath;
  await step('匯出 JSON 與 CSV', async () => {
    await page.evaluate(() => PXApp.go('backup'));
    const [dl] = await Promise.all([page.waitForEvent('download'), clickText('匯出 JSON 備份（含截圖，可完整還原）')]);
    backupPath = path.join(OUT, 'backup.json');
    await dl.saveAs(backupPath);
    const obj = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(obj.app, 'px-ghost'); assert.equal(obj.data.transactions.length, 4);
    const [dl2] = await Promise.all([page.waitForEvent('download'), clickText('匯出 CSV（可用 Excel／Numbers 開啟）')]);
    const csvPath = path.join(OUT, 'items.csv');
    await dl2.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.ok(csv.startsWith('﻿模擬資料'));
    assert.equal(csv.trim().split('\r\n').length, 1 + obj.data.items.length);
    await shot('07-backup');
  });

  await step('刪除全部資料後由 JSON 還原', async () => {
    await clickText('刪除全部資料');
    await page.getByRole('button', { name: '再按一次確認' }).click();
    await page.waitForSelector('.tile');
    assert.equal((await tiles())['交易'], 0);
    await page.evaluate(() => PXApp.go('backup'));
    await page.setInputFiles('#restoreFile', backupPath);
    await page.waitForSelector('text=還原預覽');
    // 目前沒有資料，「取代」按一次就還原
    await clickText('取代（先清空目前全部資料）');
    await page.waitForSelector('.tile');
    const t = await tiles();
    assert.equal(t['交易'], 4);
    const d = await page.evaluate(() => { const p = PXApp.state.products.find((x) => x.name === '模擬吐司'); return PXLogic.productHistory(p, PXApp.state.items, PXApp.state.tById).cmp.diff; });
    assert.equal(d, 2, '還原後計算結果應與備份前相同');
  });

  await step('模擬截圖 OCR：兩張合併成一筆、重疊列排除、合計一致；資料庫連線被關閉後仍能保存', async () => {
    await page.evaluate(() => PXApp.go('import'));
    await clickText('用模擬截圖試用 OCR');
    await page.waitForSelector('.thumb img');
    await clickText('開始辨識（2 張）');
    await page.waitForSelector('text=步驟 2：核對交易資料', { timeout: 180000 });
    await shot('08-ocr-review');
    const d = await page.evaluate(() => { const d = PXApp.state.draft; return { kept: d.items.filter((i) => !i.excluded).map((i) => [i.rawName, i.qty, i.paidAmount]), overlap: d.items.filter((i) => i.overlap).length, date: d.txn.date, total: d.txn.paymentTotal }; });
    console.log('  模擬截圖辨識結果：', JSON.stringify(d));
    assert.equal(d.overlap, 2);
    assert.equal(d.kept.length, 4);
    assert.equal(d.date, '2026-04-01');
    assert.match(await page.textContent('main'), /數字一致/);
    // 模擬 iPhone Safari 在背景時關閉資料庫連線：保存時要能自動重新連線
    await page.evaluate(async () => (await PXDB.open()).close());
    await clickText('確認並保存到資料庫');
    await page.waitForSelector('text=交易明細');
    assert.equal(await page.evaluate(() => PXApp.state.txns.length), 5);
    await page.evaluate(() => PXApp.go('import'));
    await clickText('用模擬截圖試用 OCR');
    await page.waitForSelector('.notice.bad');
    assert.match(await page.textContent('.notice.bad'), /已經在.*匯入過/);
  });

  // 額外：辨識使用者提供的截圖（只印出，不保存）
  for (const f of process.argv.slice(2)) {
    await step('辨識截圖 ' + path.basename(f) + '（不保存）', async () => {
      const r = await page.evaluate(async (b64) => {
        const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        const p = await PXOcr.recognize(new Blob([a], { type: 'image/jpeg' }), {});
        return { store: p.store, date: p.date, time: p.time, posNo: p.posNo, txnNo: p.txnNo, invoiceNo: p.invoiceNo, spendTotal: p.spendTotal, paymentTotal: p.paymentTotal, discountTotal: p.discountTotal,
          items: p.items.map((i) => [i.deptCode, i.rawName, i.qty, i.paidAmount, i.flags.map((f) => f.field + ':' + f.reason).join(' | ')]) };
      }, fs.readFileSync(f).toString('base64'));
      console.log('  ' + JSON.stringify(r));
    });
  }

  results.push(errors.length ? '✗ 頁面錯誤：' + errors.join(' / ') : '✓ 沒有頁面錯誤');
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0);
})();
