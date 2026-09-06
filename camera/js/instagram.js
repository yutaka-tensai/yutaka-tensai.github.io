/*
 * instagram.js - Instagram のデータエクスポート(JSON)から撮影情報を拾う
 *
 * Instagram は投稿画像から EXIF を削除するため、写真そのものからは機材情報を
 * 取り出せない。ただしエクスポート JSON には投稿日時・キャプションが含まれ、
 * 一部の投稿には exif_data が残っている。ここでは
 *   1) JSON 内の exif 相当フィールド
 *   2) キャプション本文に書かれた機材表記（"Sony A7IV / 35mm F1.8" など）
 * の2段構えで拾えるものだけを拾う。
 */
(function (global) {
  'use strict';

  var MEDIA_RE = /\.(jpe?g|png|heic|heif|webp|mp4|mov)$/i;

  function normKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function toNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    var m = value.match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  /* "1/125" "0.008" "1/125 sec" などをすべて秒に */
  function toSeconds(value) {
    if (typeof value === 'number') return value > 0 ? value : null;
    if (typeof value !== 'string') return null;
    var frac = value.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (frac) {
      var d = parseFloat(frac[2]);
      return d > 0 ? parseFloat(frac[1]) / d : null;
    }
    var n = toNumber(value);
    return n && n > 0 ? n : null;
  }

  var FIELD_MAP = {
    fnumber: 'fNumber', aperture: 'fNumber', fstop: 'fNumber', aperturevalue: 'fNumber',
    focallength: 'focalLength', focallengthmm: 'focalLength',
    focallengthin35mmfilm: 'focal35', focallength35mm: 'focal35',
    iso: 'iso', isospeed: 'iso', isospeedratings: 'iso', isovalue: 'iso',
    exposuretime: 'exposureTime', shutterspeed: 'exposureTime', shutterspeedvalue: 'exposureTime',
    cameramake: 'make', make: 'make', manufacturer: 'make', devicemanufacturer: 'make',
    cameramodel: 'model', model: 'model', devicemodel: 'model', camera: 'model',
    lensmodel: 'lens', lens: 'lens', lensmake: 'lensMake',
    datetimeoriginal: 'dateText', datetimedigitized: 'dateText', takenat: 'dateText'
  };

  /* 部分木を舐めて exif 相当のキーだけ集める */
  function collectExif(node, into, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return into;
    if (Array.isArray(node)) {
      node.forEach(function (item) { collectExif(item, into, depth + 1); });
      return into;
    }
    Object.keys(node).forEach(function (key) {
      var value = node[key];
      if (value && typeof value === 'object') { collectExif(value, into, depth + 1); return; }
      var field = FIELD_MAP[normKey(key)];
      if (!field || value == null || value === '') return;
      if (into[field] == null) into[field] = value;
    });
    return into;
  }

  var CAPTION_PATTERNS = [
    { field: 'fNumber', re: /(?:^|[\s\/|(#])f[\/\s]?(\d{1,2}(?:\.\d)?)\b/i },
    { field: 'focalLength', re: /(\d{1,3}(?:\.\d)?)\s?mm\b/i },
    { field: 'iso', re: /iso[\s:]?(\d{2,6})\b/i },
    { field: 'exposureTime', re: /(1\s?\/\s?\d{1,5})\s?(?:s|sec|秒)?\b/i }
  ];

  /* キャプション本文から機材表記らしき数値を拾う（あくまで推定） */
  function parseCaption(caption) {
    var out = {};
    if (!caption) return out;
    CAPTION_PATTERNS.forEach(function (p) {
      var m = caption.match(p.re);
      if (!m) return;
      out[p.field] = p.field === 'exposureTime' ? toSeconds(m[1]) : toNumber(m[1]);
    });
    return out;
  }

  function buildRecord(node, ctx, index) {
    var raw = collectExif(node, {}, 0);
    var caption = ctx.caption || '';
    var guessed = parseCaption(caption);

    var make = typeof raw.make === 'string' ? raw.make.trim() : null;
    var model = typeof raw.model === 'string' ? raw.model.trim() : null;
    var fNumber = toNumber(raw.fNumber) || guessed.fNumber || null;
    var focal = toNumber(raw.focalLength) || guessed.focalLength || null;
    var iso = toNumber(raw.iso) || guessed.iso || null;
    var exposure = toSeconds(raw.exposureTime) || guessed.exposureTime || null;

    var date = null;
    if (ctx.timestamp) {
      var ts = Number(ctx.timestamp);
      if (isFinite(ts) && ts > 0) date = new Date(ts < 1e12 ? ts * 1000 : ts);
    }

    var estimated = !!(
      (guessed.fNumber && !toNumber(raw.fNumber)) ||
      (guessed.focalLength && !toNumber(raw.focalLength)) ||
      (guessed.iso && !toNumber(raw.iso))
    );

    return {
      id: 'ig-' + index,
      name: String(node.uri).split('/').pop(),
      source: 'instagram',
      estimated: estimated,
      caption: caption.slice(0, 140),
      camera: global.ExifReader ? global.ExifReader.buildCamera(make, model) : (model || make || null),
      make: make,
      model: model,
      lens: typeof raw.lens === 'string' ? raw.lens.trim() : null,
      fNumber: fNumber,
      focalLength: focal,
      focal35: toNumber(raw.focal35),
      iso: iso,
      exposureTime: exposure,
      dateTime: date && !isNaN(date.getTime()) ? date : null,
      hasGps: false,
      hasExif: !!(make || model || fNumber || focal || iso || exposure)
    };
  }

  function walk(node, ctx, out, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      node.forEach(function (item) { walk(item, ctx, out, depth + 1); });
      return;
    }

    var local = {
      caption: ctx.caption,
      timestamp: ctx.timestamp
    };
    if (typeof node.title === 'string' && node.title) local.caption = node.title;
    if (typeof node.caption === 'string' && node.caption) local.caption = node.caption;
    if (node.creation_timestamp) local.timestamp = node.creation_timestamp;
    if (node.taken_at) local.timestamp = node.taken_at;

    if (typeof node.uri === 'string' && MEDIA_RE.test(node.uri)) {
      out.push(buildRecord(node, local, out.length));
      return;
    }

    Object.keys(node).forEach(function (key) {
      walk(node[key], local, out, depth + 1);
    });
  }

  function parse(json) {
    var out = [];
    walk(json, {}, out, 0);
    return out;
  }

  global.InstagramExport = { parse: parse };
})(window);
