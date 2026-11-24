(function () {
  'use strict';

  var MASTERS = [
    'カナ', '年齢', '氏名', 'ふりがな', '候補者(ふりがな)氏名', '(ふりがな)通称', '通称',
    '党派', '政党名', '職業', '肩書', '性別', '生年月日', '新現元', '新現元別', '住所', '本籍地',
    '選挙事務所', '選挙事務所TEL', '届出年月日',
    '届け出番号', '通称（氏）', '通称（名）', 'ふりがな（氏）', 'ふりがな（名）', '政党', '肩書'
  ];
  var FIXED_FIELDS = [
    '届け出番号', '通称（氏）', '通称（名）', 'ふりがな（氏）', 'ふりがな（名）', '性別',
    '政党', '職業', '生年月日', '新現元', '年齢'
  ];
  var BULK_FIELDS = ['ふりがな', '年齢', '性別', '政党', '届け出番号', '新現元', '肩書'];
  var REMOVED_FIELDS = ['届け出年月日', '候補者名', 'ふりがな', '通称（ふりがな）'];
  var PLACEHOLDERS = {
    '届け出番号': '1',
    '通称（氏）': '山田',
    '通称（名）': '太郎',
    'ふりがな（氏）': 'ヤマダ',
    'ふりがな（名）': 'タロウ',
    '職業': '会社員',
    '生年月日': '昭和30年11月1日',
    '年齢': '47',
    '肩書': '市長'
  };
  var DEFAULT_CANDIDATE_SLOTS = 10;
  var VALUE_CHOICES = {
    '性別': [
      { value: '男', label: '男' },
      { value: '女', label: '女' },
      { value: '', label: '空白' }
    ],
    '新現元': ['', '新', '現', '元', '前']
  };
  var ERAS = [
    { name: '令和', short: 'R', start: 2019 },
    { name: '平成', short: 'H', start: 1989 },
    { name: '昭和', short: 'S', start: 1926 },
    { name: '大正', short: 'T', start: 1912 },
    { name: '明治', short: 'M', start: 1868 }
  ];
  var STORE_KEY = 'senkyo-shisaku-v1';
  var NAME_KEY = 'senkyo-shisaku-name';

  var mode = window.APP_MODE === 'b' ? 'b' : 'a';
  var hasGas = !!window.HAS_GAS;
  var pdfDoc = null;
  var scale = 1;
  var currentPage = 1;
  var renderToken = 0;
  var fileRec = null;
  var selectedId = null;
  var handOn = false;
  var undoStack = [];
  var locked = false;
  var gasTimer = null;
  var toastTimer = null;
  var entryFocusedFor = '';

  var $ = function (id) { return document.getElementById(id); };

  document.body.classList.add(mode === 'b' ? 'mode-b' : 'mode-a');
  document.title = mode === 'b'
    ? '立候補者情報の入力（パンチャー入力）'
    : '選管への確認（電話・赤入れツール）';
  $('modeLabel').textContent = mode === 'b'
    ? '【立候補者情報の入力｜パンチャー入力】'
    : '【選管への確認｜電話・赤入れツール】';
  (mode === 'b' ? $('linkB') : $('linkA')).classList.add('current');
  $('linkA').href = modeHref('a');
  $('linkB').href = modeHref('b');
  $('bannerText').textContent = hasGas
    ? '保存先は、このスプレッドシートの台帳です。切れている間はこのパソコンにも残します。'
    : '試作です。保存先はこのパソコンの中だけです。'
      + '先に「選管への確認」で印を書き、次に「立候補者情報の入力」で欄に入れます。';
  $('empty').textContent = '上の「PDFを開く」で資料を表示します。';

  MASTERS.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    $('masters').appendChild(opt);
  });

  $('name').value = localStorage.getItem(NAME_KEY) || '';
  $('name').addEventListener('input', function () {
    localStorage.setItem(NAME_KEY, $('name').value.trim());
  });

  $('file').addEventListener('change', function () {
    var file = $('file').files && $('file').files[0];
    if (!file) return;
    file.arrayBuffer().then(function (buf) { openBuffer(buf, file.name); });
  });

  $('zoomOut').addEventListener('click', function () { scale = Math.max(0.5, scale - 0.15); renderPage(); });
  $('zoomIn').addEventListener('click', function () { scale = Math.min(2.5, scale + 0.15); renderPage(); });
  $('rotate').addEventListener('click', function () {
    if (!pdfDoc || !fileRec) return;
    fileRec.rotation = (addedRotation() + 90) % 360;
    writeStoreFile();
    fitScale().then(renderPage);
  });
  $('toastUndo').addEventListener('click', function () { hideToast(); undo(); });
  $('saveBtn').addEventListener('click', function () { persist(true); });
  $('completeA').addEventListener('click', openAPreview);
  $('aPreviewBack').addEventListener('click', function () { $('aPreview').hidden = true; });
  $('aPreviewDone').addEventListener('click', completeA);
  $('resetPanels').addEventListener('click', resetPanels);
  $('formMin').addEventListener('click', function (ev) {
    ev.stopPropagation();
    var panel = $('formPanel');
    var closed = panel.classList.toggle('minimized');
    $('formMin').textContent = closed ? '＋' : 'ー';
  });
  $('hand').addEventListener('click', function () {
    handOn = !handOn;
    $('hand').classList.toggle('on', handOn);
    document.body.classList.toggle('hand-on', handOn);
  });
  $('memoBtn').addEventListener('click', openMemo);
  $('closeMemo').addEventListener('click', function () { $('memoPanel').hidden = true; });
  $('memoText').addEventListener('input', function () {
    if (!fileRec || mode !== 'a' || locked) return;
    fileRec.memo = $('memoText').value;
    markEditing();
    persist();
    renderMemo();
  });
  $('electionDate').addEventListener('change', function () {
    if (!fileRec || mode !== 'a' || locked) {
      $('electionDate').value = fileRec && fileRec.electionDate ? fileRec.electionDate : '';
      return;
    }
    fileRec.electionDate = $('electionDate').value;
    fileRec.electionDefaulted = true;
    markEditing();
    persist();
    refreshAges();
  });
  $('reviewBtn').addEventListener('click', function () {
    if (!ensureFile()) {
      if (!fileRec) showToast('PDFを開いてください');
      return;
    }
    document.body.classList.remove('collapsed');
    document.body.classList.add('reviewing');
    $('review').hidden = false;
    $('bulkPanel').hidden = true;
    $('formPanel').classList.remove('minimized');
    $('formMin').textContent = 'ー';
    $('formHeadText').textContent = '入力内容の確認';
    $('formPanel').scrollTop = 0;
    renderReview();
  });
  $('backEdit').addEventListener('click', function () {
    document.body.classList.remove('reviewing');
    $('review').hidden = true;
    $('formHeadText').textContent = '入力欄（ドラッグで移動）';
  });
  $('completeB').addEventListener('click', completeB);
  $('addOrder').addEventListener('click', function () {
    if (!ensureFile()) return;
    var next = candidateSlotCount() + 1;
    fileRec.candidateSlots = next;
    ensureOrder(next);
    markEditing();
    persist();
    renderForm();
    var first = $('orders').querySelector('[data-order="' + next + '"] input.value');
    if (first) first.focus();
  });
  setupPanel();
  $('resetOrder').addEventListener('click', resetOrders);
  $('closeCard').addEventListener('click', function () { $('card').hidden = true; });
  $('deletePin').addEventListener('click', deleteSelectedPin);
  $('answer').addEventListener('focus', function () { $('answer').dataset.before = selectedPin() ? selectedPin().answer : ''; });
  $('answer').addEventListener('input', function () { onPinText('answer', $('answer')); });
  $('pinUnsure').addEventListener('change', function () {
    var pin = selectedPin();
    if (!pin || locked) {
      $('pinUnsure').checked = !!(pin && pin.unsure);
      return;
    }
    pin.unsure = $('pinUnsure').checked;
    markEditing();
    persist();
    renderPinList();
    renderChecks();
  });
  setupBulk();

  document.querySelector('.stage').addEventListener('scroll', function () {
    if (pdfDoc) updatePageLabel();
  });
  bindHand();

  $('pages').addEventListener('click', function (ev) {
    if (handOn || mode !== 'a' || locked || !fileRec) return;
    var layer = ev.target.closest ? ev.target.closest('.pinLayer') : null;
    if (!layer || ev.target !== layer) return;
    if (!requireName()) return;
    var pageNo = Number(layer.dataset.page);
    var canvas = layer.parentNode.querySelector('canvas');
    var pos = toStored(eventRatio(ev, canvas));
    snapshot();
    var pin = {
      id: uid(),
      no: nextNo(),
      page: pageNo,
      x: pos.x,
      y: pos.y,
      question: '',
      answer: '',
      unsure: false,
      reflected: false
    };
    fileRec.pins.push(pin);
    markEditing();
    persist();
    drawPins();
    renderPinList();
    openCard(pin, ev.clientX, ev.clientY);
  });

  dragCard();

  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      ev.preventDefault();
      undo();
    }
  });

  function requireName() {
    if ($('name').value.trim()) return true;
    showToast('名前を入れてください');
    $('name').focus();
    return false;
  }

  function ensureFile() {
    if (locked || !fileRec) return false;
    return requireName();
  }

  function openBuffer(buf, fileName) {
    sha256(buf).then(function (hash) {
      return pdfjsLib.getDocument({
        data: new Uint8Array(buf),
        cMapUrl: new URL('lib/cmaps/', location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('lib/standard_fonts/', location.href).href
      }).promise.then(function (doc) {
        return { hash: hash, doc: doc };
      });
    }).then(function (opened) {
      pdfDoc = opened.doc;
      fileRec = takeFile(opened.hash, fileName, pdfDoc.numPages);
      migrateRowFields();
      if (ensureElectionDate()) writeStoreFile();
      undoStack = readUndo(opened.hash);
      selectedId = null;
      locked = false;
      $('card').hidden = true;
      $('lock').hidden = true;
      document.body.classList.remove('reviewing');
      currentPage = 1;
      $('empty').hidden = true;
      $('pages').hidden = false;
      $('pager').hidden = false;
      return fitScale().then(function () {
        return maybeLoadGas().then(applyLockAndRender);
      });
    }).catch(function () {
      showToast('PDFを開けませんでした');
    });
  }

  function applyLockAndRender() {
    locked = checkLock();
    updateChrome();
    return renderPage().then(renderSide).then(function () {
      if (mode === 'b' && fileRec && String(fileRec.memo || '').trim() && !locked) openMemo();
      if (mode === 'a' && fileRec && fileRec.status === '確認完了') offerReeditA();
      if (mode === 'b' && fileRec && fileRec.status === '入力完了') offerReedit();
    });
  }

  function maybeLoadGas() {
    if (!hasGas) return Promise.resolve();
    return gas('loadState', { hash: fileRec.hash }).then(function (remote) {
      if (remote && remote.error) {
        $('bannerText').textContent = remote.error;
        return;
      }
      if (remote && remote.file && remote.file.updatedAt > (fileRec.updatedAt || 0)) {
        copyRemote(remote);
      }
    }).catch(function () {
      $('bannerText').textContent = '台帳を読めませんでした。このパソコンの内容を表示しています。';
    });
  }

  function copyRemote(remote) {
    var file = remote.file;
    fileRec.status = file.status;
    fileRec.aName = file.aName || '';
    fileRec.aDoneAt = file.aDoneAt || '';
    fileRec.bName = file.bName || '';
    fileRec.bDoneAt = file.bDoneAt || '';
    fileRec.updatedAt = file.updatedAt || 0;
    fileRec.pins = remote.pins || [];
    fileRec.rows = remote.rows || [];
    migrateRowFields();
    writeStoreFile();
  }

  function fitScale() {
    return pdfDoc.getPage(1).then(function (page) {
      var base = page.getViewport({ scale: 1, rotation: viewportRotation(page) });
      var avail = document.querySelector('.stage').clientWidth - 48;
      scale = Math.max(0.6, Math.min(2, avail / base.width));
    });
  }

  function renderPage(scrollPage) {
    var token = ++renderToken;
    var root = $('pages');
    var stage = document.querySelector('.stage');
    var max = Math.max(1, stage.scrollHeight - stage.clientHeight);
    var ratio = stage.scrollTop / max;
    root.innerHTML = '';
    function step(n) {
      if (token !== renderToken || !pdfDoc || n > pdfDoc.numPages) {
        updatePageLabel();
        if (scrollPage) scrollToPage(scrollPage);
        else stage.scrollTop = ratio * Math.max(1, stage.scrollHeight - stage.clientHeight);
        return Promise.resolve();
      }
      return renderOne(n, token, root).then(function () { return step(n + 1); });
    }
    return step(1);
  }

  function renderOne(n, token, root) {
    return pdfDoc.getPage(n).then(function (page) {
      if (token !== renderToken) return;
      var viewport = page.getViewport({ scale: scale, rotation: viewportRotation(page) });
      var wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = String(n);
      var canvas = document.createElement('canvas');
      var layer = document.createElement('div');
      layer.className = 'pinLayer';
      layer.dataset.page = String(n);
      wrap.appendChild(canvas);
      wrap.appendChild(layer);
      root.appendChild(wrap);
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
        if (token !== renderToken) return;
        drawPins(n);
        $('zoomLabel').textContent = Math.round(scale * 100) + '%';
        $('rotateLabel').textContent = addedRotation() ? addedRotation() + '°' : '';
        updatePageLabel();
      });
    });
  }

  function updatePageLabel() {
    if (!pdfDoc) return;
    var stage = document.querySelector('.stage');
    var marker = stage.getBoundingClientRect().top + ($('pager').offsetHeight || 0) + 24;
    var found = 1;
    document.querySelectorAll('.page-wrap').forEach(function (wrap) {
      if (wrap.getBoundingClientRect().top <= marker) found = Number(wrap.dataset.page);
    });
    currentPage = found || 1;
    $('pageLabel').textContent = currentPage + ' / ' + pdfDoc.numPages;
  }

  function bindHand() {
    var stage = document.querySelector('.stage');
    var drag = null;
    stage.addEventListener('pointerdown', function (ev) {
      if (!handOn || ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('button, a, input, textarea, select')) return;
      drag = { x: ev.clientX, y: ev.clientY, left: stage.scrollLeft, top: stage.scrollTop, id: ev.pointerId };
      stage.setPointerCapture(ev.pointerId);
    });
    stage.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      stage.scrollLeft = drag.left - (ev.clientX - drag.x);
      stage.scrollTop = drag.top - (ev.clientY - drag.y);
    });
    function end(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      drag = null;
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  function scrollToPage(n) {
    var stage = document.querySelector('.stage');
    var wrap = document.querySelector('.page-wrap[data-page="' + n + '"]');
    if (!stage || !wrap) return;
    var pager = $('pager').offsetHeight || 0;
    var delta = wrap.getBoundingClientRect().top - stage.getBoundingClientRect().top - pager;
    stage.scrollTop += delta;
    updatePageLabel();
  }

  function pageCanvas(pageNo) {
    var wrap = document.querySelector('.page-wrap[data-page="' + pageNo + '"]');
    return wrap ? wrap.querySelector('canvas') : null;
  }

  function drawPins(pageNo) {
    var layers = pageNo
      ? [document.querySelector('.pinLayer[data-page="' + pageNo + '"]')]
      : Array.prototype.slice.call(document.querySelectorAll('.pinLayer'));
    layers.forEach(function (layer) {
      if (!layer) return;
      var n = Number(layer.dataset.page);
      layer.innerHTML = '';
      if (!fileRec) return;
      fileRec.pins.filter(function (pin) { return pin.page === n; }).forEach(function (pin) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pin' + (pin.id === selectedId ? ' current' : '');
        btn.dataset.id = pin.id;
        var no = document.createElement('span');
        no.className = 'no';
        no.textContent = String(pin.no);
        btn.appendChild(no);
        var view = toView(pin.x, pin.y);
        btn.style.left = (view.x * 100) + '%';
        btn.style.top = (view.y * 100) + '%';
        btn.title = pin.answer || (pin.unsure ? '入力不明・不安' : '');
        layer.appendChild(btn);
        bindPin(btn, pin);
      });
    });
  }

  function bindPin(btn, pin) {
    var startX = 0;
    var startY = 0;
    var dragging = false;
    var snapped = false;
    btn.addEventListener('pointerdown', function (ev) {
      if (handOn || locked) return;
      ev.stopPropagation();
      if (mode !== 'a') return;
      startX = ev.clientX;
      startY = ev.clientY;
      dragging = false;
      snapped = false;
      function move(e) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        dragging = true;
        if (!snapped) { snapshot(); snapped = true; }
        var canvas = pageCanvas(pin.page);
        if (!canvas) return;
        var view = eventRatio(e, canvas);
        var pos = toStored(view);
        pin.x = pos.x;
        pin.y = pos.y;
        btn.style.left = (view.x * 100) + '%';
        btn.style.top = (view.y * 100) + '%';
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (dragging) {
          markEditing();
          persist();
        }
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (handOn || dragging) { dragging = false; return; }
      selectedId = pin.id;
      if (mode === 'a' && !locked) openCard(pin, ev.clientX, ev.clientY);
      else focusPin(pin);
      drawPins();
      renderSide();
    });
  }

  function focusPin(pin) {
    selectedId = pin.id;
    currentPage = pin.page;
    scrollToPage(pin.page);
    flash(pin);
    var row = document.querySelector('[data-pin="' + pin.id + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function flash(pin) {
    document.querySelectorAll('.pin').forEach(function (el) {
      el.classList.toggle('current', el.dataset.id === pin.id);
    });
    var el = document.querySelector('.pin[data-id="' + pin.id + '"]');
    if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
  }

  function openCard(pin, x, y) {
    selectedId = pin.id;
    $('card').hidden = false;
    $('cardTitle').textContent = '印 ' + pin.no;
    $('answer').value = pin.answer || '';
    $('pinUnsure').checked = !!pin.unsure;
    $('pinUnsure').disabled = locked;
    if (x != null) placeCard(x + 16, y + 16);
    else if (!$('card').style.left) placeCard(24, 80);
    $('answer').focus();
  }

  function placeCard(left, top) {
    var card = $('card');
    var maxL = window.innerWidth - 300;
    var maxT = window.innerHeight - 80;
    card.style.left = Math.max(8, Math.min(maxL, left)) + 'px';
    card.style.top = Math.max(8, Math.min(maxT, top)) + 'px';
  }

  function dragCard() {
    var handle = $('cardHandle');
    handle.addEventListener('pointerdown', function (ev) {
      var card = $('card');
      var rect = card.getBoundingClientRect();
      var dx = ev.clientX - rect.left;
      var dy = ev.clientY - rect.top;
      function move(e) { placeCard(e.clientX - dx, e.clientY - dy); }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function onPinText(key, el) {
    var pin = selectedPin();
    if (!pin || locked) return;
    if (pin[key] && !el.value && el.dataset.before) {
      snapshot();
      el.dataset.before = '';
    }
    pin[key] = el.value;
    markEditing();
    persist();
    renderPinList();
  }

  function deleteSelectedPin() {
    var pin = selectedPin();
    if (!pin || locked) return;
    snapshot();
    fileRec.pins = fileRec.pins.filter(function (p) { return p.id !== pin.id; });
    selectedId = null;
    $('card').hidden = true;
    markEditing();
    persist();
    drawPins();
    renderPinList();
    showToast('消しました');
  }

  function selectedPin() {
    if (!fileRec || !selectedId) return null;
    return fileRec.pins.filter(function (p) { return p.id === selectedId; })[0] || null;
  }

  function renderSide() {
    renderPinList();
    renderChecks();
    renderMemo();
    renderForm();
    if (document.body.classList.contains('reviewing')) renderReview();
    paintBulkButtons();
    updateChrome();
    focusEntryStart();
  }

  function renderPinList() {
    var body = $('pinListBody');
    body.innerHTML = '';
    if (!fileRec || !fileRec.pins.length) {
      body.appendChild(note('場所をクリックすると印が付きます'));
      return;
    }
    fileRec.pins.forEach(function (pin) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pinrow' + (pin.id === selectedId ? ' current' : '');
      btn.dataset.pin = pin.id;
      var title = document.createElement('b');
      title.textContent = pin.no + '  p' + pin.page;
      var small = document.createElement('small');
      small.textContent = (pin.answer || '（空）') + (pin.unsure ? '  入力不明・不安' : '');
      btn.appendChild(title);
      btn.appendChild(small);
      btn.addEventListener('click', function () {
        selectedId = pin.id;
        currentPage = pin.page;
        scrollToPage(pin.page);
        openCard(pin);
        drawPins();
        renderPinList();
      });
      body.appendChild(btn);
    });
  }

  function renderChecks() {
    var body = $('checkBody');
    body.innerHTML = '';
    if (!fileRec || !fileRec.pins.length) {
      body.appendChild(note('確認事項はありません'));
      return;
    }
    fileRec.pins.forEach(function (pin) {
      var wrap = document.createElement('div');
      wrap.className = 'checkrow' + (pin.id === selectedId ? ' current' : '');
      wrap.dataset.pin = pin.id;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pinrow';
      var title = document.createElement('b');
      title.textContent = pin.no + '  p' + pin.page;
      var answer = document.createElement('div');
      answer.className = 'right-answer';
      answer.textContent = pin.answer || '（空）';
      btn.appendChild(title);
      btn.appendChild(answer);
      if (pin.unsure) {
        var small = document.createElement('small');
        small.textContent = '入力不明・不安';
        btn.appendChild(small);
      }
      btn.addEventListener('click', function () {
        selectedId = pin.id;
        focusPin(pin);
        renderChecks();
      });
      var label = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!pin.reflected;
      box.disabled = locked;
      box.addEventListener('change', function () {
        if (!ensureFile()) { box.checked = !!pin.reflected; return; }
        pin.reflected = box.checked;
        markEditing();
        persist();
        updateChrome();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(' 反映した'));
      wrap.appendChild(btn);
      wrap.appendChild(label);
      body.appendChild(wrap);
    });
  }

  function renderForm() {
    var root = $('orders');
    var focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.row : '';
    var focusPart = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.part : '';
    if (mode === 'b' && fileRec && !locked) {
      var added = false;
      orders().forEach(function (order) { if (ensureOrder(order)) added = true; });
      if (added) persist();
    }
    root.innerHTML = '';
    orders().forEach(function (order) {
      var box = document.createElement('div');
      box.className = 'order';
      box.dataset.order = String(order);
      var heading = document.createElement('div');
      heading.textContent = '候補者 ' + order;
      heading.style.fontWeight = '700';
      heading.style.marginBottom = '8px';
      box.appendChild(heading);
      orderedRows(order).forEach(function (row) {
        box.appendChild(rowLine(row));
      });
      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = '＋項目枠を追加';
      add.addEventListener('click', function () { addRow(order, true); });
      box.appendChild(add);
      root.appendChild(box);
    });
    if (focus) {
      var el = root.querySelector('[data-row="' + focus + '"][data-part="' + focusPart + '"]');
      if (el) el.focus();
    }
  }

  function rowLine(row) {
    var line = document.createElement('div');
    var inputs = document.createElement('div');
    inputs.className = 'rowline';
    var field;
    if (row.fixed) {
      field = document.createElement('div');
      field.className = 'name';
      field.textContent = row.field;
    } else {
      field = document.createElement('select');
      field.className = 'field';
      field.dataset.row = row.id;
      field.dataset.part = 'field';
      var names = MASTERS.slice();
      if (row.field && names.indexOf(row.field) === -1) names.unshift(row.field);
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '項目名を選択';
      field.appendChild(blank);
      names.forEach(function (name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        field.appendChild(opt);
      });
      field.value = row.field || '';
      field.addEventListener('change', function () {
        row.field = field.value;
        if (row.field === '年齢') row.manual = false;
        markEditing();
        persist();
        renderForm();
      });
    }
    var value = buildValueControl(row);
    var del = null;
    if (!row.fixed) {
      del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.addEventListener('click', function () {
        snapshot();
        fileRec.rows = fileRec.rows.filter(function (r) { return r.id !== row.id; });
        markEditing();
        persist();
        renderForm();
        showToast('消しました');
      });
    }
    var unsure = document.createElement('label');
    unsure.className = 'unsure';
    var unsureBox = document.createElement('input');
    unsureBox.type = 'checkbox';
    unsureBox.checked = !!row.unsure;
    unsureBox.disabled = locked;
    unsureBox.dataset.row = row.id;
    unsureBox.addEventListener('change', function () {
      row.unsure = unsureBox.checked;
      markEditing();
      persist();
      reflectBulkUnsure(row);
    });
    unsure.appendChild(unsureBox);
    unsure.appendChild(document.createTextNode('入力不明・不安'));
    inputs.appendChild(field);
    inputs.appendChild(value);
    var basis = null;
    if (row.field === '年齢') {
      basis = document.createElement('span');
      basis.className = 'age-basis';
      basis.dataset.ageBasis = row.id;
      inputs.appendChild(basis);
    }
    inputs.appendChild(unsure);
    if (del) inputs.appendChild(del);
    line.appendChild(inputs);
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.hidden = true;
    line.appendChild(hint);
    updateDup(line, row);
    if (row.field === '年齢') {
      var ageHint = document.createElement('div');
      ageHint.className = 'hint';
      ageHint.dataset.ageHint = row.id;
      line.appendChild(ageHint);
      updateAgeHint(row, ageHint, basis);
    }
    return line;
  }

  function buildValueControl(row) {
    var choices = VALUE_CHOICES[row.field];
    if (!choices) {
      var input = document.createElement('input');
      input.className = 'value';
      input.type = 'text';
      input.value = row.value || '';
      input.placeholder = PLACEHOLDERS[row.field] || '例';
      tagValue(input, row);
      input.addEventListener('focus', function () { input.dataset.before = row.value || ''; });
      if (isFurigana(row.field)) {
        bindKanaInput(input, function () {
          var next = katakanaOnly(input.value);
          if (input.value !== next) input.value = next;
          clearIfEmptied(row, 'value', input);
          commitRowValue(row, input.value);
        });
      } else {
        input.addEventListener('input', function () {
          if (row.field === '年齢') input.value = digitsOnly(input.value);
          clearIfEmptied(row, 'value', input);
          commitRowValue(row, input.value);
        });
      }
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        focusNextRow(row);
      });
      return input;
    }
    var wrap = document.createElement('div');
    wrap.className = 'radios value';
    tagValue(wrap, row);
    choiceList(choices, row.value).forEach(function (choice) {
      var value = choiceValue(choice);
      wrap.appendChild(radioLabel('choice-' + row.id, value, choiceLabel(choice), row.value === value, function () {
        commitRowValue(row, value);
      }, function () { focusNextRow(row); }));
    });
    return wrap;
  }

  function tagValue(el, row) {
    el.dataset.row = row.id;
    el.dataset.part = 'value';
    el.dataset.order = String(row.order);
  }

  function isFurigana(field) {
    return field === 'ふりがな（氏）' || field === 'ふりがな（名）';
  }

  function digitsOnly(text) {
    return String(text || '').replace(/[０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/\D/g, '');
  }

  function katakanaOnly(text) {
    return String(text || '').replace(/[ぁ-ゖ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    }).replace(/[^ァ-ヶー・]/g, '');
  }

  function bindKanaInput(input, apply) {
    input.lang = 'ja';
    input.addEventListener('compositionstart', function () { input.dataset.composing = '1'; });
    input.addEventListener('compositionend', function () {
      input.dataset.composing = '';
      apply();
    });
    input.addEventListener('input', function (ev) {
      if (ev.isComposing || input.dataset.composing) return;
      apply();
    });
  }

  function choiceValue(choice) {
    return choice && typeof choice === 'object' ? choice.value : choice;
  }

  function choiceLabel(choice) {
    if (choice && typeof choice === 'object') return choice.label;
    return choice === '' ? '空白' : choice;
  }

  function choiceList(choices, current) {
    var list = choices.filter(function (choice) { return choice !== ''; });
    var known = list.map(choiceValue);
    if (current && known.indexOf(current) === -1) list.push(current);
    return list;
  }

  function radioLabel(name, value, label, checked, onPick, onEnter, forceDisabled) {
    var wrap = document.createElement('label');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = value;
    radio.checked = !!checked;
    radio.disabled = locked || !!forceDisabled;
    radio.addEventListener('change', function () {
      if (radio.checked) onPick();
    });
    radio.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      onEnter();
    });
    wrap.appendChild(radio);
    wrap.appendChild(document.createTextNode(label));
    return wrap;
  }

  function commitRowValue(row, next) {
    row.value = next;
    if (row.field === '性別') row.genderDefaulted = true;
    if (row.field === '年齢') row.manual = !!String(next || '').trim();
    markEditing();
    persist();
    if (row.field === '生年月日' || (row.field === '年齢' && !row.manual)) syncAge(row.order);
    if (row.field === '年齢') updateAgeHint(row);
    reflectBulk(row);
    paintBulkButtons();
  }

  function focusNextRow(row) {
    var same = orderedRows(row.order);
    var idx = same.findIndex(function (item) { return item.id === row.id; });
    if (idx === same.length - 1) {
      if (!row.fixed) addRow(row.order, true);
      return;
    }
    focusValue(document.querySelector('[data-row="' + same[idx + 1].id + '"][data-part="value"]'));
  }

  function focusValue(el) {
    if (!el) return;
    if (el.classList && el.classList.contains('radios')) {
      var radio = el.querySelector('input:checked') || el.querySelector('input');
      if (radio) radio.focus();
      return;
    }
    el.focus();
  }

  function setupBulk() {
    document.querySelectorAll('[data-bulk]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!ensureFile() || locked) return;
        openBulk(btn.getAttribute('data-bulk'));
      });
    });
    $('bulkClose').addEventListener('click', function () { $('bulkPanel').hidden = true; });
    dragBulk();
    dragByHeader($('aPreview'));
    dragByHeader($('memoPanel'));
  }

  function openBulk(field) {
    $('bulkTitle').textContent = '一括確認 ' + field;
    $('bulkPanel').dataset.field = field;
    $('bulkPanel').hidden = false;
    renderBulk();
    focusValue($('bulkBody').querySelector('input, .radios'));
  }

  function renderBulk() {
    var field = $('bulkPanel').dataset.field;
    var body = $('bulkBody');
    body.innerHTML = '';
    if (!field || !fileRec) return;
    var noteText = inputLimitNote(field);
    if (noteText) {
      var note = document.createElement('p');
      note.className = 'limit-note';
      note.textContent = noteText;
      body.appendChild(note);
    }
    var total = candidateSlotCount();
    for (var order = 1; order <= total; order++) body.appendChild(bulkLine(order, field));
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'bulk-add';
    add.textContent = '候補者を増やす';
    add.addEventListener('click', addCandidateSlot);
    body.appendChild(add);
  }

  function inputLimitNote(field) {
    if (field === 'ふりがな') return '全角カタカナで入力してください。';
    if (field === '年齢') return '年・月・日は半角数字で入力してください。';
    if (field === '届け出番号') return '半角数字で入力してください。';
    return '';
  }

  function addCandidateSlot() {
    if (!ensureFile() || locked) return;
    var next = candidateSlotCount() + 1;
    fileRec.candidateSlots = next;
    if (mode === 'b') ensureOrder(next);
    markEditing();
    persist();
    renderForm();
    renderBulk();
  }

  function unsureToggle(order, field, existing) {
    var label = document.createElement('label');
    label.className = 'unsure';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!(existing && existing.unsure);
    box.disabled = locked;
    box.dataset.bulkOrder = String(order);
    box.dataset.bulkField = field;
    box.addEventListener('change', function () {
      var row = ensureBulkRow(order, field);
      row.unsure = box.checked;
      markEditing();
      persist();
      reflectForm(row);
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode('入力不明・不安'));
    if (mode === 'b') box.disabled = true;
    return label;
  }

  function findBulkRow(order, field) {
    return fileRec.rows.filter(function (row) {
      return row.order === order && row.field === field;
    })[0] || null;
  }

  function ensureBulkRow(order, field) {
    var found = findBulkRow(order, field);
    if (found) {
      found.fixed = true;
      return found;
    }
    var row = { id: uid(), order: order, field: field, value: '', fixed: true };
    fileRec.rows.push(row);
    return row;
  }

  function bulkLine(order, field) {
    if (field === 'ふりがな') return furiganaBulkLine(order);
    if (field === '年齢') return ageBulkLine(order);
    var existing = findBulkRow(order, field);
    var line = document.createElement('div');
    line.className = 'bulk-row';
    var name = document.createElement('b');
    name.textContent = '候補者 ' + order;
    line.appendChild(name);
    var choices = VALUE_CHOICES[field];
    var readOnly = mode === 'b';
    if (!choices) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = existing ? (existing.value || '') : '';
      input.readOnly = readOnly;
      input.placeholder = PLACEHOLDERS[field] || '';
      input.dataset.bulkOrder = String(order);
      input.dataset.bulkField = field;
      input.addEventListener('input', function () {
        if (readOnly) return;
        if (field === '届け出番号') input.value = digitsOnly(input.value);
        var row = ensureBulkRow(order, field);
        input.dataset.row = row.id;
        commitRowValue(row, input.value);
        reflectForm(row);
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        focusValue(document.querySelector('#bulkBody [data-bulk-order="' + (order + 1) + '"]'));
      });
      line.appendChild(input);
      line.appendChild(unsureToggle(order, field, existing));
      return line;
    }
    var wrap = document.createElement('div');
    wrap.className = 'radios';
    wrap.dataset.bulkOrder = String(order);
    wrap.dataset.bulkField = field;
    var picked = existing ? existing.value : (field === '性別' ? '男' : null);
    choiceList(choices, existing ? existing.value : '').forEach(function (choice) {
      var value = choiceValue(choice);
      wrap.appendChild(radioLabel('bulk-' + field + '-' + order, value, choiceLabel(choice), picked === value && (existing || field === '性別'), function () {
        if (readOnly) return;
        var row = ensureBulkRow(order, field);
        commitRowValue(row, value);
        reflectForm(row);
      }, function () {
        focusValue(document.querySelector('#bulkBody [data-bulk-order="' + (order + 1) + '"]'));
      }, readOnly));
    });
    line.appendChild(wrap);
    line.appendChild(unsureToggle(order, field, existing));
    return line;
  }

  function furiganaBulkLine(order) {
    var line = document.createElement('div');
    line.className = 'bulk-row';
    var name = document.createElement('b');
    name.textContent = '候補者 ' + order;
    line.appendChild(name);
    var parts = document.createElement('div');
    parts.className = 'kana-parts';
    [['ふりがな（氏）', '氏', 'ヤマダ'], ['ふりがな（名）', '名', 'タロウ']].forEach(function (spec) {
      var label = document.createElement('span');
      label.textContent = spec[1];
      var input = document.createElement('input');
      input.type = 'text';
      var existing = findBulkRow(order, spec[0]);
      input.value = existing ? (existing.value || '') : '';
      input.placeholder = spec[2];
      input.readOnly = mode === 'b';
      input.dataset.bulkOrder = String(order);
      input.dataset.bulkField = spec[0];
      if (mode !== 'b') {
        bindKanaInput(input, function () {
          var next = katakanaOnly(input.value);
          if (input.value !== next) input.value = next;
          var row = ensureBulkRow(order, spec[0]);
          commitRowValue(row, input.value);
          reflectForm(row);
        });
      }
      parts.appendChild(label);
      parts.appendChild(input);
    });
    line.appendChild(parts);
    var family = findBulkRow(order, 'ふりがな（氏）');
    line.appendChild(unsureToggle(order, 'ふりがな（氏）', family));
    return line;
  }

  function ageBulkLine(order) {
    var line = document.createElement('div');
    line.className = 'bulk-row';
    var name = document.createElement('b');
    name.textContent = '候補者 ' + order;
    line.appendChild(name);
    var saved = readAgeEntry(findBulkRow(order, '生年月日'));
    var cal = document.createElement('div');
    cal.className = 'age-cal';
    cal.appendChild(ageChoice(order, 'wareki', '和暦', saved && saved.kind === 'wareki'));
    var eras = document.createElement('span');
    eras.className = 'era-picks';
    ['平成', '昭和'].forEach(function (era) {
      eras.appendChild(ageChoice(order, 'era', era, saved && saved.era === era));
    });
    cal.appendChild(eras);
    cal.appendChild(ageChoice(order, 'western', '西暦', saved && saved.kind === 'western'));
    var note = document.createElement('span');
    note.className = 'age-note';
    note.textContent = '1980～';
    cal.appendChild(note);
    line.appendChild(cal);
    var parts = document.createElement('div');
    parts.className = 'age-parts';
    ['y', 'm', 'd'].forEach(function (part, index) {
      var input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.value = saved ? saved[['y', 'm', 'd'][index]] : '';
      input.placeholder = ['年', '月', '日'][index];
      input.readOnly = mode === 'b';
      input.dataset.bulkOrder = String(order);
      input.dataset.agePart = part;
      input.addEventListener('input', function () {
        if (mode === 'b') return;
        input.value = digitsOnly(input.value);
        applyAgeParts(order);
      });
      parts.appendChild(input);
    });
    line.appendChild(parts);
    var age = findBulkRow(order, '年齢');
    var shown = document.createElement('span');
    shown.className = 'bulk-copied';
    shown.dataset.ageShown = String(order);
    shown.textContent = age && age.value ? age.value + '歳' : '';
    line.appendChild(shown);
    line.appendChild(unsureToggle(order, '年齢', age));
    return line;
  }

  function ageChoice(order, group, value, checked) {
    var label = document.createElement('label');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = group === 'era' ? 'age-era-' + order : 'age-cal-' + order;
    radio.value = value;
    radio.checked = !!checked;
    radio.disabled = mode === 'b';
    radio.dataset.bulkOrder = String(order);
    radio.dataset.ageGroup = group;
    radio.addEventListener('change', function () {
      if (mode === 'b' || !radio.checked) return;
      if (group === 'era') {
        var wareki = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="wareki"]');
        if (wareki) wareki.checked = true;
      }
      if (group === 'western') {
        document.querySelectorAll('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="era"]').forEach(function (el) {
          el.checked = false;
        });
      }
      applyAgeParts(order);
    });
    label.appendChild(radio);
    label.appendChild(document.createTextNode(value === 'wareki' ? '和暦' : value === 'western' ? '西暦' : value));
    return label;
  }

  function selectedAgeKind(order) {
    var wareki = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="wareki"]');
    var western = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="western"]');
    if (wareki && wareki.checked) return 'wareki';
    if (western && western.checked) return 'western';
    return '';
  }

  function selectedEra(order) {
    var picked = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="era"]:checked');
    return picked ? picked.value : '';
  }

  function applyAgeParts(order) {
    var boxes = ['y', 'm', 'd'].map(function (part) {
      return document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-part="' + part + '"]');
    });
    var nums = boxes.map(function (box) { return box ? digitsOnly(box.value) : ''; });
    var birth = ensureBulkRow(order, '生年月日');
    var ageRow = ensureBulkRow(order, '年齢');
    var shown = document.querySelector('[data-age-shown="' + order + '"]');
    if (!nums[0] && !nums[1] && !nums[2]) {
      birth.value = '';
      if (!ageRow.manual) ageRow.value = '';
      if (shown) shown.textContent = '';
    } else if (nums[0] && nums[1] && nums[2] && selectedAgeKind(order)) {
      var built = buildAgeDate(selectedAgeKind(order), selectedEra(order), nums[0], nums[1], nums[2]);
      if (!built) {
        if (shown) shown.textContent = selectedAgeKind(order) === 'western' ? '1980年以降' : '日付を確認';
        return;
      }
      birth.value = built.text;
      ageRow.manual = false;
      syncAge(order);
      if (shown) shown.textContent = ageRow.value ? ageRow.value + '歳' : '';
    } else {
      return;
    }
    markEditing();
    persist();
    reflectForm(birth);
    reflectForm(ageRow);
    paintBulkButtons();
  }

  function bulkRelated(openField, rowField) {
    if (openField === rowField) return true;
    if (openField === 'ふりがな' && isFurigana(rowField)) return true;
    if (openField === '年齢' && (rowField === '年齢' || rowField === '生年月日')) return true;
    return false;
  }

  function reflectBulk(row) {
    paintBulkButtons();
    var openField = $('bulkPanel').dataset.field;
    if ($('bulkPanel').hidden || !bulkRelated(openField, row.field)) return;
    reflectBulkUnsure(row);
    var text = document.querySelector('#bulkBody input[type="text"][data-bulk-order="' + row.order + '"][data-bulk-field="' + row.field + '"]');
    if (text && text !== document.activeElement && text.value !== (row.value || '')) text.value = row.value || '';
    var wrap = document.querySelector('#bulkBody .radios[data-bulk-order="' + row.order + '"][data-bulk-field="' + row.field + '"]');
    if (wrap) {
      wrap.querySelectorAll('input').forEach(function (radio) {
        radio.checked = radio.value === (row.value || '');
      });
    }
    if (row.field === '生年月日' || row.field === '年齢') reflectAgeBulk(row.order);
  }

  function reflectAgeBulk(order) {
    if ($('bulkPanel').hidden || $('bulkPanel').dataset.field !== '年齢') return;
    var saved = readAgeEntry(findBulkRow(order, '生年月日'));
    ['wareki', 'western'].forEach(function (kind) {
      var radio = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="' + kind + '"]');
      if (radio && document.activeElement !== radio) radio.checked = !!(saved && saved.kind === kind);
    });
    document.querySelectorAll('#bulkBody input[data-bulk-order="' + order + '"][data-age-group="era"]').forEach(function (radio) {
      if (document.activeElement === radio) return;
      radio.checked = !!(saved && saved.era === radio.value);
    });
    if (saved) {
      ['y', 'm', 'd'].forEach(function (part) {
        var input = document.querySelector('#bulkBody input[data-bulk-order="' + order + '"][data-age-part="' + part + '"]');
        if (!input || input === document.activeElement) return;
        input.value = saved[part];
      });
    }
    var age = findBulkRow(order, '年齢');
    var shown = document.querySelector('[data-age-shown="' + order + '"]');
    if (shown && document.activeElement && document.activeElement.dataset && document.activeElement.dataset.agePart) return;
    if (shown) shown.textContent = age && age.value ? age.value + '歳' : '';
  }

  function readAgeEntry(row) {
    var text = row ? String(row.value || '').trim() : '';
    var wareki = text.match(/^(平成|昭和)(\d+)年(\d+)月(\d+)日$/);
    if (wareki) return { kind: 'wareki', era: wareki[1], y: wareki[2], m: wareki[3], d: wareki[4] };
    var western = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
    if (western && Number(western[1]) >= 1980) return { kind: 'western', era: '', y: western[1], m: western[2], d: western[3] };
    var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso && Number(iso[1]) >= 1980) return { kind: 'western', era: '', y: iso[1], m: iso[2], d: iso[3] };
    return null;
  }

  function buildAgeDate(kind, eraName, y, m, d) {
    var month = Number(m);
    var day = Number(d);
    if (kind === 'western') {
      var year = Number(y);
      if (year < 1980) return null;
      var westernDate = makeDate(year, month, day);
      if (!westernDate) return null;
      return { text: year + '年' + month + '月' + day + '日' };
    }
    if (kind !== 'wareki' || (eraName !== '平成' && eraName !== '昭和')) return null;
    var era = ERAS.filter(function (item) { return item.name === eraName; })[0];
    var eraYear = Number(y);
    if (!era || eraYear < 1) return null;
    var dt = makeDate(era.start + eraYear - 1, month, day);
    if (!dt) return null;
    if (eraName === '昭和' && (dt < makeDate(1926, 12, 25) || dt > makeDate(1989, 1, 7))) return null;
    if (eraName === '平成' && (dt < makeDate(1989, 1, 8) || dt > makeDate(2019, 4, 30))) return null;
    return { text: eraName + eraYear + '年' + month + '月' + day + '日' };
  }

  function todayISO() {
    var now = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function ensureElectionDate() {
    if (!fileRec || fileRec.electionDate || fileRec.electionDefaulted) return false;
    fileRec.electionDate = todayISO();
    fileRec.electionDefaulted = true;
    return true;
  }

  function reflectBulkUnsure(row) {
    if ($('bulkPanel').hidden || $('bulkPanel').dataset.field !== row.field) return;
    var box = document.querySelector('#bulkBody .unsure input[data-bulk-order="' + row.order + '"][data-bulk-field="' + row.field + '"]');
    if (box) box.checked = !!row.unsure;
  }

  function reflectForm(row) {
    var text = document.querySelector('#orders input.value[data-row="' + row.id + '"]');
    if (text && text !== document.activeElement) text.value = row.value || '';
    var wrap = document.querySelector('#orders .radios[data-row="' + row.id + '"]');
    if (wrap) {
      wrap.querySelectorAll('input').forEach(function (radio) {
        radio.checked = radio.value === (row.value || '');
      });
    }
    var unsure = document.querySelector('#orders .unsure input[data-row="' + row.id + '"]');
    if (unsure) unsure.checked = !!row.unsure;
    if (row.field === '年齢') updateAgeHint(row);
  }

  function bulkStoredFields(key) {
    if (key === 'ふりがな') return ['ふりがな（氏）', 'ふりがな（名）'];
    if (key === '年齢') return ['年齢', '生年月日'];
    return [key];
  }

  function hasBulkValue() {
    if (!fileRec) return false;
    return BULK_FIELDS.some(function (key) {
      return bulkFieldHasValue(key);
    });
  }

  function bulkFieldHasValue(key) {
    var names = bulkStoredFields(key);
    return fileRec.rows.some(function (row) {
      return names.indexOf(row.field) !== -1 && String(row.value || '').trim();
    });
  }

  function paintBulkButtons() {
    paintMemoButton();
    if (!fileRec) return;
    document.querySelectorAll('[data-bulk]').forEach(function (btn) {
      btn.classList.toggle('filled', bulkFieldHasValue(btn.getAttribute('data-bulk')));
    });
  }

  function paintMemoButton() {
    var text = fileRec ? String(fileRec.memo || '').trim() : '';
    $('memoBtn').classList.toggle('filled', !!text);
  }

  function focusEntryStart() {
    if (mode !== 'b' || locked || !fileRec || entryFocusedFor === fileRec.hash) return;
    entryFocusedFor = fileRec.hash;
    var first = $('orders') && $('orders').querySelector('input.value, select.value');
    if (first) first.focus();
  }

  function migrateRowFields() {
    if (!fileRec) return;
    fileRec.rows.forEach(function (row) {
      if (row.field === '新現元別') row.field = '新現元';
      if (row.field === '党派') row.field = '政党';
    });
    fileRec.rows = fileRec.rows.filter(function (row) {
      if (REMOVED_FIELDS.indexOf(row.field) === -1) return true;
      return !!String(row.value || '').trim();
    });
    fileRec.rows.forEach(function (row) {
      if (row.fixed && FIXED_FIELDS.indexOf(row.field) === -1) row.fixed = false;
    });
    migrateCandidateSlots();
  }

  function maxOrderInRows() {
    var max = 0;
    if (!fileRec) return 0;
    fileRec.rows.forEach(function (row) {
      if (row.order > max) max = row.order;
    });
    return max;
  }

  function migrateCandidateSlots() {
    if (!fileRec || fileRec.candidateSlots != null) return;
    var max = maxOrderInRows();
    fileRec.candidateSlots = max > 1 ? max : DEFAULT_CANDIDATE_SLOTS;
  }

  function candidateSlotCount() {
    if (!fileRec) return DEFAULT_CANDIDATE_SLOTS;
    migrateCandidateSlots();
    var fromRows = maxOrderInRows();
    var slots = fileRec.candidateSlots;
    return Math.max(slots, fromRows, 1);
  }

  function ensureOrder(order) {
    var added = false;
    FIXED_FIELDS.forEach(function (name) {
      var exists = fileRec.rows.some(function (row) {
        return row.order === order && row.field === name;
      });
      if (exists) return;
      fileRec.rows.push({
        id: uid(),
        order: order,
        field: name,
        value: name === '届け出番号' ? String(order) : (name === '性別' ? '男' : ''),
        fixed: true,
        filingDefaulted: name === '届け出番号',
        genderDefaulted: name === '性別'
      });
      added = true;
    });
    var used = {};
    var fixedRows = [];
    FIXED_FIELDS.forEach(function (name) {
      var hit = fileRec.rows.filter(function (row) {
        return row.order === order && row.field === name && !used[row.id];
      })[0];
      if (!hit) return;
      used[hit.id] = true;
      hit.fixed = true;
      if (hit.field === '届け出番号' && !hit.filingDefaulted) {
        hit.filingDefaulted = true;
        if (!String(hit.value || '').trim()) hit.value = String(order);
        added = true;
      }
      if (hit.field === '性別' && !hit.genderDefaulted) {
        hit.genderDefaulted = true;
        if (!String(hit.value || '').trim()) hit.value = '男';
        added = true;
      }
      fixedRows.push(hit);
    });
    var extras = fileRec.rows.filter(function (row) {
      return row.order === order && !used[row.id];
    });
    var rebuilt = [];
    var placed = false;
    fileRec.rows.forEach(function (row) {
      if (row.order !== order) {
        rebuilt.push(row);
        return;
      }
      if (placed) return;
      fixedRows.forEach(function (item) { rebuilt.push(item); });
      extras.forEach(function (item) { rebuilt.push(item); });
      placed = true;
    });
    fileRec.rows = rebuilt;
    return added;
  }

  function orderedRows(order) {
    if (!fileRec) return [];
    return fileRec.rows.filter(function (row) { return row.order === order; });
  }

  function syncAge(order) {
    var birth = fileRec.rows.filter(function (row) { return row.order === order && row.field === '生年月日'; })[0];
    var ageRow = fileRec.rows.filter(function (row) { return row.order === order && row.field === '年齢'; })[0];
    if (!birth || !ageRow || ageRow.manual) return;
    var dt = parseJapaneseDate(birth.value);
    var age = dt ? fullAge(dt) : null;
    if (age == null) {
      if (!String(birth.value || '').trim()) {
        ageRow.value = '';
        var cleared = document.querySelector('[data-row="' + ageRow.id + '"][data-part="value"]');
        if (cleared) cleared.value = '';
        updateAgeHint(ageRow);
      }
      return;
    }
    ageRow.value = String(age);
    var input = document.querySelector('[data-row="' + ageRow.id + '"][data-part="value"]');
    if (input) input.value = ageRow.value;
    updateAgeHint(ageRow);
    persist();
  }

  function updateAgeHint(row, hintEl, basisEl) {
    var hint = hintEl || document.querySelector('[data-age-hint="' + row.id + '"]');
    var basis = basisEl || document.querySelector('[data-age-basis="' + row.id + '"]');
    var label = ageBasis().today ? '今日時点' : '投開票日時点';
    if (hint) {
      hint.hidden = false;
      hint.textContent = row.manual ? '手入力' : (row.value ? label : '生年月日を入れると計算します');
    }
    if (basis) basis.textContent = !row.manual && row.value ? label : '';
  }

  function parseJapaneseDate(text) {
    var s = String(text || '').trim();
    s = s.replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '').replace(/[./]/g, '-').replace(/\s/g, '');
    var era = s.match(/^(令和|平成|昭和|大正|明治|R|H|S|T|M)(\d+)-(\d+)-(\d+)$/i);
    if (era) {
      var found = ERAS.filter(function (item) {
        return item.name === era[1] || item.short.toLowerCase() === era[1].toLowerCase();
      })[0];
      if (!found) return null;
      return makeDate(found.start + Number(era[2]) - 1, Number(era[3]), Number(era[4]));
    }
    var western = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (western) return makeDate(Number(western[1]), Number(western[2]), Number(western[3]));
    return null;
  }

  function makeDate(year, month, day) {
    var dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return dt;
  }

  function ageBasis() {
    var raw = fileRec && fileRec.electionDate;
    if (raw) {
      var parts = String(raw).split('-');
      var picked = makeDate(Number(parts[0]), Number(parts[1]), Number(parts[2]));
      if (picked) return { date: picked, today: false };
    }
    return { date: new Date(), today: true };
  }

  function fullAge(dt) {
    var basis = ageBasis().date;
    var age = basis.getFullYear() - dt.getFullYear();
    var month = basis.getMonth() - dt.getMonth();
    if (month < 0 || (month === 0 && basis.getDate() < dt.getDate())) age -= 1;
    return age >= 0 ? age : null;
  }

  function refreshAges() {
    if (!fileRec) return;
    var n = candidateSlotCount();
    for (var i = 1; i <= n; i++) syncAge(i);
    renderForm();
    if (!$('bulkPanel').hidden) renderBulk();
    paintBulkButtons();
  }

  function setupPanel() {
    document.querySelectorAll('.sheet').forEach(bindSheet);
  }

  function bindSheet(panel) {
    var head = panel.querySelector('.sheetHead');
    var resize = panel.querySelector('.sheetResize');
    if (!head || !resize) return;
    head.addEventListener('pointerdown', function (ev) {
      if (mode !== 'b' || ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('button')) return;
      var startX = ev.clientX;
      var startY = ev.clientY;
      var moved = false;
      var origin = panel.getBoundingClientRect();
      function move(e) {
        if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
        if (!moved) {
          moved = true;
          panel.classList.add('floating');
          document.body.classList.remove('collapsed');
          panel.style.width = origin.width + 'px';
          panel.style.left = origin.left + 'px';
          panel.style.top = origin.top + 'px';
          panel.style.zIndex = '16';
        }
        placeFloat(panel, origin.left + (e.clientX - startX), origin.top + (e.clientY - startY));
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    resize.addEventListener('pointerdown', function (ev) {
      if (mode !== 'b') return;
      ev.preventDefault();
      ev.stopPropagation();
      var startX = ev.clientX;
      var startW = panel.offsetWidth;
      var floating = panel.classList.contains('floating');
      var growLeft = !document.body.classList.contains('flip') && !floating;
      function move(e) {
        var dx = e.clientX - startX;
        var width = growLeft ? startW - dx : startW + dx;
        width = Math.max(280, Math.min(window.innerWidth - 80, width));
        panel.style.width = width + 'px';
        if (panel.classList.contains('floating')) placeFloat(
          panel,
          parseFloat(panel.style.left) || 0,
          parseFloat(panel.style.top) || 0
        );
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    var corner = panel.querySelector('.sheetCorner');
    if (!corner) return;
    corner.addEventListener('pointerdown', function (ev) {
      if (mode !== 'b' || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      var startX = ev.clientX;
      var startY = ev.clientY;
      var startW = panel.offsetWidth;
      var startH = panel.offsetHeight;
      var floating = panel.classList.contains('floating');
      var growLeft = !document.body.classList.contains('flip') && !floating;
      function move(e) {
        var dx = e.clientX - startX;
        var width = growLeft ? startW - dx : startW + dx;
        width = Math.max(280, Math.min(window.innerWidth - 16, width));
        panel.style.width = width + 'px';
        if (panel.classList.contains('floating')) {
          var height = Math.max(120, Math.min(window.innerHeight - 16, startH + (e.clientY - startY)));
          panel.style.height = height + 'px';
          placeFloat(panel, parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
        }
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function placeFloat(panel, left, top) {
    var width = panel.offsetWidth;
    var height = panel.offsetHeight;
    var maxLeft = Math.max(8, window.innerWidth - width - 8);
    var maxTop = Math.max(8, window.innerHeight - height - 8);
    panel.style.left = Math.max(8, Math.min(maxLeft, left)) + 'px';
    panel.style.top = Math.max(8, Math.min(maxTop, top)) + 'px';
  }

  function updateDup(line, row) {
    var hint = line.querySelector('.hint');
    var dup = row.field && fileRec.rows.some(function (other) {
      return other.id !== row.id && other.order === row.order && other.field === row.field;
    });
    hint.hidden = !dup;
    hint.textContent = 'この届出順ですでに使っています';
  }

  function clearIfEmptied(row, key, el) {
    if (row[key] && !el.value && el.dataset.before) {
      snapshot();
      el.dataset.before = '';
    }
  }

  function addRow(order, focus) {
    if (!ensureFile()) return;
    var row = { id: uid(), order: order, field: '', value: '' };
    fileRec.rows.push(row);
    markEditing();
    persist();
    renderForm();
    if (focus) {
      var el = $('orders').querySelector('[data-row="' + row.id + '"][data-part="field"]')
        || $('orders').querySelector('[data-row="' + row.id + '"][data-part="value"]');
      if (el) el.focus();
    }
  }

  function removeOrder(order) {
    if (!ensureFile() || locked) return;
    var list = orders();
    if (list.length < 2 || order === list[0]) return;
    ask('候補者' + order + 'を消します。', '戻る', '消す').then(function (choice) {
      if (choice !== 'secondary') return;
      snapshot();
      fileRec.rows = fileRec.rows.filter(function (row) { return row.order !== order; });
      markEditing();
      persist();
      renderSide();
      showToast('消しました');
    });
  }

  function resetOrders() {
    if (!ensureFile()) return;
    var extra = fileRec.rows.some(function (row) { return row.order !== 1; });
    if (!extra) return;
    ask('2番以降の届出順を消します。', '戻る', '消す').then(function (choice) {
      if (choice !== 'secondary') return;
      snapshot();
      fileRec.rows = fileRec.rows.filter(function (row) { return row.order === 1; });
      fileRec.candidateSlots = 1;
      markEditing();
      persist();
      renderForm();
      showToast('消しました');
    });
  }

  function renderReview() {
    var body = $('reviewBody');
    body.innerHTML = '';
    if (!fileRec) {
      body.appendChild(note('PDFを開いてください'));
      return;
    }
    orders().forEach(function (order) {
      var h = document.createElement('h3');
      h.textContent = '候補者 ' + order;
      body.appendChild(h);
      var rows = orderedRows(order);
      var filled = rows.filter(function (row) {
        return String(row.value || '').trim() || row.unsure;
      });
      if (!filled.length) {
        body.appendChild(note('未入力'));
        return;
      }
      filled.forEach(function (row) {
        var line = document.createElement('div');
        line.className = 'review-item';
        var name = document.createElement('b');
        name.textContent = row.field || '（項目名なし）';
        var val = document.createElement('span');
        val.textContent = (row.value || '（空）') + (row.unsure ? '  要確認' : '');
        line.appendChild(name);
        line.appendChild(val);
        body.appendChild(line);
      });
    });
  }

  function orders() {
    if (!fileRec) return [1];
    if (mode !== 'b') {
      var set = {};
      fileRec.rows.forEach(function (row) { set[row.order] = true; });
      if (!Object.keys(set).length) set[1] = true;
      return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }
    var n = candidateSlotCount();
    var list = [];
    for (var i = 1; i <= n; i++) list.push(i);
    return list;
  }

  function completeA() {
    if (!ensureFile()) return;
    if (!fileRec.pins.length && !hasBulkValue()) { showToast('印も一括確認もありません'); return; }
    var empty = fileRec.pins.filter(function (pin) { return !String(pin.answer || '').trim(); });
    var done = function () {
      fileRec.status = '確認完了';
      fileRec.aName = $('name').value.trim();
      fileRec.aDoneAt = Date.now();
      $('aPreview').hidden = true;
      persist(true);
      locked = checkLock();
      updateChrome();
    };
    if (empty.length) {
      ask('正しい内容が空の印が' + empty.length + '件あります。', '戻る', 'このまま完了').then(function (choice) {
        if (choice === 'secondary') done();
      });
    } else {
      done();
    }
  }

  function openAPreview() {
    if (!ensureFile()) return;
    if (!fileRec.pins.length && !hasBulkValue()) { showToast('印も一括確認もありません'); return; }
    $('aPreview').hidden = false;
    renderAPreview();
  }

  function renderAPreview() {
    var body = $('aPreviewBody');
    body.innerHTML = '';
    body.appendChild(previewBlock('メモ', fileRec.memo || '（なし）'));
    body.appendChild(previewBlock('投開票日', fileRec.electionDate || '未入力（年齢は今日時点）'));
    BULK_FIELDS.forEach(function (key) {
      var lines = [];
      var total = candidateSlotCount();
      for (var order = 1; order <= total; order++) {
        var bits = bulkStoredFields(key).map(function (name) {
          var row = findBulkRow(order, name);
          return row && String(row.value || '').trim() ? row.value : '';
        }).filter(Boolean);
        if (bits.length) lines.push('候補者 ' + order + '  ' + bits.join(' / '));
      }
      body.appendChild(previewBlock(key, lines.length ? lines.join('\n') : '（なし）'));
    });
    var pins = document.createElement('div');
    pins.className = 'preview-block';
    var title = document.createElement('b');
    title.textContent = '印';
    pins.appendChild(title);
    if (!fileRec.pins.length) pins.appendChild(note('印はありません'));
    fileRec.pins.forEach(function (pin) {
      var line = document.createElement('div');
      line.style.marginTop = '8px';
      line.textContent = pin.no + '  p' + pin.page;
      var answer = document.createElement('div');
      answer.className = 'right-answer';
      answer.textContent = pin.answer || '（空）';
      line.appendChild(answer);
      if (pin.unsure) {
        var flag = document.createElement('small');
        flag.textContent = '入力不明・不安';
        line.appendChild(flag);
      }
      pins.appendChild(line);
    });
    body.appendChild(pins);
  }

  function previewBlock(label, text) {
    var block = document.createElement('div');
    block.className = 'preview-block';
    var title = document.createElement('b');
    title.textContent = label;
    var body = document.createElement('div');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = text;
    block.appendChild(title);
    block.appendChild(body);
    return block;
  }

  function openMemo() {
    if (!fileRec) { showToast('PDFを開いてください'); return; }
    $('memoText').value = fileRec.memo || '';
    $('memoText').readOnly = mode !== 'a' || locked;
    $('memoPanel').hidden = false;
    if (mode === 'a' && !locked) $('memoText').focus();
  }

  function renderMemo() {
    var box = $('memoRead');
    var text = fileRec ? String(fileRec.memo || '').trim() : '';
    box.hidden = !text;
    box.textContent = text ? 'メモ\n' + fileRec.memo : '';
    paintMemoButton();
  }

  function resetPanels() {
    ['checksPanel', 'formPanel'].forEach(function (id) {
      var panel = $(id);
      panel.classList.remove('floating', 'minimized');
      panel.style.left = '';
      panel.style.top = '';
      panel.style.width = '';
      panel.style.height = '';
      panel.style.right = '';
      panel.style.zIndex = '';
    });
    $('formMin').textContent = 'ー';
    if (!document.body.classList.contains('reviewing')) {
      $('formHeadText').textContent = '入力欄（ドラッグで移動）';
    }
  }

  function dragBulk() {
    dragByHeader($('bulkPanel'));
  }

  function dragByHeader(panel) {
    var header = panel.querySelector('header');
    header.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('button')) return;
      var origin = panel.getBoundingClientRect();
      var startX = ev.clientX;
      var startY = ev.clientY;
      panel.style.width = origin.width + 'px';
      panel.style.left = origin.left + 'px';
      panel.style.top = origin.top + 'px';
      panel.style.right = 'auto';
      function move(e) {
        var left = origin.left + (e.clientX - startX);
        var top = origin.top + (e.clientY - startY);
        var maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
        var maxTop = Math.max(8, window.innerHeight - 80);
        panel.style.left = Math.max(8, Math.min(maxLeft, left)) + 'px';
        panel.style.top = Math.max(8, Math.min(maxTop, top)) + 'px';
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function offerReeditA() {
    ask('確認完了していますが、修正しますか？', 'はい', 'いいえ').then(function (choice) {
      if (choice !== 'primary' || !fileRec || fileRec.status !== '確認完了') return;
      fileRec.status = '確認の途中';
      fileRec.aName = $('name').value.trim();
      persist();
      locked = checkLock();
      updateChrome();
      renderSide();
    });
  }

  function offerReedit() {
    ask('完了済みですが、編集しますか？', 'はい', 'いいえ').then(function (choice) {
      if (choice !== 'primary' || !fileRec || fileRec.status !== '入力完了') return;
      fileRec.status = '入力の途中';
      fileRec.bName = $('name').value.trim();
      persist();
      locked = checkLock();
      updateChrome();
      renderSide();
    });
  }

  function completeB() {
    if (!ensureFile()) return;
    var missing = unreflected();
    var done = function () {
      fileRec.status = '入力完了';
      fileRec.bName = $('name').value.trim();
      fileRec.bDoneAt = Date.now();
      persist(true);
      locked = checkLock();
      updateChrome();
    };
    if (missing) {
      ask('未反映が' + missing + '件あります。', '戻る', 'このまま入力完了').then(function (choice) {
        if (choice === 'secondary') done();
      });
    } else {
      ask('入力完了にします。', '入力完了', '戻る').then(function (choice) {
        if (choice === 'primary') done();
      });
    }
  }

  function checkLock() {
    if (!fileRec) return false;
    var name = $('name').value.trim();
    var message = '';
    if (mode === 'a') {
      if (fileRec.status === '確認完了' || fileRec.status === '入力の途中' || fileRec.status === '入力完了') {
        message = '確認完了です。このファイルは入力担当が開きます。';
      } else if (fileRec.status === '確認の途中' && fileRec.aName && fileRec.aName !== name) {
        message = fileRec.aName + 'さんが作業中です';
      }
    } else if (fileRec.status === '未着手' || fileRec.status === '確認の途中') {
      $('lock').hidden = false;
      $('lock').innerHTML =
        '確認が終わっていません。<br>' +
        '<a href="?mode=a">選管への確認</a>で<strong>同じPDF</strong>を開き、「確認完了」にしてから、' +
        '「立候補者情報の入力」でもう一度同じPDFを開いてください。';
      return true;
    } else if (fileRec.status === '入力完了') {
      message = '入力完了です';
    } else if (fileRec.status === '入力の途中' && fileRec.bName && fileRec.bName !== name) {
      message = fileRec.bName + 'さんが作業中です';
    }
    $('lock').hidden = !message;
    $('lock').textContent = message;
    return !!message;
  }

  function markEditing() {
    var name = $('name').value.trim();
    if (mode === 'a') {
      fileRec.status = '確認の途中';
      fileRec.aName = name;
    } else if (fileRec.status === '確認完了' || fileRec.status === '入力の途中') {
      fileRec.status = '入力の途中';
      fileRec.bName = name;
    }
    updateChrome();
  }

  function unreflected() {
    if (!fileRec) return 0;
    return fileRec.pins.filter(function (pin) { return !pin.reflected; }).length;
  }

  function updateChrome() {
    $('status').textContent = fileRec ? fileRec.status : '';
    $('fileName').textContent = fileRec ? fileRec.fileName : 'PDFが未選択';
    $('unref').textContent = fileRec && mode === 'b' ? '未反映 ' + unreflected() + '件' : '';
    var editing = !locked && !!fileRec;
    $('completeA').disabled = !editing;
    $('reviewBtn').disabled = !editing;
    $('completeB').disabled = !editing;
    $('electionDate').disabled = mode !== 'a' || !editing;
    if (document.activeElement !== $('electionDate')) {
      $('electionDate').value = fileRec && fileRec.electionDate ? fileRec.electionDate : '';
    }
    $('memoText').readOnly = mode !== 'a' || !editing;
  }

  function persist(immediate) {
    if (!fileRec) return;
    fileRec.updatedAt = Date.now();
    writeStoreFile();
    saveUndo();
    $('saveState').textContent = hasGas ? 'このパソコンに残しています' : 'このパソコンに保存済み ' + clock();
    if (!hasGas) return;
    clearTimeout(gasTimer);
    if (immediate) pushGas();
    else gasTimer = setTimeout(pushGas, 60000);
  }

  function pushGas() {
    if (!hasGas || !fileRec) return;
    var fn = mode === 'a' ? 'saveA' : 'saveB';
    gas(fn, payload()).then(function () {
      $('saveState').textContent = '保存済み ' + clock();
    }).catch(function (err) {
      $('saveState').textContent = '保存に失敗しました';
      showToast(err && err.message ? err.message : '台帳に書けませんでした');
    });
  }

  function payload() {
    return {
      hash: fileRec.hash,
      fileName: fileRec.fileName,
      pageCount: fileRec.pageCount,
      name: $('name').value.trim(),
      status: fileRec.status,
      pins: fileRec.pins,
      rows: fileRec.rows
    };
  }

  function snapshot() {
    if (!fileRec) return;
    var snap = JSON.stringify({ pins: fileRec.pins, rows: fileRec.rows });
    if (undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if (undoStack.length > 20) undoStack.shift();
    saveUndo();
  }

  function undo() {
    if (!undoStack.length || locked || !fileRec) return;
    var data = JSON.parse(undoStack.pop());
    fileRec.pins = data.pins;
    fileRec.rows = data.rows;
    saveUndo();
    persist();
    if (selectedPin() == null) $('card').hidden = true;
    else {
      $('answer').value = selectedPin().answer || '';
      $('pinUnsure').checked = !!selectedPin().unsure;
    }
    drawPins();
    renderSide();
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { files: {} }; }
    catch (e) { return { files: {} }; }
  }

  function takeFile(hash, fileName, pageCount) {
    var store = readStore();
    var found = store.files[hash];
    if (found) {
      found.fileName = fileName;
      found.pageCount = pageCount;
      return found;
    }
    return {
      hash: hash,
      fileName: fileName,
      pageCount: pageCount,
      status: '未着手',
      aName: '',
      aDoneAt: '',
      bName: '',
      bDoneAt: '',
      pins: [],
      rows: [],
      candidateSlots: DEFAULT_CANDIDATE_SLOTS,
      electionDate: todayISO(),
      electionDefaulted: true,
      updatedAt: 0
    };
  }

  function writeStoreFile() {
    var store = readStore();
    store.files[fileRec.hash] = fileRec;
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function readUndo(hash) {
    try { return JSON.parse(localStorage.getItem('senkyo-undo-' + hash)) || []; }
    catch (e) { return []; }
  }

  function saveUndo() {
    if (!fileRec) return;
    localStorage.setItem('senkyo-undo-' + fileRec.hash, JSON.stringify(undoStack));
  }

  function ask(text, primary, secondary) {
    $('modalText').textContent = text;
    $('modalPrimary').textContent = primary;
    $('modalSecondary').textContent = secondary;
    $('modal').hidden = false;
    return new Promise(function (resolve) {
      $('modalPrimary').onclick = function () { $('modal').hidden = true; resolve('primary'); };
      $('modalSecondary').onclick = function () { $('modal').hidden = true; resolve('secondary'); };
    });
  }

  function showToast(text) {
    $('toastText').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  }

  function hideToast() { $('toast').hidden = true; }

  function note(text) {
    var p = document.createElement('p');
    p.textContent = text;
    p.style.padding = '8px 10px';
    p.style.color = '#555';
    return p;
  }

  function addedRotation() {
    var value = fileRec && Number(fileRec.rotation);
    if (value === 90 || value === 180 || value === 270) return value;
    return 0;
  }

  function viewportRotation(page) {
    return ((page.rotate || 0) + addedRotation()) % 360;
  }

  function toView(x, y) {
    var angle = addedRotation();
    if (angle === 90) return { x: 1 - y, y: x };
    if (angle === 180) return { x: 1 - x, y: 1 - y };
    if (angle === 270) return { x: y, y: 1 - x };
    return { x: x, y: y };
  }

  function toStored(pos) {
    var angle = addedRotation();
    if (angle === 90) return { x: pos.y, y: 1 - pos.x };
    if (angle === 180) return { x: 1 - pos.x, y: 1 - pos.y };
    if (angle === 270) return { x: 1 - pos.y, y: pos.x };
    return { x: pos.x, y: pos.y };
  }

  function eventRatio(ev, canvas) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: clamp((ev.clientX - rect.left) / rect.width),
      y: clamp((ev.clientY - rect.top) / rect.height)
    };
  }

  function clamp(n) { return Math.max(0, Math.min(1, n)); }

  function nextNo() {
    var max = 0;
    fileRec.pins.forEach(function (pin) { if (pin.no > max) max = pin.no; });
    return max + 1;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clock() {
    return new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function sha256(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
      return Array.from(new Uint8Array(digest)).map(function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }

  function gas(name, arg) {
    return new Promise(function (resolve, reject) {
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](arg);
    });
  }

  function modeHref(nextMode) {
    var u = new URL(location.href);
    u.searchParams.set('mode', nextMode);
    return u.pathname + u.search;
  }

  window.addEventListener('beforeunload', function () { if (hasGas) pushGas(); });
})();
