/*
 * 瀏覽器端 OCR（Tesseract.js + 繁體中文模型），所有辨識都在手機上完成，不會上傳截圖。
 * 第一次使用需下載約 12 MB 的辨識引擎與語言模型，之後由瀏覽器快取。
 */
(function (root) {
  'use strict';
  let mainWorker = null;
  let digitWorker = null;
  let initPromise = null;

  function base() { return new URL('vendor/tesseract/', location.href).href; }

  function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (typeof Tesseract === 'undefined') throw new Error('辨識引擎沒有載入');
      const b = base();
      const common = {
        workerPath: b + 'px-worker.js',
        corePath: b + 'core/',
        langPath: b + 'lang',
        gzip: true,
        workerBlobURL: false,
        logger: (m) => { if (onProgress && m && m.status) onProgress(m); },
      };
      mainWorker = await Tesseract.createWorker(['chi_tra', 'eng'], 1, common);
      await mainWorker.setParameters({ preserve_interword_spaces: '1' });
      digitWorker = await Tesseract.createWorker('eng', 1, Object.assign({}, common, { logger: () => {} }));
      // 只辨識數字：用來重新確認數量與金額欄
      await digitWorker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
    })();
    initPromise.catch(() => { initPromise = null; });
    return initPromise;
  }

  async function imageSize(blob) {
    if (root.createImageBitmap) {
      try { const bmp = await createImageBitmap(blob); const s = { width: bmp.width, height: bmp.height }; bmp.close && bmp.close(); return s; } catch (e) { /* 改用 Image */ }
    }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { res({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { rej(new Error('無法讀取圖片')); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  function toPage(data, size) {
    return {
      width: size.width,
      height: size.height,
      lines: (data.lines || []).map((l) => ({
        text: l.text,
        bbox: l.bbox,
        words: (l.words || []).map((w) => ({ text: w.text, conf: w.confidence, bbox: w.bbox })),
      })),
    };
  }

  // 辨識一張截圖並解析；opts.columns 可沿用上一張的欄位位置（第二張截圖可能沒有表頭）
  async function recognize(blob, opts, onProgress) {
    await init(onProgress);
    const size = await imageSize(blob);
    const r = await mainWorker.recognize(blob);
    const page = toPage(r.data, size);
    const parsed = PXParser.parsePage(page, opts || {});
    parsed.rawText = r.data.text;
    if (opts && opts.keepPage) parsed.page = page;
    // 第二次辨識：只針對待確認的數量／金額欄（放大、轉黑白後只辨識數字）
    const bmp = parsed.items.some((it) => PXParser.needsRefine(it, 'qty') || PXParser.needsRefine(it, 'paidAmount')) ? await createImageBitmap(blob) : null;
    for (const item of parsed.items) {
      for (const field of ['qty', 'paidAmount']) {
        if (!PXParser.needsRefine(item, field) || !item.cells || !item.cells[field]) continue;
        const rect = clampRect(item.cells[field], size);
        if (!rect) continue;
        try {
          const second = await readDigits(bmp, rect);
          PXParser.applyRefinement(item, field, second);
        } catch (e) { /* 第二次辨識失敗就保留待確認 */ }
      }
    }
    parsed.size = size;
    return parsed;
  }

  // 把一格裁切出來、放大 3 倍並轉成黑白，四周留白，提高細數字（例如 1、2）的辨識率
  function cellCanvas(bmp, rect) {
    const k = 3, pad = 24;
    const c = document.createElement('canvas');
    c.width = rect.width * k + pad * 2; c.height = rect.height * k + pad * 2;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, rect.left, rect.top, rect.width, rect.height, pad, pad, rect.width * k, rect.height * k);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 170 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  async function readDigits(bmp, rect) {
    if (!bmp) return null;
    const c = cellCanvas(bmp, rect);
    let d = await digitWorker.recognize(c);
    let text = (d.data.text || '').trim();
    if (!text) {
      await digitWorker.setParameters({ tessedit_pageseg_mode: '8' });
      try { d = await digitWorker.recognize(c); text = (d.data.text || '').trim(); }
      finally { await digitWorker.setParameters({ tessedit_pageseg_mode: '7' }); }
    }
    const n = PXParser.cleanNumber(text);
    return { value: n.value, conf: d.data.confidence };
  }

  function clampRect(r, size) {
    const left = Math.max(0, Math.round(r.left));
    const top = Math.max(0, Math.round(r.top));
    const width = Math.min(size.width - left, Math.round(r.width));
    const height = Math.min(size.height - top, Math.round(r.height));
    return width > 4 && height > 4 ? { left, top, width, height } : null;
  }

  async function terminate() {
    try { if (mainWorker) await mainWorker.terminate(); if (digitWorker) await digitWorker.terminate(); } catch (e) { /* ignore */ }
    mainWorker = digitWorker = null; initPromise = null;
  }

  root.PXOcr = { init, recognize, terminate, imageSize };
})(typeof self !== 'undefined' ? self : this);
