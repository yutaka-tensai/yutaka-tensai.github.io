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

  var state = {
    data: null,
    image: null,
    orientation: 'portrait',
    theme: 'white',
    font: 'gothic',
    accent: null,
    title: '',
    showLens: true,
    showDate: true
  };

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
    var data = state.data || {};

    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);

    var pad = Math.round(W * 0.052);
    var titleSize = W * 0.036;
    var camSize = W * 0.030;
    var lensSize = W * 0.023;
    var specSize = W * 0.026;
    var gap = W * 0.016;

    var title = state.title.trim();
    var lens = state.showLens && data.lens ? data.lens : '';

    // 情報エリアの高さを先に見積もり、残りを写真に割り当てる
    var infoH = camSize * 1.25 + gap * 1.5 + specSize * 1.5;
    if (title) infoH += titleSize * 1.35;
    if (lens) infoH += lensSize * 1.5;

    var boxW = W - pad * 2;
    var boxH = H - pad * 2 - infoH - gap;

    // 写真は切り抜かず全体を収める。写真＋情報のまとまりを上下中央に置くことで、
    // カードの向きと写真の向きが違っても余白が偏らないようにする。
    var drawnH = 0;
    var top = pad;
    var left = pad;          // 情報エリアは写真の左端にそろえる
    var textW = boxW;
    var photoGap = gap * 1.6;
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

    var y = top + drawnH + photoGap;

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    if (title) {
      ctx.fillStyle = t.text;
      ctx.font = font(titleSize, '700');
      ctx.fillText(ellipsize(ctx, title, textW), left, y);
      y += titleSize * 1.35;
    }

    ctx.fillStyle = t.text;
    ctx.font = font(camSize, '600');
    ctx.fillText(ellipsize(ctx, data.camera || 'カメラ情報なし', textW), left, y);
    y += camSize * 1.25;

    if (lens) {
      ctx.fillStyle = t.dim;
      ctx.font = font(lensSize);
      ctx.fillText(ellipsize(ctx, lens, textW), left, y);
      y += lensSize * 1.5;
    }

    y += gap * 0.5;

    // アクセント色の区切り線
    ctx.fillStyle = t.accent;
    ctx.fillRect(left, Math.round(y), Math.round(W * 0.07), Math.max(2, Math.round(W * 0.003)));
    y += gap;

    // 撮影設定（長い場合は文字を少し詰める）
    var specs = (data.specs || []).join('   ');
    var specFontSize = specSize;
    ctx.font = font(specFontSize, '500');
    var dateText = state.showDate && data.dateText ? data.dateText : '';
    ctx.font = font(specSize * 0.8);
    var dateW = dateText ? ctx.measureText(dateText).width + gap : 0;
    while (specFontSize > specSize * 0.6) {
      ctx.font = font(specFontSize, '500');
      if (ctx.measureText(specs).width <= textW - dateW) break;
      specFontSize -= 1;
    }
    ctx.fillStyle = t.text;
    ctx.font = font(specFontSize, '500');
    ctx.fillText(ellipsize(ctx, specs, textW - dateW), left, y);

    if (dateText) {
      ctx.fillStyle = t.dim;
      ctx.font = font(specSize * 0.8);
      ctx.textAlign = 'right';
      ctx.fillText(dateText, left + textW, y + (specFontSize - specSize * 0.8) * 0.6);
      ctx.textAlign = 'left';
    }
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

  function close() {
    el.modal.hidden = true;
    state.image = null;
    document.body.classList.remove('is-locked');
  }

  function open(data) {
    state.data = data;
    state.title = '';
    el.title.value = '';
    el.note.hidden = !data.lowRes;
    el.modal.hidden = false;
    document.body.classList.add('is-locked');

    var image = new Image();
    image.onload = function () {
      state.image = image;
      // 写真の向きに合わせてカードの向きを初期選択する
      var ratio = image.naturalWidth / image.naturalHeight;
      state.orientation = ratio > 1.1 ? 'landscape' : (ratio < 0.95 ? 'portrait' : 'square');
      refresh();
    };
    image.onerror = function () {
      state.image = null;
      refresh();
    };
    image.src = data.imageUrl;
    refresh();
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
    $('cardShowLens').addEventListener('change', function (event) {
      state.showLens = event.target.checked;
      draw();
    });
    $('cardShowDate').addEventListener('change', function (event) {
      state.showDate = event.target.checked;
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

  global.PhotoCard = { open: open };
})(window);
