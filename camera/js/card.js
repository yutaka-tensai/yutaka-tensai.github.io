/*
 * card.js - 写真と撮影データを1枚のカード画像に合成して PNG で書き出す
 *
 * 元の写真ファイルは一切書き換えず、canvas 上に新しい画像を組み立てる。
 */
(function (global) {
  'use strict';

  var ORIENTATIONS = {
    portrait: { label: '縦 4:5', w: 1080, h: 1350 },
    square: { label: '正方形 1:1', w: 1080, h: 1080 },
    landscape: { label: '横 4:3', w: 1440, h: 1080 }
  };

  var THEMES = {
    white: { label: 'ホワイト', bg: '#ffffff', text: '#16181d', dim: '#7a828c', accent: '#d2601a' },
    black: { label: 'ブラック', bg: '#101216', text: '#f2f4f7', dim: '#98a1ac', accent: '#4cc2ff' },
    cream: { label: 'クリーム', bg: '#f4efe6', text: '#3a332a', dim: '#8a7f70', accent: '#b4622c' },
    navy: { label: 'ネイビー', bg: '#12203a', text: '#eef3fb', dim: '#93a7c6', accent: '#f0b44b' }
  };

  var FONTS = {
    gothic: { label: 'ゴシック', stack: '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", system-ui, sans-serif' },
    mincho: { label: '明朝', stack: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif' },
    mono: { label: '等幅', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
    serif: { label: '欧文セリフ', stack: 'Georgia, "Times New Roman", "Yu Mincho", serif' }
  };

  /*
   * カードに載せられる項目。
   * line: 見出し行 / spec: 撮影設定の行 / meta: 右下に小さく出す情報
   */
  var ITEMS = [
    { key: 'camera', label: 'カメラ名', group: 'line', on: true },
    { key: 'lens', label: 'レンズ名', group: 'line', on: true },
    { key: 'fileName', label: 'ファイル名', group: 'line', on: false },
    { key: 'focal', label: '焦点距離', group: 'spec', on: true },
    { key: 'focal35', label: '35mm換算', group: 'spec', on: false },
    { key: 'fNumber', label: 'F値', group: 'spec', on: true },
    { key: 'shutter', label: 'シャッター速度', group: 'spec', on: true },
    { key: 'iso', label: 'ISO感度', group: 'spec', on: true },
    { key: 'ev', label: '露出補正', group: 'spec', on: false },
    { key: 'mode', label: '撮影モード', group: 'spec', on: false },
    { key: 'date', label: '撮影日', group: 'meta', on: true },
    { key: 'time', label: '撮影時刻', group: 'meta', on: false }
  ];

  var state = {
    data: null,
    image: null,
    previewUrl: null,
    orientation: 'portrait',
    theme: 'white',
    font: 'gothic',
    accent: null,
    title: '',
    show: {}
  };

  ITEMS.forEach(function (item) { state.show[item.key] = item.on; });

  /* 選択されていて、かつ値がある項目だけを取り出す */
  function pick(group) {
    var fields = (state.data && state.data.fields) || {};
    return ITEMS.filter(function (item) {
      return item.group === group && state.show[item.key] && fields[item.key];
    }).map(function (item) {
      return item.key === 'lens'
        ? stripCameraPrefix(lensLabel(fields[item.key]))
        : fields[item.key];
    }).filter(Boolean);
  }

  // "iPhone 15 Pro back camera 6.86mm f/1.78" のように、レンズ名の末尾に
  // 焦点距離と F値が入っている機種がある。撮影設定の行と二重になるため、
  // そちらに出している項目だけをレンズ名から取り除く。
  //
  // ただし "FE 35mm F1.8" のように mm と F値が製品名そのものである場合は削らない。
  // 見分けは、スマートフォンの実焦点距離が小数になること（6.86mm）と、
  // 名前に camera が入ることで行う。
  var LENS_SPEC_RE = /\s*(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s*mm)?\s*(?:f\/|F)\s*(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)\s*$/i;

  function lensLabel(lens) {
    var match = lens.match(LENS_SPEC_RE);
    if (!match) return lens;

    var focal = match[1] || '';
    var isModuleName = focal.indexOf('.') >= 0 || /camera/i.test(lens);
    if (!isModuleName) return lens;

    var dropFocal = !!focal && (state.show.focal || state.show.focal35);
    var dropAperture = state.show.fNumber;
    if (!dropFocal && !dropAperture) return lens;

    // 仕様表記を除いた部分だけで名前として成り立つかを見る
    var base = lens.slice(0, match.index).trim();
    var words = base.split(/\s+/).filter(Boolean);
    if (words.length < 2 || base.length < 6) return lens;

    var trimmed = base;
    if (!dropFocal && focal) trimmed += ' ' + focal;   // F値だけ消す
    if (!dropAperture) trimmed += ' F' + match[2];     // 焦点距離だけ消す
    return trimmed.trim();
  }

  /*
   * "Apple iPhone 15 Pro" の下に "iPhone 15 Pro back camera" と並ぶと機種名が重複する。
   * カメラ名を表示しているときだけ、レンズ名の先頭から機種名を取り除いて
   * "back camera" のようにする。
   */
  function stripCameraPrefix(lens) {
    if (!state.show.camera) return lens;
    var fields = (state.data && state.data.fields) || {};
    var candidates = [fields.camera, fields.model].filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });

    for (var i = 0; i < candidates.length; i++) {
      var prefix = candidates[i];
      if (lens.length <= prefix.length) continue;
      if (lens.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) continue;
      var rest = lens.slice(prefix.length).replace(/^[\s:\-—]+/, '').trim();
      if (rest.length >= 3) return rest;
    }
    return lens;
  }

  var el = {};

  function $(id) { return document.getElementById(id); }

  function theme() {
    var base = THEMES[state.theme];
    return {
      bg: base.bg, text: base.text, dim: base.dim,
      accent: state.accent || base.accent
    };
  }

  function font(size, weight) {
    return (weight ? weight + ' ' : '') + Math.round(size) + 'px ' + FONTS[state.font].stack;
  }

  /* 幅に収まらない文字列を末尾省略する */
  function ellipsize(ctx, text, maxWidth) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxWidth) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + '…';
  }

  function draw() {
    var canvas = el.canvas;
    var size = ORIENTATIONS[state.orientation];
    canvas.width = size.w;
    canvas.height = size.h;

    var ctx = canvas.getContext('2d');
    var t = theme();
    var W = size.w, H = size.h;

    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);

    var pad = Math.round(W * 0.052);
    var titleSize = W * 0.036;
    var headSize = W * 0.030;
    var subSize = W * 0.023;
    var specSize = W * 0.026;
    var gap = W * 0.016;
    var photoGap = gap * 1.6;

    var title = state.title.trim();
    var lines = pick('line');          // カメラ名・レンズ名・ファイル名
    var meta = pick('meta').join(' '); // 撮影日・時刻

    var head = lines.length ? lines[0] : '';
    var subs = lines.slice(1);

    // 撮影設定は項目が多いと1行に入りきらないので、必要なら2行に折り返す
    ctx.font = font(specSize * 0.8);
    var metaW = meta ? ctx.measureText(meta).width + gap : 0;
    var specLines = wrapSpecs(ctx, pick('spec'), specSize, W - pad * 2 - metaW);

    // 情報エリアの高さを先に見積もり、残りを写真に割り当てる
    var infoH = 0;
    if (title) infoH += titleSize * 1.35;
    if (head) infoH += headSize * 1.25;
    infoH += subs.length * subSize * 1.5;
    if (specLines.length || meta) {
      infoH += gap * 1.5 + specSize * 1.5 * Math.max(1, specLines.length);
    }

    var boxW = W - pad * 2;
    var boxH = H - pad * 2 - infoH - (infoH ? photoGap : 0);

    // 写真は切り抜かず全体を収め、写真＋情報のまとまりを上下中央に置く
    var drawnH = 0;
    var left = pad;
    var textW = boxW;
    var top = pad;
    if (state.image) {
      var iw = state.image.naturalWidth || state.image.width;
      var ih = state.image.naturalHeight || state.image.height;
      var scale = Math.min(boxW / iw, boxH / ih);
      var dw = iw * scale;
      drawnH = ih * scale;
      top = Math.max(pad, (H - (drawnH + photoGap + infoH)) / 2);
      left = pad + (boxW - dw) / 2;
      textW = dw;
      ctx.drawImage(state.image, left, top, dw, drawnH);
    }

    var y = top + drawnH + (infoH ? photoGap : 0);

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    if (title) {
      ctx.fillStyle = t.text;
      ctx.font = font(titleSize, '700');
      ctx.fillText(ellipsize(ctx, title, textW), left, y);
      y += titleSize * 1.35;
    }

    if (head) {
      ctx.fillStyle = t.text;
      ctx.font = font(headSize, '600');
      ctx.fillText(ellipsize(ctx, head, textW), left, y);
      y += headSize * 1.25;
    }

    ctx.fillStyle = t.dim;
    ctx.font = font(subSize);
    subs.forEach(function (line) {
      ctx.fillText(ellipsize(ctx, line, textW), left, y);
      y += subSize * 1.5;
    });

    if (!specLines.length && !meta) return;

    y += gap * 0.5;

    // アクセント色の区切り線
    ctx.fillStyle = t.accent;
    ctx.fillRect(left, Math.round(y), Math.round(W * 0.07), Math.max(2, Math.round(W * 0.003)));
    y += gap;

    // 撮影設定（日付は最終行の右端にそろえる）
    var metaSize = specSize * 0.8;
    ctx.fillStyle = t.text;
    ctx.font = font(specSize, '500');
    var lastY = y;
    specLines.forEach(function (line, index) {
      lastY = y + index * specSize * 1.5;
      var width = index === specLines.length - 1 ? textW - metaW : textW;
      ctx.fillText(ellipsize(ctx, line, width), left, lastY);
    });

    if (meta) {
      ctx.fillStyle = t.dim;
      ctx.font = font(metaSize);
      ctx.textAlign = 'right';
      ctx.fillText(meta, left + textW, lastY + (specSize - metaSize) * 0.6);
      ctx.textAlign = 'left';
    }
  }

  /* 撮影設定を1行に収める。入らなければ2行に分ける。 */
  function wrapSpecs(ctx, items, size, maxWidth) {
    if (!items.length) return [];
    var separator = '   ';
    ctx.font = font(size, '500');
    var single = items.join(separator);
    if (ctx.measureText(single).width <= maxWidth || items.length < 2) return [single];

    // 2行の幅ができるだけ均等になる位置で分ける
    var best = null;
    for (var i = 1; i < items.length; i++) {
      var a = items.slice(0, i).join(separator);
      var b = items.slice(i).join(separator);
      var diff = Math.abs(ctx.measureText(a).width - ctx.measureText(b).width);
      if (!best || diff < best.diff) best = { diff: diff, lines: [a, b] };
    }
    return best.lines;
  }

  function buildOptions(container, options, current, onPick) {
    container.innerHTML = '';
    Object.keys(options).forEach(function (key) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'opt' + (key === current ? ' is-active' : '');
      button.textContent = options[key].label;
      button.dataset.key = key;
      if (options[key].bg) {
        var dot = document.createElement('span');
        dot.className = 'opt-dot';
        dot.style.background = options[key].bg;
        dot.style.borderColor = options[key].text;
        button.insertBefore(dot, button.firstChild);
      }
      button.addEventListener('click', function () { onPick(key); });
      container.appendChild(button);
    });
  }

  var GROUP_LABELS = { line: '見出し', spec: '撮影設定', meta: '日時' };

  function renderItems() {
    var container = el.items;
    container.innerHTML = '';
    ['line', 'spec', 'meta'].forEach(function (group) {
      var box = document.createElement('div');
      box.className = 'item-group';
      var head = document.createElement('span');
      head.className = 'item-group-label';
      head.textContent = GROUP_LABELS[group];
      box.appendChild(head);

      ITEMS.filter(function (item) { return item.group === group; }).forEach(function (item) {
        var fields = (state.data && state.data.fields) || {};
        var label = document.createElement('label');
        label.className = 'toggle';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!state.show[item.key];
        input.dataset.key = item.key;
        // 値が無い項目は選んでも出せないので、その旨を示す
        if (!fields[item.key]) {
          label.classList.add('is-empty');
          label.title = 'この写真にはこの情報がありません';
        }
        input.addEventListener('change', function () {
          state.show[item.key] = input.checked;
          draw();
        });
        var span = document.createElement('span');
        span.textContent = item.label;
        label.appendChild(input);
        label.appendChild(span);
        box.appendChild(label);
      });
      container.appendChild(box);
    });
  }

  function renderControls() {
    buildOptions(el.orientation, ORIENTATIONS, state.orientation, function (key) {
      state.orientation = key; refresh();
    });
    buildOptions(el.theme, THEMES, state.theme, function (key) {
      state.theme = key;
      state.accent = null; // テーマ変更時はそのテーマの標準アクセント色に戻す
      el.accent.value = THEMES[key].accent;
      refresh();
    });
    buildOptions(el.font, FONTS, state.font, function (key) {
      state.font = key; refresh();
    });
  }

  function refresh() {
    renderControls();
    renderItems();
    draw();
  }

  function download() {
    el.canvas.toBlob(function (blob) {
      if (!blob) return;
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var base = (state.data.name || 'photo').replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = base + '-card.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }, 'image/png');
  }

  function releasePreview() {
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
  }

  function close() {
    el.modal.hidden = true;
    state.image = null;
    releasePreview();
    document.body.classList.remove('is-locked');
  }

  function open(data) {
    state.data = data;
    state.title = '';
    state.image = null;
    el.title.value = '';
    el.note.hidden = true;
    el.modal.hidden = false;
    document.body.classList.add('is-locked');
    refresh();

    releasePreview();
    data.loadPreview().then(function (preview) {
      if (!preview || !preview.url) { refresh(); return; }
      if (preview.temporary) state.previewUrl = preview.url;

      var image = new Image();
      image.onload = function () {
        state.image = image;
        // 写真の向きに合わせてカードの向きを初期選択する
        var ratio = image.naturalWidth / image.naturalHeight;
        state.orientation = ratio > 1.1 ? 'landscape' : (ratio < 0.95 ? 'portrait' : 'square');
        // 埋め込みプレビューは元画像より小さいので、粗くなる場合だけ注意書きを出す
        el.note.hidden = Math.max(image.naturalWidth, image.naturalHeight) >= 1200;
        refresh();
      };
      image.onerror = function () {
        state.image = null;
        refresh();
      };
      image.src = preview.url;
    });
  }

  function init() {
    el.modal = $('cardModal');
    if (!el.modal) return;
    el.canvas = $('cardCanvas');
    el.orientation = $('cardOrientation');
    el.theme = $('cardTheme');
    el.font = $('cardFont');
    el.accent = $('cardAccent');
    el.title = $('cardTitle');
    el.note = $('cardNote');
    el.items = $('cardItems');

    el.accent.value = THEMES[state.theme].accent;
    el.accent.addEventListener('input', function () {
      state.accent = el.accent.value;
      draw();
    });
    $('cardAccentReset').addEventListener('click', function () {
      state.accent = null;
      el.accent.value = THEMES[state.theme].accent;
      draw();
    });
    el.title.addEventListener('input', function () {
      state.title = el.title.value;
      draw();
    });
    $('cardDownload').addEventListener('click', download);
    $('cardClose').addEventListener('click', close);
    el.modal.addEventListener('click', function (event) {
      if (event.target === el.modal) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !el.modal.hidden) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.PhotoCard = {
    open: open,
    lensLabel: function (lens) { return stripCameraPrefix(lensLabel(lens)); }
  };
})(window);
