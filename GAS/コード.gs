/**
 * 統一地方選 資料入力（試作）
 *
 * 画面の操作は web/index.html。台帳へつなぐ手順は GAS作成手順.md。
 *
 * このファイルは、スプレッドシートの Apps Script に貼る。
 * 初期セットアップで次のシートを作る。
 *   資料一覧 / 確認事項 / 入力内容 / 項目マスタ
 */

var SHEET = {
  files: '資料一覧',
  pins: '確認事項',
  rows: '入力内容',
  master: '項目マスタ'
};

var FILE_HEADERS = ['状態', 'ファイル名', 'ページ数', '確認事項', '未反映', '入力件数', '担当A', '確認完了', '担当B', '入力完了', '指紋', '更新ミリ秒'];
var PIN_HEADERS = ['ファイル名', 'ページ', '印番号', '選管に聞くこと', '電話で確認した正しい内容', '反映', '更新者', '更新日時', '位置X', '位置Y', '印ID', '指紋'];
var ROW_HEADERS = ['ファイル名', '届出順', '項目名', '内容', '入力者', '更新日時', '行ID', '指紋'];
var MASTER_HEADERS = ['並び順', '項目名', '使う'];
var MASTERS = [
  'カナ', '年齢', '氏名', 'ふりがな', '候補者(ふりがな)氏名', '(ふりがな)通称', '通称',
  '党派', '政党名', '職業', '肩書', '性別', '生年月日', '新現元別', '住所', '本籍地',
  '選挙事務所', '選挙事務所TEL', '届出年月日'
];
var TZ = 'Asia/Tokyo';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('資料入力')
    .addItem('初期セットアップ（シートを作る）', '初期セットアップ')
    .addToUi();
}

function doGet(e) {
  var mode = (e && e.parameter && e.parameter.mode) === 'b' ? 'b' : 'a';
  var t = HtmlService.createTemplateFromFile('画面');
  t.mode = mode;
  return t.evaluate()
    .setTitle(mode === 'b' ? '最終版の入力' : '不足の確認')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function 初期セットアップ() {
  var ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, SHEET.files, FILE_HEADERS);
  ensureSheet_(ss, SHEET.pins, PIN_HEADERS);
  ensureSheet_(ss, SHEET.rows, ROW_HEADERS);
  var master = ensureSheet_(ss, SHEET.master, MASTER_HEADERS);
  if (master.getLastRow() < 2) {
    var values = MASTERS.map(function (name, i) { return [i + 1, name, '使う']; });
    master.getRange(2, 1, values.length, 3).setValues(values);
  }
  ss.toast('シートを用意しました');
}

function loadState(payload) {
  var hash = payload && payload.hash;
  if (!hash) return { error: 'ファイルが指定されていません' };
  var ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(SHEET.files)) return { error: '初期セットアップが必要です' };
  return {
    file: readFile_(hash),
    pins: readPins_(hash),
    rows: readRows_(hash),
    masters: readMasters_()
  };
}

function saveA(payload) {
  return withLock_(function () {
    var existing = readFile_(payload.hash);
    var blocked = blockA_(existing, payload.name);
    if (blocked) throw new Error(blocked);
    var now = Date.now();
    var status = payload.status === '確認完了' ? '確認完了' : '確認の途中';
    writeFile_({
      status: status,
      fileName: payload.fileName,
      pageCount: payload.pageCount || (existing && existing.pageCount) || '',
      pins: payload.pins || [],
      rows: existing ? readRows_(payload.hash) : [],
      aName: payload.name,
      aDoneAt: status === '確認完了' ? format_(now) : (existing && existing.aDoneAt) || '',
      bName: existing ? existing.bName : '',
      bDoneAt: existing ? existing.bDoneAt : '',
      hash: payload.hash,
      updatedAt: now
    });
    replacePins_(payload.hash, payload.fileName, payload.name, payload.pins || [], now);
    return { ok: true, updatedAt: now };
  });
}

function saveB(payload) {
  return withLock_(function () {
    var existing = readFile_(payload.hash);
    var blocked = blockB_(existing, payload.name);
    if (blocked) throw new Error(blocked);
    var now = Date.now();
    var status = payload.status === '入力完了' ? '入力完了' : '入力の途中';
    var pins = readPins_(payload.hash);
    var reflected = {};
    (payload.pins || []).forEach(function (pin) { reflected[pin.id] = !!pin.reflected; });
    pins.forEach(function (pin) {
      if (Object.prototype.hasOwnProperty.call(reflected, pin.id)) pin.reflected = reflected[pin.id];
    });
    writeFile_({
      status: status,
      fileName: existing.fileName,
      pageCount: existing.pageCount,
      pins: pins,
      rows: payload.rows || [],
      aName: existing.aName,
      aDoneAt: existing.aDoneAt,
      bName: payload.name,
      bDoneAt: status === '入力完了' ? format_(now) : (existing.bDoneAt || ''),
      hash: payload.hash,
      updatedAt: now
    });
    replacePins_(payload.hash, existing.fileName, payload.name, pins, now);
    replaceRows_(payload.hash, existing.fileName, payload.name, payload.rows || [], now);
    return { ok: true, updatedAt: now };
  });
}

