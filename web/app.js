(function () {
  'use strict';

  var MASTERS = [
    'カナ', '年齢', '氏名', 'ふりがな', '候補者(ふりがな)氏名', '(ふりがな)通称', '通称',
    '党派', '政党名', '職業', '肩書', '性別', '生年月日', '新現元', '新現元別', '住所', '本籍地',
    '選挙事務所', '選挙事務所TEL', '届出年月日',
    '届け出番号', '届け出年月日', '候補者名', '通称（ふりがな）'
  ];
  var FIXED_FIELDS = [
    '届け出番号', '届け出年月日', '候補者名', 'ふりがな', '通称（ふりがな）', '性別',
    '党派', '職業', '生年月日', '新現元', '年齢'
  ];
  var BULK_FIELDS = ['ふりがな', '年齢', '性別', '党派'];
  var DEFAULT_CANDIDATE_SLOTS = 10;
  var VALUE_CHOICES = {
    '性別': [
      { value: '男', label: '男' },
      { value: '女', label: '女' },
      { value: '', label: '空白' }
    ],
    '新現元': ['', '新', '現', '元']
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
  var undoStack = [];
  var locked = false;
  var gasTimer = null;
  var toastTimer = null;
  var entryFocusedFor = '';

  var $ = function (id) { return document.getElementById(id); };

  document.body.classList.add(mode === 'b' ? 'mode-b' : 'mode-a');
  document.title = mode === 'b'
    ? '立候補者情報の入力（確認用ツール）'
    : '選管への確認（電話・赤入れツール）';
  $('modeLabel').textContent = mode === 'b'
    ? '【立候補者情報の入力｜確認用ツール】'
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

  $('prev').addEventListener('click', function () { if (currentPage > 1) { currentPage -= 1; renderPage(); } });
  $('next').addEventListener('click', function () { if (pdfDoc && currentPage < pdfDoc.numPages) { currentPage += 1; renderPage(); } });
  $('zoomOut').addEventListener('click', function () { scale = Math.max(0.5, scale - 0.15); renderPage(); });
  $('zoomIn').addEventListener('click', function () { scale = Math.min(2.5, scale + 0.15); renderPage(); });
  $('toastUndo').addEventListener('click', function () { hideToast(); undo(); });
  $('saveBtn').addEventListener('click', function () { persist(true); });
  $('completeA').addEventListener('click', completeA);
  $('reviewBtn').addEventListener('click', function () {
    if (!ensureFile()) {
      if (!fileRec) showToast('PDFを開いてください');
      return;
    }
    document.body.classList.remove('collapsed');
    document.body.classList.add('reviewing');
    $('review').hidden = false;
    $('bulkPanel').hidden = true;
    $('formHead').textContent = '入力内容の確認';
    $('formPanel').scrollTop = 0;
    renderReview();
  });
  $('backEdit').addEventListener('click', function () {
    document.body.classList.remove('reviewing');
    $('review').hidden = true;
    $('formHead').textContent = '入力欄（ドラッグで移動）';
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

  $('pinLayer').addEventListener('click', function (ev) {
    if (mode !== 'a' || locked || !fileRec) return;
    if (ev.target !== $('pinLayer')) return;
    if (!requireName()) return;
    var pos = eventRatio(ev);
    snapshot();
    var pin = {
      id: uid(),
      no: nextNo(),
      page: currentPage,
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
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise.then(function (doc) {
        return { hash: hash, doc: doc };
      });
    }).then(function (opened) {
      pdfDoc = opened.doc;
      fileRec = takeFile(opened.hash, fileName, pdfDoc.numPages);
      migrateRowFields();
      undoStack = readUndo(opened.hash);
      selectedId = null;
      locked = false;
      $('card').hidden = true;
      $('lock').hidden = true;
      document.body.classList.remove('reviewing');
      currentPage = 1;
      $('empty').hidden = true;
      $('pageWrap').hidden = false;
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
      var base = page.getViewport({ scale: 1 });
      var avail = document.querySelector('.stage').clientWidth - 48;
      scale = Math.max(0.6, Math.min(2, avail / base.width));
    });
  }

  function renderPage() {
    var token = ++renderToken;
    return pdfDoc.getPage(currentPage).then(function (page) {
      if (token !== renderToken) return;
      var viewport = page.getViewport({ scale: scale });
      var canvas = $('pdf');
      var ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
        if (token !== renderToken) return;
        $('pageLabel').textContent = currentPage + ' / ' + pdfDoc.numPages;
        $('zoomLabel').textContent = Math.round(scale * 100) + '%';
        drawPins();
      });
    });
  }

  function drawPins() {
    var layer = $('pinLayer');
    layer.innerHTML = '';
    if (!fileRec) return;
    fileRec.pins.filter(function (pin) { return pin.page === currentPage; }).forEach(function (pin) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pin' + (pin.id === selectedId ? ' current' : '');
      btn.textContent = String(pin.no);
      btn.style.left = (pin.x * 100) + '%';
      btn.style.top = (pin.y * 100) + '%';
      btn.title = pin.answer || (pin.unsure ? '自信がない' : '');
      layer.appendChild(btn);
      bindPin(btn, pin);
    });
  }

  function bindPin(btn, pin) {
    var startX = 0;
    var startY = 0;
    var dragging = false;
    var snapped = false;
    btn.addEventListener('pointerdown', function (ev) {
      if (locked) return;
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
        var pos = eventRatio(e);
        pin.x = pos.x;
        pin.y = pos.y;
        btn.style.left = (pin.x * 100) + '%';
        btn.style.top = (pin.y * 100) + '%';
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
      if (dragging) { dragging = false; return; }
      selectedId = pin.id;
      if (mode === 'a' && !locked) openCard(pin, ev.clientX, ev.clientY);
      else focusPin(pin);
      drawPins();
      renderSide();
    });
  }

  function focusPin(pin) {
    selectedId = pin.id;
    if (pin.page !== currentPage) {
      currentPage = pin.page;
      renderPage().then(function () { flash(pin); });
    } else {
      flash(pin);
    }
    var row = document.querySelector('[data-pin="' + pin.id + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function flash(pin) {
    var pins = document.querySelectorAll('.pin');
    pins.forEach(function (el, i) {
      var list = fileRec.pins.filter(function (p) { return p.page === currentPage; });
      if (list[i] && list[i].id === pin.id) el.classList.add('current');
    });
    var el = document.querySelector('.pin.current');
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
    renderForm();
    if (document.body.classList.contains('reviewing')) renderReview();
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
      small.textContent = (pin.answer || '（空）') + (pin.unsure ? '  自信がない' : '');
      btn.appendChild(title);
      btn.appendChild(small);
      btn.addEventListener('click', function () {
        selectedId = pin.id;
        if (pin.page !== currentPage) {
          currentPage = pin.page;
          renderPage().then(function () { openCard(pin); });
        } else {
          openCard(pin);
          drawPins();
        }
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
      var small = document.createElement('small');
      var lines = [];
      lines.push('正しい内容: ' + (pin.answer || '（空）'));
      if (pin.unsure) lines.push('自信がない');
      small.textContent = lines.join('\n');
      small.style.whiteSpace = 'pre-wrap';
      btn.appendChild(title);
      btn.appendChild(small);
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
    var firstOrder = orders()[0];
    orders().forEach(function (order) {
      var box = document.createElement('div');
      box.className = 'order';
      box.dataset.order = String(order);
      var heading = document.createElement('div');
      heading.textContent = '候補者 ' + order;
      heading.style.fontWeight = '700';
      heading.style.marginBottom = '8px';
      if (!locked && order !== firstOrder) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'この候補者を消す';
        remove.style.marginLeft = '8px';
        remove.addEventListener('click', function () { removeOrder(order); });
        heading.appendChild(remove);
      }
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
    unsure.appendChild(document.createTextNode('入力内容がわからない・不安'));
    inputs.appendChild(field);
    inputs.appendChild(value);
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
      updateAgeHint(row);
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
      input.placeholder = '内容';
      tagValue(input, row);
      input.addEventListener('focus', function () { input.dataset.before = row.value || ''; });
      input.addEventListener('input', function () {
        clearIfEmptied(row, 'value', input);
        commitRowValue(row, input.value);
      });
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

  function radioLabel(name, value, label, checked, onPick, onEnter) {
    var wrap = document.createElement('label');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = value;
    radio.checked = !!checked;
    radio.disabled = locked;
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
    if (row.field === '年齢') row.manual = !!String(next || '').trim();
    markEditing();
    persist();
    if (row.field === '生年月日' || (row.field === '年齢' && !row.manual)) syncAge(row.order);
    if (row.field === '年齢') updateAgeHint(row);
    reflectBulk(row);
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
    var flowFocus = document.activeElement && document.activeElement.id === 'bulkFlow'
      ? document.activeElement.selectionStart : null;
    body.innerHTML = '';
    if (!field || !fileRec) return;
    var textMode = !VALUE_CHOICES[field];
    if (textMode) body.appendChild(bulkModeSwitch());
    if (textMode && $('bulkPanel').dataset.entry === 'flow') body.appendChild(bulkFlow(field, flowFocus));
    else {
      var total = candidateSlotCount();
      for (var order = 1; order <= total; order++) body.appendChild(bulkLine(order, field));
    }
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'bulk-add';
    add.textContent = '候補者を増やす';
    add.addEventListener('click', addCandidateSlot);
    body.appendChild(add);
  }

  function bulkModeSwitch() {
    var bar = document.createElement('div');
    bar.className = 'bulk-switch';
    var entry = $('bulkPanel').dataset.entry === 'flow' ? 'flow' : 'rows';
    [['rows', '候補者ごと'], ['flow', '上から入力']].forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item[1];
      if (entry === item[0]) btn.className = 'current';
      btn.addEventListener('click', function () {
        $('bulkPanel').dataset.entry = item[0];
        renderBulk();
        if (item[0] === 'flow') {
          var area = $('bulkFlow');
          if (area) area.focus();
        }
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  function bulkFlow(field, caret) {
    var box = document.createElement('div');
    box.className = 'bulk-flow';
    var note = document.createElement('p');
    note.className = 'hint';
    note.textContent = '上から1人1行です。1行目が候補者1です。';
    var area = document.createElement('textarea');
    area.id = 'bulkFlow';
    area.value = flowText(field);
    var flags = document.createElement('div');
    var shown = area.value === '' ? 0 : area.value.split('\n').length;
    area.addEventListener('input', function () {
      var lines = area.value.split('\n');
      var prev = shown;
      shown = lines.length;
      writeFlow(field, lines, prev);
      renderFlowFlags(field, flags, lines);
    });
    renderFlowFlags(field, flags, area.value === '' ? [] : area.value.split('\n'));
    box.appendChild(note);
    box.appendChild(area);
    box.appendChild(flags);
    if (caret != null) {
      setTimeout(function () {
        area.focus();
        area.selectionStart = area.selectionEnd = caret;
      }, 0);
    }
    return box;
  }

  function flowText(field) {
    var total = candidateSlotCount();
    var lines = [];
    var last = 0;
    for (var order = 1; order <= total; order++) {
      var row = findBulkRow(order, field);
      var value = row ? (row.value || '') : '';
      lines.push(value);
      if (value) last = order;
    }
    if (!last) return '';
    return lines.slice(0, last).join('\n');
  }

  function writeFlow(field, lines, previousCount) {
    var before = candidateSlotCount();
    if (lines.length > before) {
      fileRec.candidateSlots = lines.length;
      if (mode === 'b') {
        for (var n = before + 1; n <= lines.length; n++) ensureOrder(n);
      }
      renderForm();
    }
    lines.forEach(function (line, index) {
      var row = ensureBulkRow(index + 1, field);
      if (row.value !== line) {
        row.value = line;
        if (field === '年齢') row.manual = !!String(line || '').trim();
        reflectForm(row);
      }
    });
    for (var order = lines.length + 1; order <= previousCount; order++) {
      var row = findBulkRow(order, field);
      if (!row || !row.value) continue;
      row.value = '';
      if (field === '年齢') row.manual = false;
      reflectForm(row);
    }
    markEditing();
    persist();
  }

  function renderFlowFlags(field, flags, lines) {
    flags.innerHTML = '';
    var list = lines && lines.length ? lines : [''];
    list.forEach(function (text, index) {
      var order = index + 1;
      var row = findBulkRow(order, field);
      var line = document.createElement('div');
      line.className = 'bulk-row';
      var name = document.createElement('b');
      name.textContent = '候補者 ' + order;
      var copied = document.createElement('span');
      copied.className = 'bulk-copied';
      copied.textContent = text || '';
      line.appendChild(name);
      line.appendChild(copied);
      line.appendChild(unsureToggle(order, field, row));
      flags.appendChild(line);
    });
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
    label.appendChild(document.createTextNode('自信ない・不明'));
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
    var existing = findBulkRow(order, field);
    var line = document.createElement('div');
    line.className = 'bulk-row';
    var name = document.createElement('b');
    name.textContent = '候補者 ' + order;
    line.appendChild(name);
    var choices = VALUE_CHOICES[field];
    if (!choices) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = existing ? (existing.value || '') : '';
      input.dataset.bulkOrder = String(order);
      input.dataset.bulkField = field;
      input.addEventListener('input', function () {
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
    choiceList(choices, existing ? existing.value : '').forEach(function (choice) {
      var value = choiceValue(choice);
      wrap.appendChild(radioLabel('bulk-' + field + '-' + order, value, choiceLabel(choice), existing && existing.value === value, function () {
        var row = ensureBulkRow(order, field);
        commitRowValue(row, value);
        reflectForm(row);
      }, function () {
        focusValue(document.querySelector('#bulkBody [data-bulk-order="' + (order + 1) + '"]'));
      }));
    });
    line.appendChild(wrap);
    line.appendChild(unsureToggle(order, field, existing));
    return line;
  }

  function reflectBulk(row) {
    if ($('bulkPanel').hidden || $('bulkPanel').dataset.field !== row.field) return;
    reflectBulkUnsure(row);
    var area = $('bulkFlow');
    if (area) {
      if (area !== document.activeElement) area.value = flowText(row.field);
      return;
    }
    var text = document.querySelector('#bulkBody input[type="text"][data-bulk-order="' + row.order + '"][data-bulk-field="' + row.field + '"]');
    if (text && text !== document.activeElement && text.value !== (row.value || '')) text.value = row.value || '';
    var wrap = document.querySelector('#bulkBody .radios[data-bulk-order="' + row.order + '"][data-bulk-field="' + row.field + '"]');
    if (!wrap) return;
    wrap.querySelectorAll('input').forEach(function (radio) {
      radio.checked = radio.value === (row.value || '');
    });
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

  function hasBulkValue() {
    if (!fileRec) return false;
    return fileRec.rows.some(function (row) {
      return BULK_FIELDS.indexOf(row.field) !== -1 && String(row.value || '').trim();
    });
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
      fileRec.rows.push({ id: uid(), order: order, field: name, value: '', fixed: true });
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
    if (age == null) return;
    ageRow.value = String(age);
    var input = document.querySelector('[data-row="' + ageRow.id + '"][data-part="value"]');
    if (input) input.value = ageRow.value;
    updateAgeHint(ageRow);
    persist();
  }

  function updateAgeHint(row) {
    var hint = document.querySelector('[data-age-hint="' + row.id + '"]');
    if (!hint) return;
    hint.hidden = false;
    hint.textContent = row.manual ? '手入力' : (row.value ? '生年月日から計算（今日時点の満年齢）' : '生年月日を入れると計算します');
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

  function fullAge(dt) {
    var today = new Date();
    var age = today.getFullYear() - dt.getFullYear();
    var month = today.getMonth() - dt.getMonth();
    if (month < 0 || (month === 0 && today.getDate() < dt.getDate())) age -= 1;
    return age >= 0 ? age : null;
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
      persist(true);
      locked = checkLock();
      updateChrome();
    };
    if (empty.length) {
      ask('正しい内容が空の印が' + empty.length + '件あります。', '戻る', 'このまま完了').then(function (choice) {
        if (choice === 'secondary') done();
      });
    } else {
      ask('確認完了にします。このあと印は直せません。', '確認完了', '戻る').then(function (choice) {
        if (choice === 'primary') done();
      });
    }
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

  function eventRatio(ev) {
    var rect = $('pdf').getBoundingClientRect();
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
