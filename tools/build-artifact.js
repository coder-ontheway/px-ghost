// 產生單一 HTML（CSS 與 JS 內嵌）給 claude.ai Artifact 發布用；辨識引擎與語言模型仍放在 vendor/ 旁邊。
// 用法：node tools/build-artifact.js <輸出資料夾>
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const out = process.argv[2] || path.join(root, 'dist-artifact');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const inlineJs = (src) => { const s = read(src); if (/<\/script/i.test(s)) throw new Error(src + ' contains </script>'); return '<script>/* ' + src + ' */\n' + s + '\n</script>'; };
const head = html.match(/<title>[\s\S]*?(?=<link rel="stylesheet" href="app.css">)/)[0];
const page = head.trim() + '\n<style>\n' + read('app.css') + '\n</style>\n' +
  '<div id="app"><main><p>載入中…</p></main></div>\n' + scripts.map(inlineJs).join('\n') + '\n';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'page.html'), page);
fs.cpSync(path.join(root, 'vendor'), path.join(out, 'vendor'), { recursive: true });
console.log('wrote', path.join(out, 'page.html'), (page.length / 1024).toFixed(0) + ' KB');
