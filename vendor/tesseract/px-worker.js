// 包一層 Tesseract 的 worker：語言模型以 base64 文字檔存放（部分網頁空間只允許文字等常見格式），
// 這裡把模型的下載改成讀 .b64.txt 再還原成原本的二進位資料。
(function () {
  'use strict';
  var origFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    var url = String(input && input.url ? input.url : input);
    if (!/\.traineddata(\.gz)?$/.test(url)) return origFetch(input, init);
    return origFetch(url + '.b64.txt', init).then(function (r) {
      if (!r.ok) return r;
      return r.text().then(function (t) {
        var bin = atob(t.replace(/\s/g, ''));
        var a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return new Response(a, { status: 200 });
      });
    });
  };
  importScripts('worker.min.js');
})();
