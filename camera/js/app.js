/*
 * app.js - 写真の EXIF を集計してダッシュボードを描画する
 * 画像はすべてブラウザ内で処理し、どこにも送信しない。
 */
(function (global) {
  'use strict';

  var IMAGE_RE = /\.(jpe?g|tiff?|heic|heif|webp|png|avif|dng|arw|sr2|srf|cr2|cr3|crw|nef|nrw|raf|orf|rw2|raw|pef|srw|x3f|3fr|iiq)$/i;
  var MAX_THUMBS = 400;

  var state = {
    records: [],
    filters: { camera: null, lens: null },
    use35: false,
    sort: { key: 'dateTime', dir: 'desc' },
    thumbUrls: []
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- 表示整形 */

  function formatShutter(seconds) {
    if (!seconds) return '—';
    if (seconds >= 1) return (Math.round(seconds * 10) / 10) + '"';
    return '1/' + Math.round(1 / seconds);
  }

  function formatF(value) {
    if (!value) return '—';
    return 'F' + (Math.round(value * 10) / 10);
  }

  function formatFocal(value) {
    if (!value) return '—';
    return Math.round(value) + 'mm';
  }

  function formatDate(date) {
    if (!date) return '—';
    var p = function (n) { return ('0' + n).slice(-2); };
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
      ' ' + p(date.getHours()) + ':' + p(date.getMinutes());
  }

  /* -------------------------------------------------------------- 集計ロジック */

  function focalOf(record) {
    return state.use35 ? (record.focal35 || record.focalLength) : record.focalLength;
  }

  function countBy(records, getKey) {
    var map = new Map();
    records.forEach(function (record) {
      var key = getKey(record);
      if (key == null || key === '') return;
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }

  function toSortedItems(map, limit) {
    var items = Array.from(map.entries()).map(function (entry) {
      return { key: entry[0], label: entry[0], value: entry[1] };
    });
    items.sort(function (a, b) { return b.value - a.value || String(a.label).localeCompare(b.label); });
    if (limit && items.length > limit) {
      var rest = items.slice(limit).reduce(function (s, d) { return s + d.value; }, 0);
      items = items.slice(0, limit);
      if (rest) items.push({ key: null, label: 'その他', value: rest });
    }
    return items;
  }

  var FOCAL_BINS = [
    { max: 15, label: '〜14mm' },
    { max: 24, label: '15-23mm' },
    { max: 35, label: '24-34mm' },
    { max: 50, label: '35-49mm' },
    { max: 70, label: '50-69mm' },
    { max: 105, label: '70-104mm' },
    { max: 200, label: '105-199mm' },
    { max: Infinity, label: '200mm〜' }
  ];

  function focalBins(records) {
    var counts = FOCAL_BINS.map(function (bin) {
      return { key: bin.label, label: bin.label, value: 0 };
    });
    records.forEach(function (record) {
      var focal = focalOf(record);
      if (!focal) return;
      for (var i = 0; i < FOCAL_BINS.length; i++) {
        if (focal < FOCAL_BINS[i].max) { counts[i].value++; return; }
      }
    });
    return counts;
  }

  var SHUTTER_BINS = [
    { min: 1, label: '1秒〜' },
    { min: 1 / 8, label: '1/8〜1秒' },
    { min: 1 / 60, label: '1/60〜1/8' },
    { min: 1 / 250, label: '1/250〜1/60' },
    { min: 1 / 1000, label: '1/1000〜1/250' },
    { min: 0, label: '〜1/1000' }
  ];

  function shutterBins(records) {
    var counts = SHUTTER_BINS.map(function (bin) {
      return { key: bin.label, label: bin.label, value: 0 };
    });
    records.forEach(function (record) {
      var t = record.exposureTime;
      if (!t) return;
      for (var i = 0; i < SHUTTER_BINS.length; i++) {
        if (t >= SHUTTER_BINS[i].min) { counts[i].value++; return; }
      }
    });
    return counts;
  }

  /* ISO は常用値（50,100,200,...）に丸めてまとめる */
  function isoBins(records) {
    var map = new Map();
    records.forEach(function (record) {
      if (!record.iso) return;
      var step = Math.pow(2, Math.round(Math.log2(record.iso / 100)));
      var bucket = Math.max(50, Math.round(100 * step));
      map.set(bucket, (map.get(bucket) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort(function (a, b) { return a[0] - b[0]; })
      .map(function (entry) {
        return { key: entry[0], label: 'ISO ' + entry[0], value: entry[1] };
      });
  }

  function apertureItems(records) {
    var map = new Map();
    records.forEach(function (record) {
      if (!record.fNumber) return;
      var value = Math.round(record.fNumber * 10) / 10;
      map.set(value, (map.get(value) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort(function (a, b) { return a[0] - b[0]; })
      .map(function (entry) {
        return { key: entry[0], label: 'F' + entry[0], value: entry[1] };
      });
  }

  function hourItems(records) {
    var counts = [];
    for (var h = 0; h < 24; h++) counts.push({ key: h, label: String(h), value: 0 });
    records.forEach(function (record) {
      if (record.dateTime) counts[record.dateTime.getHours()].value++;
    });
    return counts;
  }

  function monthItems(records) {
    var map = new Map();
    records.forEach(function (record) {
      if (!record.dateTime) return;
      var key = record.dateTime.getFullYear() + '-' + ('0' + (record.dateTime.getMonth() + 1)).slice(-2);
      map.set(key, (map.get(key) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort(function (a, b) { return a[0] < b[0] ? -1 : 1; })
      .slice(-36)
      .map(function (entry) {
        return { key: entry[0], label: entry[0].slice(2), value: entry[1] };
      });
  }

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /* ------------------------------------------------------------------ 描画 */

  function filteredRecords() {
    return state.records.filter(function (record) {
      if (state.filters.camera && record.camera !== state.filters.camera) return false;
      if (state.filters.lens && record.lens !== state.filters.lens) return false;
      return true;
    });
  }

  function statCard(label, value, note) {
    var card = document.createElement('div');
    card.className = 'stat';
    var v = document.createElement('strong');
    v.textContent = value;
    var l = document.createElement('span');
    l.textContent = label;
    card.appendChild(l);
    card.appendChild(v);
    if (note) {
      var n = document.createElement('em');
      n.textContent = note;
      card.appendChild(n);
    }
    return card;
  }

  function renderSummary(records) {
    var box = $('summary');
    box.innerHTML = '';

    var withExif = records.filter(function (r) { return r.hasExif; });
    var cameras = countBy(records, function (r) { return r.camera; });
    var lenses = countBy(records, function (r) { return r.lens; });
    var apertures = apertureItems(records);
    var topAperture = apertures.slice().sort(function (a, b) { return b.value - a.value; })[0];
    var focals = records.map(focalOf).filter(Boolean);
    var dates = records.map(function (r) { return r.dateTime; }).filter(Boolean)
      .sort(function (a, b) { return a - b; });
    var gps = records.filter(function (r) { return r.hasGps; }).length;

    box.appendChild(statCard('読み込んだ写真', records.length + '枚',
      withExif.length < records.length ? 'EXIFあり ' + withExif.length + '枚' : null));
    box.appendChild(statCard('カメラ', cameras.size + '台',
      toSortedItems(cameras, 1).map(function (d) { return d.label; })[0] || null));
    box.appendChild(statCard('レンズ', lenses.size + '本',
      toSortedItems(lenses, 1).map(function (d) { return d.label; })[0] || null));
    box.appendChild(statCard('よく使うF値', topAperture ? topAperture.label : '—',
      topAperture ? topAperture.value + '枚' : null));
    box.appendChild(statCard('焦点距離の中央値',
      focals.length ? formatFocal(median(focals)) : '—',
      state.use35 ? '35mm換算' : '実焦点距離'));
    box.appendChild(statCard('撮影期間',
      dates.length ? formatDate(dates[0]).slice(0, 10) : '—',
      dates.length ? '〜 ' + formatDate(dates[dates.length - 1]).slice(0, 10) : null));
    if (gps) box.appendChild(statCard('位置情報つき', gps + '枚', 'SNS投稿前に確認を'));
  }

  function toggleFilter(kind, value) {
    state.filters[kind] = state.filters[kind] === value ? null : value;
    render();
  }

  function renderFilters() {
    var bar = $('filterBar');
    bar.innerHTML = '';
    var active = [];
    if (state.filters.camera) active.push({ kind: 'camera', label: '📷 ' + state.filters.camera });
    if (state.filters.lens) active.push({ kind: 'lens', label: '🔎 ' + state.filters.lens });

    if (!active.length) { bar.hidden = true; return; }
    bar.hidden = false;

    active.forEach(function (item) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = item.label + ' ✕';
      chip.addEventListener('click', function () { toggleFilter(item.kind, state.filters[item.kind]); });
      bar.appendChild(chip);
    });

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip chip-clear';
    clear.textContent = 'フィルタ解除';
    clear.addEventListener('click', function () {
      state.filters = { camera: null, lens: null };
      render();
    });
    bar.appendChild(clear);
  }

  function renderCharts(records) {
    Charts.bars($('chartCamera'), toSortedItems(countBy(records, function (r) { return r.camera; }), 8), {
      emptyText: 'カメラ情報を持つ写真がありません',
      onSelect: function (item) { if (item.key) toggleFilter('camera', item.key); },
      isActive: function (item) { return state.filters.camera === item.key; }
    });

    Charts.bars($('chartLens'), toSortedItems(countBy(records, function (r) { return r.lens; }), 10), {
      emptyText: 'レンズ情報を持つ写真がありません（スマホ写真やRAW現像後によくあります）',
      onSelect: function (item) { if (item.key) toggleFilter('lens', item.key); },
      isActive: function (item) { return state.filters.lens === item.key; }
    });

    Charts.columns($('chartFocal'), focalBins(records), { emptyText: '焦点距離の記録がありません' });
    Charts.columns($('chartAperture'), apertureItems(records), { emptyText: 'F値の記録がありません', dense: true });
    Charts.columns($('chartIso'), isoBins(records), { emptyText: 'ISO の記録がありません' });
    Charts.columns($('chartShutter'), shutterBins(records), { emptyText: 'シャッター速度の記録がありません' });
    Charts.columns($('chartHour'), hourItems(records), { emptyText: '撮影日時の記録がありません', dense: true });
    Charts.columns($('chartMonth'), monthItems(records), { emptyText: '撮影日時の記録がありません', dense: true });
  }

  function formatEv(value) {
    if (value == null) return '';
    var rounded = Math.round(value * 10) / 10;
    if (rounded === 0) return '±0EV';
    return (rounded > 0 ? '+' : '') + rounded + 'EV';
  }

  /* カードに載せられる値を一通り整形して渡す（どれを使うかは card.js 側で選ぶ） */
  function cardDataFor(record) {
    var shutter = '';
    if (record.exposureTime) {
      shutter = record.exposureTime >= 1
        ? (Math.round(record.exposureTime * 10) / 10) + 's'
        : '1/' + Math.round(1 / record.exposureTime) + 's';
    }
    var stamp = record.dateTime ? formatDate(record.dateTime) : '';

    return {
      name: record.name,
      fields: {
        camera: record.camera || '',
        model: record.model || '',
        lens: record.lens || '',
        fileName: record.name,
        focal: record.focalLength ? formatFocal(record.focalLength) : '',
        focal35: record.focal35 ? formatFocal(record.focal35) + '(35mm換算)' : '',
        fNumber: record.fNumber ? formatF(record.fNumber) : '',
        shutter: shutter,
        iso: record.iso ? 'ISO ' + record.iso : '',
        ev: formatEv(record.exposureBias),
        mode: record.program || '',
        date: stamp ? stamp.slice(0, 10) : '',
        time: stamp ? stamp.slice(11) : ''
      },
      loadPreview: previewLoaderFor(record)
    };
  }

  /*
   * カード用の画像を用意する。
   * 表示できる形式は元ファイルをそのまま、RAW / HEIC は埋め込みプレビューを読み直して
   * 一覧用に縮小したものではなく元の解像度で描画する。
   */
  function previewLoaderFor(record) {
    return function () {
      if (!record.embedded || !record.file || !record.thumb) {
        return Promise.resolve({ url: record.thumbUrl, temporary: false });
      }
      return ExifReader.readThumbnail(record.file, record.thumb).then(function (bytes) {
        if (!bytes) return { url: record.thumbUrl, temporary: false };
        return {
          url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
          temporary: true
        };
      }).catch(function () {
        return { url: record.thumbUrl, temporary: false };
      });
    };
  }

  var SORT_ACCESSORS = {
    name: function (r) { return r.name.toLowerCase(); },
    camera: function (r) { return (r.camera || '').toLowerCase(); },
    lens: function (r) { return (r.lens || '').toLowerCase(); },
    focalLength: function (r) { return focalOf(r) || 0; },
    fNumber: function (r) { return r.fNumber || 0; },
    exposureTime: function (r) { return r.exposureTime || 0; },
    iso: function (r) { return r.iso || 0; },
    dateTime: function (r) { return r.dateTime ? r.dateTime.getTime() : 0; }
  };

  function sortedRecords(records) {
    var accessor = SORT_ACCESSORS[state.sort.key] || SORT_ACCESSORS.dateTime;
    var dir = state.sort.dir === 'asc' ? 1 : -1;
    return records.slice().sort(function (a, b) {
      var x = accessor(a), y = accessor(b);
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return 0;
    });
  }

  function renderTable(records) {
    var tbody = $('tableBody');
    tbody.innerHTML = '';
    var rows = sortedRecords(records);

    rows.forEach(function (record, index) {
      var tr = document.createElement('tr');

      var thumbCell = document.createElement('td');
      thumbCell.className = 'cell-thumb';
      if (record.thumbUrl && index < MAX_THUMBS) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'thumb-btn';
        button.title = 'クリックでフォトカードを作成';
        var img = document.createElement('img');
        img.src = record.thumbUrl;
        img.alt = '';
        img.loading = 'lazy';
        button.appendChild(img);
        button.addEventListener('click', function () {
          if (global.PhotoCard) global.PhotoCard.open(cardDataFor(record));
        });
        thumbCell.appendChild(button);
      } else if (record.noPreview) {
        var badge = document.createElement('span');
        badge.className = 'thumb-none';
        badge.textContent = record.ext || '?';
        badge.title = 'この形式はブラウザで表示できません（撮影データは読み取れています）';
        thumbCell.appendChild(badge);
      }
      tr.appendChild(thumbCell);

      [
        record.name,
        record.camera || '—',
        record.lens || '—',
        formatFocal(focalOf(record)),
        formatF(record.fNumber),
        formatShutter(record.exposureTime),
        record.iso ? String(record.iso) : '—',
        formatDate(record.dateTime)
      ].forEach(function (value, i) {
        var td = document.createElement('td');
        td.textContent = value;
        if (i === 0) td.className = 'cell-name';
        tr.appendChild(td);
      });

      if (record.estimated) tr.classList.add('is-estimated');
      tbody.appendChild(tr);
    });

    $('tableCount').textContent = rows.length + '枚';
    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.classList.toggle('is-sorted', th.dataset.sort === state.sort.key);
      th.dataset.dir = th.dataset.sort === state.sort.key ? state.sort.dir : '';
    });
  }

  function render() {
    var records = filteredRecords();
    $('results').hidden = state.records.length === 0;
    $('intro').hidden = state.records.length !== 0;
    if (!state.records.length) return;

    renderFilters();
    renderSummary(records);
    renderCharts(records);
    renderTable(records);

    var noExif = state.records.filter(function (r) { return !r.hasExif; }).length;
    var note = $('noExifNote');
    if (noExif) {
      note.hidden = false;
      note.textContent = noExif + '枚は EXIF が読み取れませんでした。' +
        'Instagram からダウンロードした画像・スクリーンショット・SNS 経由で受け取った画像は' +
        'EXIF が削除されているため、撮影前のオリジナルファイルを読み込んでください。';
    } else {
      note.hidden = true;
    }

    renderPreviewNote();
  }

  /* HEIC などブラウザが表示できない形式を読み込んだときの案内 */
  function renderPreviewNote() {
    var hidden = state.records.filter(function (r) { return r.noPreview; });
    var note = $('previewNote');
    if (!hidden.length) { note.hidden = true; return; }

    var exts = {};
    hidden.forEach(function (r) { if (r.ext) exts[r.ext] = true; });
    var list = Object.keys(exts).join(' / ') || '一部の形式';

    note.hidden = false;
    note.innerHTML = '';
    var line1 = document.createElement('p');
    line1.textContent = hidden.length + '枚は画像を表示できません（' + list +
      '）。Chrome や Edge はこれらの形式を表示できないためで、' +
      'カメラ・レンズ・F値などの撮影データはすべて読み取れています。';
    var line2 = document.createElement('p');
    line2.textContent = 'iPhone の写真を表示したい場合は、iPhone の [設定] → [写真] → ' +
      '[MacまたはPCに転送] を「自動」にすると、パソコンへ取り込むときに JPEG へ変換されます。' +
      'これから撮る写真は [設定] → [カメラ] → [フォーマット] → 「互換性優先」で JPEG になります。';
    line2.className = 'note-sub';
    note.appendChild(line1);
    note.appendChild(line2);
  }

  /* ------------------------------------------------------------ ファイル処理 */

  function showError(message) {
    var box = $('errorBox');
    box.textContent = message;
    box.hidden = !message;
  }

  function setProgress(done, total) {
    var wrap = $('progress');
    if (total === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('progressBar').style.width = Math.round((done / total) * 100) + '%';
    $('progressText').textContent = done + ' / ' + total + ' 枚を解析中…';
    if (done >= total) {
      setTimeout(function () { wrap.hidden = true; }, 400);
    }
  }

  /* ブラウザが <img> で表示できる形式か（Windows では file.type が空のことがある） */
  function isRenderable(file) {
    return /^image\/(jpeg|png|webp|gif|avif)$/i.test(file.type) ||
      /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name);
  }

  function trackUrl(url) {
    state.thumbUrls.push(url);
    return url;
  }

  /*
   * 一覧用のサムネイルを作る。
   * 表示できる形式はファイル自身を参照するだけ（ディスク上のまま）。
   * RAW / HEIC の埋め込みプレビューは数MBあるため、縮小した小さな画像に置き換えて
   * メモリを節約する。カード作成時は元のプレビューを読み直す。
   */
  function buildThumb(file, exif) {
    if (state.thumbUrls.length >= MAX_THUMBS) return Promise.resolve({ url: null });
    if (isRenderable(file)) {
      return Promise.resolve({ url: trackUrl(URL.createObjectURL(file)), embedded: false });
    }
    if (!exif || !exif.thumbnail) return Promise.resolve({ url: null });

    var blob = new Blob([exif.thumbnail], { type: 'image/jpeg' });
    return shrink(blob).then(function (small) {
      return { url: trackUrl(URL.createObjectURL(small || blob)), embedded: true };
    });
  }

  /* 画像を一覧表示に十分な大きさまで縮小する（失敗したら null） */
  function shrink(blob, maxSide) {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return createImageBitmap(blob).then(function (bitmap) {
      var max = maxSide || 200;
      var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (out) { resolve(out); }, 'image/jpeg', 0.85);
      });
    }).catch(function () { return null; });
  }

  function processFiles(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (file) {
      return IMAGE_RE.test(file.name) || /^image\//.test(file.type);
    });
    if (!files.length) {
      showError('画像ファイルが見つかりませんでした。JPEG / HEIC などの写真を選んでください。');
      return Promise.resolve();
    }
    showError('');

    var done = 0;
    setProgress(0, files.length);

    // 大量ファイルでも UI を止めないよう少しずつ処理する
    var CHUNK = 12;
    var index = 0;

    function step() {
      var slice = files.slice(index, index + CHUNK);
      index += CHUNK;
      if (!slice.length) {
        render();
        return Promise.resolve();
      }
      return Promise.all(slice.map(function (file) {
        return ExifReader.parseFile(file)
          .catch(function () { return null; })
          .then(function (exif) {
            var record = Object.assign({
              id: 'f-' + state.records.length,
              name: file.name,
              size: file.size,
              source: 'file',
              estimated: false,
              camera: null, lens: null, fNumber: null, exposureTime: null,
              iso: null, focalLength: null, focal35: null, dateTime: null, hasGps: false
            }, exif || {});
            record.hasExif = !!(exif && (exif.camera || exif.fNumber || exif.focalLength || exif.iso));
            if (!record.dateTime && file.lastModified) record.dateTime = new Date(file.lastModified);
            record.ext = (file.name.split('.').pop() || '').toUpperCase().slice(0, 5);
            record.file = file;
            record.thumb = exif ? exif.thumb : null;

            return buildThumb(file, exif).then(function (thumb) {
              record.thumbUrl = thumb.url;
              record.embedded = !!thumb.embedded;
              record.noPreview = !thumb.url;
              record.thumbnail = null; // バイト列は URL 化したので保持しない
              if (exif) exif.thumbnail = null;
              state.records.push(record);
              done++;
              setProgress(done, files.length);
            });
          });
      })).then(function () {
        render();
        return new Promise(function (resolve) { setTimeout(function () { resolve(step()); }, 0); });
      });
    }

    return step();
  }

  function processJson(file) {
    return file.text().then(function (text) {
      var json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        showError('JSON を読み込めませんでした: ' + file.name);
        return;
      }
      var records = InstagramExport.parse(json);
      if (!records.length) {
        showError('この JSON からは投稿データを見つけられませんでした。' +
          'Instagram のエクスポート（JSON 形式）内の posts_1.json などを選んでください。');
        return;
      }
      showError('');
      records.forEach(function (record) {
        record.id = 'ig-' + state.records.length;
        state.records.push(record);
      });
      render();
    });
  }

  /* ---------------------------------------------------------------- CSV 出力 */

  function toCsv(records) {
    var header = ['ファイル名', 'カメラ', 'レンズ', '焦点距離mm', '35mm換算mm', 'F値', 'シャッター速度秒', 'ISO', '撮影日時', '取得元'];
    var rows = records.map(function (r) {
      return [
        r.name,
        r.camera || '',
        r.lens || '',
        r.focalLength || '',
        r.focal35 || '',
        r.fNumber ? Math.round(r.fNumber * 10) / 10 : '',
        r.exposureTime || '',
        r.iso || '',
        r.dateTime ? r.dateTime.toISOString() : '',
        r.source === 'instagram' ? (r.estimated ? 'Instagram(推定)' : 'Instagram') : 'EXIF'
      ];
    });
    return [header].concat(rows).map(function (row) {
      return row.map(function (cell) {
        var s = String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  function downloadCsv() {
    var csv = '﻿' + toCsv(sortedRecords(filteredRecords()));
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'camera-stats.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ------------------------------------------------------------ サンプルデータ */

  function sampleRecords() {
    var setups = [
      { camera: 'SONY ILCE-7M4', lens: 'FE 35mm F1.8', focal: [35], f: [1.8, 2.0, 2.5, 2.8, 4.0], weight: 34 },
      { camera: 'SONY ILCE-7M4', lens: 'FE 24-70mm F2.8 GM II', focal: [24, 28, 35, 50, 70], f: [2.8, 4.0, 5.6, 8.0], weight: 28 },
      { camera: 'SONY ILCE-7M4', lens: 'FE 70-200mm F4 G', focal: [70, 105, 135, 200], f: [4.0, 5.6, 8.0], weight: 14 },
      { camera: 'FUJIFILM X100V', lens: '23mm F2 (固定)', focal: [23], f: [2.0, 2.8, 4.0, 5.6], weight: 18 },
      { camera: 'Apple iPhone 15 Pro', lens: 'iPhone 15 Pro back camera 6.86mm f/1.78', focal: [6.9], f: [1.78], weight: 16 }
    ];
    var isos = [100, 100, 200, 200, 400, 400, 800, 1600, 3200];
    var shutters = [1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 8, 1];
    var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

    var records = [];
    setups.forEach(function (setup) {
      for (var i = 0; i < setup.weight * 2; i++) {
        var focal = pick(setup.focal);
        // 夕方〜夜に偏らせて、実際の撮影傾向らしく見せる
        var hour = pick([7, 9, 11, 13, 15, 16, 17, 17, 18, 18, 19, 20, 21]);
        var date = new Date(2025, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), hour,
          Math.floor(Math.random() * 60));
        records.push({
          id: 's-' + records.length,
          name: 'sample_' + String(records.length + 1).padStart(4, '0') + '.jpg',
          source: 'sample',
          estimated: false,
          camera: setup.camera,
          lens: setup.lens,
          focalLength: focal,
          focal35: setup.camera.indexOf('X100V') >= 0 ? Math.round(focal * 1.5)
            : (setup.camera.indexOf('iPhone') >= 0 ? 24 : focal),
          fNumber: pick(setup.f),
          exposureTime: pick(shutters),
          iso: pick(isos),
          dateTime: date,
          hasGps: Math.random() < 0.2,
          hasExif: true,
          thumbUrl: null
        });
      }
    });
    return records;
  }

  /* ------------------------------------------------------------------ 初期化 */

  function reset() {
    state.thumbUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.thumbUrls = [];
    state.records = [];
    state.filters = { camera: null, lens: null };
    showError('');
    render();
  }

  /* ホーム画面から起動していない場合だけ、追加方法の案内を出す */
  function showInstallHint() {
    var hint = $('installHint');
    if (!hint) return;
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    hint.hidden = standalone;
  }

  function init() {
    var dropzone = $('dropzone');
    showInstallHint();

    ['dragenter', 'dragover'].forEach(function (type) {
      dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        dropzone.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      dropzone.addEventListener(type, function (event) {
        event.preventDefault();
        if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
        dropzone.classList.remove('is-over');
      });
    });
    dropzone.addEventListener('drop', function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) processFiles(files);
    });

    $('fileInput').addEventListener('change', function (event) {
      processFiles(event.target.files);
      event.target.value = '';
    });
    $('folderInput').addEventListener('change', function (event) {
      processFiles(event.target.files);
      event.target.value = '';
    });
    $('jsonInput').addEventListener('change', function (event) {
      var file = event.target.files[0];
      if (file) processJson(file);
      event.target.value = '';
    });

    $('sampleBtn').addEventListener('click', function () {
      state.records = state.records.concat(sampleRecords());
      showError('');
      render();
    });
    $('clearBtn').addEventListener('click', reset);
    $('csvBtn').addEventListener('click', downloadCsv);

    $('focalToggle').addEventListener('change', function (event) {
      state.use35 = event.target.checked;
      render();
    });

    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.dataset.sort;
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort.key = key;
          state.sort.dir = key === 'name' || key === 'camera' || key === 'lens' ? 'asc' : 'desc';
        }
        render();
      });
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
