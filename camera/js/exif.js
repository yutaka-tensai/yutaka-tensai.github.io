/*
 * exif.js - 依存ライブラリなしの最小 EXIF パーサ
 *
 * JPEG の APP1 セグメントを走査して TIFF ブロックを探し、見つからない場合は
 * ファイル先頭数MBから "Exif\0\0" シグネチャを総当たりで探す。
 * 後者のフォールバックにより HEIC / WebP / TIFF など JPEG 以外でも
 * EXIF が素のまま埋め込まれていれば読み取れる。
 */
(function (global) {
  'use strict';

  // IFD0 (画像本体)
  var TAG_MAKE = 0x010f;
  var TAG_MODEL = 0x0110;
  var TAG_ORIENTATION = 0x0112;
  var TAG_DATETIME = 0x0132;
  var TAG_EXIF_IFD = 0x8769;
  var TAG_GPS_IFD = 0x8825;

  // Exif IFD
  var TAG_EXPOSURE_TIME = 0x829a;
  var TAG_FNUMBER = 0x829d;
  var TAG_EXPOSURE_PROGRAM = 0x8822;
  var TAG_ISO = 0x8827;
  var TAG_RECOMMENDED_EI = 0x8832;
  var TAG_DATETIME_ORIGINAL = 0x9003;
  var TAG_SHUTTER_SPEED_VALUE = 0x9201;
  var TAG_APERTURE_VALUE = 0x9202;
  var TAG_EXPOSURE_BIAS = 0x9204;
  var TAG_METERING_MODE = 0x9207;
  var TAG_FOCAL_LENGTH = 0x920a;
  var TAG_PIXEL_X = 0xa002;
  var TAG_PIXEL_Y = 0xa003;
  var TAG_EXPOSURE_MODE = 0xa402;
  var TAG_WHITE_BALANCE = 0xa403;
  var TAG_FOCAL_35MM = 0xa405;
  var TAG_LENS_SPEC = 0xa432;
  var TAG_LENS_MAKE = 0xa433;
  var TAG_LENS_MODEL = 0xa434;

  // GPS IFD
  var TAG_GPS_LAT = 0x0002;
  var TAG_GPS_LON = 0x0004;

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function ascii(view, offset, length) {
    var out = '';
    for (var i = 0; i < length; i++) {
      var c = view.getUint8(offset + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /* JPEG のマーカーを辿って APP1(Exif) の TIFF 先頭オフセットを返す */
  function findExifInJpeg(view) {
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return -1;
    var offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset++; continue; }
      var marker = view.getUint8(offset + 1);
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      if (marker === 0xda) return -1; // 画像データ本体に到達
      var length = view.getUint16(offset + 2);
      if (length < 2) return -1;
      if (marker === 0xe1 && offset + 10 <= view.byteLength &&
          ascii(view, offset + 4, 4) === 'Exif') {
        return offset + 10;
      }
      offset += 2 + length;
    }
    return -1;
  }

  /* コンテナ形式を問わず "Exif\0\0" + TIFF ヘッダを探す（HEIC などの保険） */
  function findExifAnywhere(buffer) {
    var bytes = new Uint8Array(buffer);
    var limit = Math.min(bytes.length - 8, 4 * 1024 * 1024);
    for (var i = 0; i < limit; i++) {
      if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 &&
          bytes[i + 3] === 0x66 && bytes[i + 4] === 0x00 && bytes[i + 5] === 0x00) {
        var a = bytes[i + 6], b = bytes[i + 7];
        if ((a === 0x49 && b === 0x49) || (a === 0x4d && b === 0x4d)) return i + 6;
      }
    }
    return -1;
  }

  function readValue(view, entryOffset, tiffStart, little) {
    var type = view.getUint16(entryOffset + 2, little);
    var count = view.getUint32(entryOffset + 4, little);
    var unit = TYPE_SIZE[type];
    if (!unit || count === 0 || count > 100000) return null;
    var total = unit * count;
    var valueOffset = total <= 4 ? entryOffset + 8 : tiffStart + view.getUint32(entryOffset + 8, little);
    if (valueOffset < 0 || valueOffset + total > view.byteLength) return null;

    if (type === 2) return ascii(view, valueOffset, count).trim();

    var values = [];
    for (var i = 0; i < count; i++) {
      var p = valueOffset + i * unit;
      switch (type) {
        case 1: case 7: values.push(view.getUint8(p)); break;
        case 6: values.push(view.getInt8(p)); break;
        case 3: values.push(view.getUint16(p, little)); break;
        case 8: values.push(view.getInt16(p, little)); break;
        case 4: values.push(view.getUint32(p, little)); break;
        case 9: values.push(view.getInt32(p, little)); break;
        case 11: values.push(view.getFloat32(p, little)); break;
        case 12: values.push(view.getFloat64(p, little)); break;
        case 5: {
          var n = view.getUint32(p, little), d = view.getUint32(p + 4, little);
          values.push(d === 0 ? 0 : n / d);
          break;
        }
        case 10: {
          var sn = view.getInt32(p, little), sd = view.getInt32(p + 4, little);
          values.push(sd === 0 ? 0 : sn / sd);
          break;
        }
        default: return null;
      }
    }
    return count === 1 ? values[0] : values;
  }

  /* 1つの IFD を読み、{tag: value} を tags に詰めつつサブ IFD のポインタを返す */
  function readIfd(view, ifdOffset, tiffStart, little, tags) {
    if (ifdOffset + 2 > view.byteLength) return {};
    var count = view.getUint16(ifdOffset, little);
    if (count > 512) return {};
    var pointers = {};
    for (var i = 0; i < count; i++) {
      var entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      var tag = view.getUint16(entry, little);
      var value = readValue(view, entry, tiffStart, little);
      if (value === null || value === '') continue;
      if (tag === TAG_EXIF_IFD || tag === TAG_GPS_IFD) pointers[tag] = value;
      tags[tag] = value;
    }
    return pointers;
  }

  function parseTiff(view, tiffStart) {
    if (tiffStart + 8 > view.byteLength) return null;
    var order = view.getUint16(tiffStart);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    var little = order === 0x4949;
    if (view.getUint16(tiffStart + 2, little) !== 42) return null;

    var ifd0 = tiffStart + view.getUint32(tiffStart + 4, little);
    var tags = {};
    var pointers = readIfd(view, ifd0, tiffStart, little, tags);

    var gps = {};
    if (pointers[TAG_EXIF_IFD]) {
      readIfd(view, tiffStart + pointers[TAG_EXIF_IFD], tiffStart, little, tags);
    }
    if (pointers[TAG_GPS_IFD]) {
      readIfd(view, tiffStart + pointers[TAG_GPS_IFD], tiffStart, little, gps);
    }
    return { tags: tags, gps: gps };
  }

  function first(value) {
    return Array.isArray(value) ? value[0] : value;
  }

  function num(value) {
    var v = first(value);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function text(value) {
    if (typeof value !== 'string') return null;
    var s = value.replace(/\0/g, '').trim();
    // 一部の機種が入れる無意味なプレースホルダを除外
    if (!s || /^-+$/.test(s) || /^(unknown|n\/a|none)$/i.test(s)) return null;
    return s;
  }

  /* "SONY" + "ILCE-7M4" のような重複を避けてカメラ名を組み立てる */
  function buildCamera(make, model) {
    if (!model) return make || null;
    if (!make) return model;
    var m = make.replace(/\s+(corporation|corp\.?|company|co\.?,?\s*ltd\.?|imaging.*)$/i, '').trim();
    var head = m.split(/\s+/)[0];
    if (head && model.toLowerCase().indexOf(head.toLowerCase()) === 0) return model;
    return m + ' ' + model;
  }

  /* LensSpecification(4 rational) から "24-70mm F2.8" 相当の文字列を作る */
  function lensFromSpec(spec) {
    if (!Array.isArray(spec) || spec.length < 4) return null;
    var minF = spec[0], maxF = spec[1], minA = spec[2], maxA = spec[3];
    if (!minF || !maxF) return null;
    var range = Math.abs(minF - maxF) < 0.5
      ? Math.round(minF) + 'mm'
      : Math.round(minF) + '-' + Math.round(maxF) + 'mm';
    var ap = '';
    if (minA) {
      ap = (Math.abs(minA - maxA) < 0.05 || !maxA)
        ? ' F' + trimNum(minA)
        : ' F' + trimNum(minA) + '-' + trimNum(maxA);
    }
    return range + ap;
  }

  function trimNum(n) {
    return String(Math.round(n * 10) / 10);
  }

  /* "2024:05:03 18:22:10" 形式を Date に */
  function parseExifDate(value) {
    var s = text(value);
    if (!s) return null;
    var m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d;
  }

  var EXPOSURE_PROGRAM = {
    0: '未定義', 1: 'マニュアル', 2: 'プログラムAE', 3: '絞り優先', 4: 'シャッター優先',
    5: 'クリエイティブ', 6: 'アクション', 7: 'ポートレート', 8: '風景'
  };

  /* ArrayBuffer から EXIF を抽出して正規化済みオブジェクトを返す */
  function parseBuffer(buffer) {
    var view = new DataView(buffer);
    var start = findExifInJpeg(view);
    if (start < 0) start = findExifAnywhere(buffer);
    if (start < 0) return null;

    var parsed = parseTiff(view, start);
    if (!parsed) return null;
    var t = parsed.tags;

    var make = text(t[TAG_MAKE]);
    var model = text(t[TAG_MODEL]);
    var iso = num(t[TAG_ISO]) || num(t[TAG_RECOMMENDED_EI]);
    var lens = text(t[TAG_LENS_MODEL]) || lensFromSpec(t[TAG_LENS_SPEC]);
    var lensMake = text(t[TAG_LENS_MAKE]);
    if (lens && lensMake && lens.toLowerCase().indexOf(lensMake.toLowerCase().split(/\s+/)[0]) !== 0) {
      lens = lensMake + ' ' + lens;
    }

    var fNumber = num(t[TAG_FNUMBER]);
    if (!fNumber && num(t[TAG_APERTURE_VALUE]) != null) {
      fNumber = Math.pow(2, num(t[TAG_APERTURE_VALUE]) / 2); // APEX -> F値
    }
    var exposure = num(t[TAG_EXPOSURE_TIME]);
    if (!exposure && num(t[TAG_SHUTTER_SPEED_VALUE]) != null) {
      exposure = Math.pow(2, -num(t[TAG_SHUTTER_SPEED_VALUE])); // APEX -> 秒
    }

    var program = num(t[TAG_EXPOSURE_PROGRAM]);

    return {
      camera: buildCamera(make, model),
      make: make,
      model: model,
      lens: lens,
      fNumber: fNumber && fNumber > 0 ? fNumber : null,
      exposureTime: exposure && exposure > 0 ? exposure : null,
      iso: iso && iso > 0 ? iso : null,
      focalLength: num(t[TAG_FOCAL_LENGTH]),
      focal35: num(t[TAG_FOCAL_35MM]),
      exposureBias: num(t[TAG_EXPOSURE_BIAS]),
      program: program != null ? (EXPOSURE_PROGRAM[program] || null) : null,
      width: num(t[TAG_PIXEL_X]),
      height: num(t[TAG_PIXEL_Y]),
      orientation: num(t[TAG_ORIENTATION]),
      dateTime: parseExifDate(t[TAG_DATETIME_ORIGINAL]) || parseExifDate(t[TAG_DATETIME]),
      hasGps: !!(parsed.gps[TAG_GPS_LAT] && parsed.gps[TAG_GPS_LON])
    };
  }

  /* File を読み込んで EXIF を返す。先頭 2MB で足りなければ全体を読み直す。 */
  function parseFile(file) {
    return readSlice(file, Math.min(file.size, 2 * 1024 * 1024))
      .then(function (buffer) {
        var result = parseBuffer(buffer);
        if (result || file.size <= 2 * 1024 * 1024) return result;
        return readSlice(file, file.size).then(parseBuffer);
      });
  }

  function readSlice(file, bytes) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('read failed')); };
      reader.readAsArrayBuffer(file.slice(0, bytes));
    });
  }

  global.ExifReader = {
    parseFile: parseFile,
    parseBuffer: parseBuffer,
    buildCamera: buildCamera
  };
})(window);
