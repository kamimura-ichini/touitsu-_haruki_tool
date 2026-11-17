const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pdf = fs.readFileSync(path.join(root, 'web/lib/pdf.min.js'), 'utf8');
const worker = JSON.stringify(fs.readFileSync(path.join(root, 'web/lib/pdf.worker.min.js'), 'utf8'));
const app = fs.readFileSync(path.join(root, 'web/アプリ.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const style = index.slice(index.indexOf('<style>'), index.indexOf('</style>') + 8);
const body = index.slice(index.indexOf('<body>') + 6, index.indexOf('<script src="lib/pdf.min.js">'));
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>資料入力</title>
${style}
</head>
<body>
${body}
<script>
${pdf}
</script>
<script>
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([${worker}], {type:'text/javascript'}));
window.APP_MODE = '<?!= mode ?>';
window.HAS_GAS = typeof google !== 'undefined' && google.script && google.script.run;
</script>
<script>
${app}
</script>
</body>
</html>
`;
const out = path.join(__dirname, '画面.html');
fs.writeFileSync(out, html);
console.log('wrote', out, html.length);
