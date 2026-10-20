/*
 * IndexedDB 存取層。資料只存在這支手機這個瀏覽器（或 App 內的網頁）裡。
 * 資料表：transactions（交易）、items（商品明細列）、products（商品資料庫）、images（來源截圖）、meta（設定）
 */
(function (root) {
  'use strict';
  const DB_NAME = 'px-ghost';
  const DB_VERSION = 1;
  const STORES = ['transactions', 'items', 'products', 'images', 'meta'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    const p = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('items')) {
          const s = db.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('txnId', 'txnId');
          s.createIndex('productId', 'productId');
        }
        if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) {
          const s = db.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('txnId', 'txnId');
          s.createIndex('hash', 'hash');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // iPhone Safari 在網頁切到背景（例如打開相簿選截圖）後可能關閉連線；關閉後下次使用時重新開啟
        db.onclose = () => { if (dbp === p) dbp = null; };
        db.onversionchange = () => { db.close(); if (dbp === p) dbp = null; };
        p.db = db;
        resolve(db);
      };
      req.onerror = () => { if (dbp === p) dbp = null; reject(req.error); };
      req.onblocked = () => { if (dbp === p) dbp = null; reject(new Error('資料庫被其他分頁占用，請關閉其他分頁後重新整理')); };
    });
    dbp = p;
    return dbp;
  }

  function isClosed(e) {
    return e && (e.name === 'InvalidStateError' || /closing|closed|connection is lost|Connection to Indexed Database server lost/i.test(e.message || ''));
  }
  // 執行一次資料庫操作；遇到「連線已關閉」就重新開啟資料庫再試一次
  async function run(fn) {
    const p = open();
    try { return await fn(await p); } catch (e) {
      // 連線已關閉，或寫到一半連線被關閉（交易被中止）→ 重新開啟後再試一次
      if (!isClosed(e) && dbp === p) throw e;
      try { if (p.db) p.db.close(); } catch (x) { /* ignore */ }
      if (dbp === p) dbp = null;
      return fn(await open());
    }
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('寫入被中止（可能是儲存空間不足）'));
    });
  }

  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

  function getAll(store) {
    return run((db) => reqP(db.transaction(store).objectStore(store).getAll()));
  }
  function get(store, key) {
    return run((db) => reqP(db.transaction(store).objectStore(store).get(key)));
  }
  function byIndex(store, index, value) {
    return run((db) => reqP(db.transaction(store).objectStore(store).index(index).getAll(value)));
  }

  /*
   * 一次寫入多個資料表（同一個交易，全部成功或全部失敗）
   * ops: { put: { store: [records] }, del: { store: [keys] } }
   */
  function write(ops) {
    const names = Array.from(new Set(Object.keys(ops.put || {}).concat(Object.keys(ops.del || {}))));
    if (!names.length) return Promise.resolve();
    return run((db) => {
      const tx = db.transaction(names, 'readwrite');
      // 先刪後寫：同一個 id 同時出現在刪除與寫入時，保留寫入的新資料
      for (const [s, keys] of Object.entries(ops.del || {})) for (const k of keys) tx.objectStore(s).delete(k);
      for (const [s, recs] of Object.entries(ops.put || {})) for (const r of recs) tx.objectStore(s).put(r);
      return done(tx);
    });
  }

  function clear(stores) {
    stores = stores || STORES;
    return run((db) => {
      const tx = db.transaction(stores, 'readwrite');
      stores.forEach((s) => tx.objectStore(s).clear());
      return done(tx);
    });
  }

  async function getMeta(key, fallback) {
    try { const r = await get('meta', key); return r ? r.value : fallback; } catch (e) { return fallback; }
  }
  function setMeta(key, value) { return write({ put: { meta: [{ key, value }] } }); }

  async function storageInfo() {
    const info = { persisted: null, usage: null, quota: null };
    try {
      if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        info.usage = e.usage; info.quota = e.quota;
      }
    } catch (e) { /* 部分瀏覽器不支援 */ }
    return info;
  }
  async function requestPersist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch (e) { return null; }
  }

  root.PXDB = { open, getAll, get, byIndex, write, clear, getMeta, setMeta, storageInfo, requestPersist, STORES };
})(typeof self !== 'undefined' ? self : this);