function blockA_(file, name) {
  if (!file) return '';
  if (file.status === '確認完了' || file.status === '入力の途中' || file.status === '入力完了') {
    return '確認完了です。このファイルは入力担当が開きます。';
  }
  if (file.status === '確認の途中' && file.aName && file.aName !== name) {
    return file.aName + 'さんが作業中です';
  }
  return '';
}

function blockB_(file, name) {
  if (!file || file.status === '未着手' || file.status === '確認の途中') return '確認が終わっていません';
  if (file.status === '入力完了') return '入力完了です';
  if (file.status === '入力の途中' && file.bName && file.bName !== name) return file.bName + 'さんが作業中です';
  return '';
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); }
  finally { lock.releaseLock(); }
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('初期セットアップが必要です');
  return sh;
}

function rowsOf_(sh) {
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(String);
  return values.slice(1).filter(function (row) { return row.join('') !== ''; }).map(function (row) {
    var obj = {};
    headers.forEach(function (header, i) { obj[header] = row[i]; });
    return obj;
  });
}

function readFile_(hash) {
  var found = rowsOf_(sheet_(SHEET.files)).filter(function (row) { return row['指紋'] === hash; })[0];
  if (!found) return null;
  return {
    status: found['状態'],
    fileName: found['ファイル名'],
    pageCount: found['ページ数'],
    aName: found['担当A'],
    aDoneAt: found['確認完了'],
    bName: found['担当B'],
    bDoneAt: found['入力完了'],
    hash: found['指紋'],
    updatedAt: Number(found['更新ミリ秒']) || 0
  };
}

function readPins_(hash) {
  return rowsOf_(sheet_(SHEET.pins)).filter(function (row) { return row['指紋'] === hash; }).map(function (row) {
    return {
      id: String(row['印ID']),
      no: Number(row['印番号']),
      page: Number(row['ページ']),
      x: Number(row['位置X']),
      y: Number(row['位置Y']),
      question: String(row['選管に聞くこと'] || ''),
      answer: String(row['電話で確認した正しい内容'] || ''),
      reflected: row['反映'] === true || row['反映'] === 'TRUE' || row['反映'] === '反映'
    };
  });
}

function readRows_(hash) {
  return rowsOf_(sheet_(SHEET.rows)).filter(function (row) { return row['指紋'] === hash; }).map(function (row) {
    return {
      id: String(row['行ID']),
      order: Number(row['届出順']),
      field: String(row['項目名'] || ''),
      value: String(row['内容'] || '')
    };
  });
}

function readMasters_() {
  return rowsOf_(sheet_(SHEET.master)).filter(function (row) {
    return row['使う'] === true || row['使う'] === '使う' || row['使う'] === 'TRUE';
  }).map(function (row) { return String(row['項目名']); });
}

function writeFile_(file) {
  var sh = sheet_(SHEET.files);
  var rows = rowsOf_(sh);
  var pins = file.pins || [];
  var rowCount = (file.rows || []).length;
  var unreflected = pins.filter(function (pin) { return !pin.reflected; }).length;
  var line = [
    file.status,
    file.fileName,
    file.pageCount,
    pins.length,
    unreflected,
    rowCount,
    file.aName,
    file.aDoneAt,
    file.bName,
    file.bDoneAt,
    file.hash,
    file.updatedAt
  ];
  var index = -1;
  rows.forEach(function (row, i) { if (row['指紋'] === file.hash) index = i; });
  if (index === -1) sh.appendRow(line);
  else sh.getRange(index + 2, 1, 1, line.length).setValues([line]);
}

function replacePins_(hash, fileName, name, pins, now) {
  rewrite_(sheet_(SHEET.pins), '指紋', hash, pins.map(function (pin) {
    return [
      fileName,
      pin.page,
      pin.no,
      pin.question || '',
      pin.answer || '',
      pin.reflected ? '反映' : '',
      name,
      format_(now),
      pin.x,
      pin.y,
      pin.id,
      hash
    ];
  }));
}

function replaceRows_(hash, fileName, name, rows, now) {
  rewrite_(sheet_(SHEET.rows), '指紋', hash, rows.map(function (row) {
    return [fileName, row.order, row.field || '', row.value || '', name, format_(now), row.id, hash];
  }));
}

function rewrite_(sh, key, hash, lines) {
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(String);
  var keyIndex = headers.indexOf(key);
  var kept = values.slice(1).filter(function (row) { return String(row[keyIndex]) !== hash && row.join('') !== ''; });
  var next = [headers].concat(kept).concat(lines);
  sh.clearContents();
  sh.getRange(1, 1, next.length, headers.length).setValues(next.map(function (row) {
    var padded = headers.map(function (_, i) { return row[i] === undefined || row[i] === null ? '' : row[i]; });
    return padded;
  }));
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function format_(ms) {
  return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd HH:mm');
}
