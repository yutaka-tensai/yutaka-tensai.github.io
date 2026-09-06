/*
 * charts.js - 依存なしの軽量チャート（DOM/CSS ベース）
 * items: [{ key, label, value, sub }]
 */
(function (global) {
  'use strict';

  function el(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  function pct(value, max) {
    return max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  }

  function empty(container, message) {
    container.innerHTML = '';
    container.appendChild(el('p', 'chart-empty', message || 'このデータを持つ写真がありません'));
  }

  /* 横棒グラフ: カメラ・レンズなどラベルが長い項目向け */
  function bars(container, items, options) {
    options = options || {};
    container.innerHTML = '';
    if (!items.length) return empty(container, options.emptyText);

    var max = items.reduce(function (m, d) { return Math.max(m, d.value); }, 0);
    var total = items.reduce(function (s, d) { return s + d.value; }, 0);
    var list = el('div', 'bars');

    items.forEach(function (item) {
      var row = el(options.onSelect ? 'button' : 'div', 'bar-row');
      if (options.onSelect) {
        row.type = 'button';
        row.addEventListener('click', function () { options.onSelect(item); });
        if (options.isActive && options.isActive(item)) row.classList.add('is-active');
      }

      var head = el('div', 'bar-head');
      head.appendChild(el('span', 'bar-label', item.label));
      var share = total > 0 ? Math.round((item.value / total) * 100) : 0;
      head.appendChild(el('span', 'bar-value', item.value + '枚 / ' + share + '%'));
      row.appendChild(head);

      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = pct(item.value, max) + '%';
      track.appendChild(fill);
      row.appendChild(track);

      if (item.sub) row.appendChild(el('div', 'bar-sub', item.sub));
      list.appendChild(row);
    });

    container.appendChild(list);
  }

  /* 縦棒グラフ: ヒストグラム・時間帯などの並び順が意味を持つ項目向け */
  function columns(container, items, options) {
    options = options || {};
    container.innerHTML = '';
    if (!items.length || items.every(function (d) { return !d.value; })) {
      return empty(container, options.emptyText);
    }

    var max = items.reduce(function (m, d) { return Math.max(m, d.value); }, 0);
    var chart = el('div', 'columns');
    if (options.dense) chart.classList.add('is-dense');

    items.forEach(function (item) {
      var col = el(options.onSelect ? 'button' : 'div', 'column');
      if (options.onSelect) {
        col.type = 'button';
        col.addEventListener('click', function () { options.onSelect(item); });
        if (options.isActive && options.isActive(item)) col.classList.add('is-active');
      }
      col.title = item.label + ': ' + item.value + '枚';

      var count = el('span', 'column-count', item.value ? String(item.value) : '');
      var track = el('div', 'column-track');
      var fill = el('div', 'column-fill');
      fill.style.height = pct(item.value, max) + '%';
      track.appendChild(fill);

      col.appendChild(count);
      col.appendChild(track);
      col.appendChild(el('span', 'column-label', item.label));
      chart.appendChild(col);
    });

    container.appendChild(chart);
  }

  global.Charts = { bars: bars, columns: columns };
})(window);
