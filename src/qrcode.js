/* ============================================================
 * payinvoice 内嵌 QR 编码器（纯 JS，无外部依赖）
 * 支持：版本 1-40，纠错等级 L/M/Q/H，数字/字母数字/字节(UTF-8) 模式
 * 依据 ISO/IEC 18004 标准实现
 * ============================================================ */
(function (global) {
'use strict';

/* ---------- GF(256) 运算（本原多项式 0x11D） ---------- */
function gfMul(x, y) {
  var z = 0;
  for (var i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z & 0x80) ? 0x11D : 0);
    z &= 0xFF;
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xFF;
}

/* Reed-Solomon 生成多项式（最高次项在前） */
function rsGenPoly(degree) {
  var poly = [1];
  var root = 1;
  for (var i = 0; i < degree; i++) {
    var next = new Array(poly.length + 1);
    for (var j = 0; j < next.length; j++) next[j] = 0;
    for (var j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                    // 乘以 x
      next[j + 1] ^= gfMul(poly[j], root);   // 乘以常数根
    }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly;
}

/* 计算余数（纠错码字） */
function rsRemainder(data, gen) {
  var deg = gen.length - 1;
  var res = new Array(deg);
  for (var i = 0; i < deg; i++) res[i] = 0;
  for (var i = 0; i < data.length; i++) {
    var factor = data[i] ^ res[0];
    for (var j = 0; j < deg - 1; j++) res[j] = res[j + 1];
    res[deg - 1] = 0;
    for (var j = 0; j < deg; j++) res[j] ^= gfMul(gen[j + 1], factor);
  }
  return res;
}

/* ---------- 编码模式 ---------- */
var MODE = { NUMERIC: 1, ALNUM: 2, BYTE: 4 };
var ALPHANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
    else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
  }
  return out;
}

function pickMode(str) {
  if (/^[0-9]*$/.test(str)) return MODE.NUMERIC;
  var alpha = true;
  for (var i = 0; i < str.length; i++) {
    if (ALPHANUM.indexOf(str[i]) < 0) { alpha = false; break; }
  }
  return alpha ? MODE.ALNUM : MODE.BYTE;
}

function charCountBits(mode, version) {
  var g = version <= 9 ? 0 : (version <= 26 ? 1 : 2);
  var table = [
    { 1: 10, 2: 9, 4: 8 },
    { 1: 12, 2: 11, 4: 16 },
    { 1: 14, 2: 13, 4: 16 }
  ];
  return table[g][mode];
}

/* ---------- 位缓冲 ---------- */
function BitBuffer() { this.bits = []; }
BitBuffer.prototype.put = function (val, len) {
  for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
};
BitBuffer.prototype.putBytes = function (arr) {
  for (var i = 0; i < arr.length; i++) this.put(arr[i], 8);
};

/* ---------- 数据编码 ---------- */
var EC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 }; // RS_BLOCK_TABLE 行内索引
var EC_NAME = ['L', 'M', 'Q', 'H'];
var EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function dataCodewordCapacity(version, ecIdx) {
  var row = QR_RS_BLOCK_TABLE[(version - 1) * 4 + ecIdx];
  var total = 0;
  if (row.length === 3) total = row[0] * row[2];
  else total = row[0] * row[2] + row[3] * row[5];
  return total;
}

function getBlockInfo(version, ecIdx) {
  var row = QR_RS_BLOCK_TABLE[(version - 1) * 4 + ecIdx];
  if (row.length === 3) {
    return [{ count: row[0], dataLen: row[2] }];
  }
  return [
    { count: row[0], dataLen: row[2] },
    { count: row[3], dataLen: row[5] }
  ];
}

/* 生成最终码流（数据+纠错+余数位） */
function buildCodewords(version, ecLevel, text) {
  var ecIdx = EC_LEVELS[ecLevel];
  var mode = pickMode(text);
  var bb = new BitBuffer();
  bb.put(mode, 4);
  var charCount = mode === MODE.BYTE ? utf8Bytes(text).length : text.length;
  bb.put(charCount, charCountBits(mode, version));

  if (mode === MODE.NUMERIC) {
    var i = 0;
    while (i + 3 <= text.length) { bb.put(parseInt(text.substr(i, 3), 10), 10); i += 3; }
    if (text.length - i === 2) bb.put(parseInt(text.substr(i, 2), 10), 7);
    else if (text.length - i === 1) bb.put(parseInt(text.substr(i, 1), 10), 4);
  } else if (mode === MODE.ALNUM) {
    var j = 0;
    while (j + 2 <= text.length) {
      bb.put(ALPHANUM.indexOf(text[j]) * 45 + ALPHANUM.indexOf(text[j + 1]), 11);
      j += 2;
    }
    if (j < text.length) bb.put(ALPHANUM.indexOf(text[j]), 6);
  } else {
    bb.putBytes(utf8Bytes(text));
  }

  var capacityBits = dataCodewordCapacity(version, ecIdx) * 8;
  if (bb.bits.length > capacityBits) throw new Error('数据超出容量');
  /* 终止符 + 位对齐 + 填充码字 */
  var terminator = Math.min(4, capacityBits - bb.bits.length);
  bb.put(0, terminator);
  while (bb.bits.length % 8 !== 0) bb.put(0, 1);
  var padBytes = [0xEC, 0x11], p = 0;
  while (bb.bits.length < capacityBits) { bb.put(padBytes[p % 2], 8); p++; }

  var dataCw = [];
  for (var b = 0; b < bb.bits.length; b += 8) {
    var v = 0;
    for (var k = 0; k < 8; k++) v = (v << 1) | bb.bits[b + k];
    dataCw.push(v);
  }

  /* 分块 + 纠错 */
  var blocks = getBlockInfo(version, ecIdx);
  var dataBlocks = [], offset = 0, maxDataLen = 0;
  for (var bi = 0; bi < blocks.length; bi++) {
    var info = blocks[bi];
    maxDataLen = Math.max(maxDataLen, info.dataLen);
    for (var c = 0; c < info.count; c++) {
      dataBlocks.push(dataCw.slice(offset, offset + info.dataLen));
      offset += info.dataLen;
    }
  }
  var ecBlocks = [];
  var maxEcLen = 0;
  var rowRef = QR_RS_BLOCK_TABLE[(version - 1) * 4 + ecIdx];
  for (var bi2 = 0; bi2 < blocks.length; bi2++) {
    /* 每组 EC 长度 = 该组总码字数 - 该组数据码字数（QR 标准中两组 EC 长度相等） */
    var ecLenThis = (bi2 === 0 ? rowRef[1] - rowRef[2] : rowRef[4] - rowRef[5]);
    maxEcLen = Math.max(maxEcLen, ecLenThis);
    for (var c2 = 0; c2 < blocks[bi2].count; c2++) {
      var idx = (bi2 === 0 ? 0 : blocks[0].count) + c2;
      var gen = rsGenPoly(ecLenThis);
      ecBlocks[idx] = rsRemainder(dataBlocks[idx], gen);
    }
  }

  /* 交织 */
  var result = [];
  for (var d = 0; d < maxDataLen; d++)
    for (var blk = 0; blk < dataBlocks.length; blk++)
      if (d < dataBlocks[blk].length) result.push(dataBlocks[blk][d]);
  for (var e = 0; e < maxEcLen; e++)
    for (var blk2 = 0; blk2 < ecBlocks.length; blk2++)
      if (ecBlocks[blk2]) result.push(ecBlocks[blk2][e]);

  /* 余数位（补 0 到模块边界） */
  var REMAINDER_BITS = [0,7,7,7,7,7,0,0,0,0,0,0,0,3,3,3,3,3,3,3,4,4,4,4,4,4,4,3,3,3,3,3,3,3,4,4,4,4,4,4];
  var remainderBits = REMAINDER_BITS[version - 1];
  for (var r = 0; r < remainderBits; r++) result.push(0);
  return result;
}

/* ---------- 矩阵构建 ---------- */
function QRMatrix(version, ecLevel, codewords, forcedMask) {
  this.version = version;
  this.forcedMask = (forcedMask === undefined) ? null : forcedMask;
  this.size = version * 4 + 17;
  var n = this.size;
  this.modules = [];
  this.isFunction = [];
  for (var y = 0; y < n; y++) {
    this.modules.push(new Array(n).fill(null));
    this.isFunction.push(new Array(n).fill(false));
  }
  this.ecLevel = ecLevel;

  this.drawFunctionPatterns();
  this.drawCodewords(codewords);

  /* 选掩码（可强制指定，便于调试） */
  var bestMask = 0, bestScore = Infinity;
  if (this.forcedMask !== null && this.forcedMask !== undefined) {
    bestMask = this.forcedMask;
  } else {
    for (var m = 0; m < 8; m++) {
      this.applyMask(m);
      var score = this.penaltyScore();
      if (score < bestScore) { bestScore = score; bestMask = m; }
      this.applyMask(m); // 异或还原
    }
  }
  this.mask = bestMask;
  this.applyMask(bestMask);
  this.drawFormatBits(bestMask, false); /* 写入真实格式位与固定黑模块 */
  this.drawVersionBits(false);        /* 写入真实版本信息位（v>=7）*/
}

QRMatrix.prototype.setFunctionModule = function (x, y, dark) {
  this.modules[y][x] = dark ? 1 : 0;
  this.isFunction[y][x] = true;
};

QRMatrix.prototype.drawFunctionPatterns = function () {
  var n = this.size, i;
  for (i = 0; i < n; i++) {
    this.setFunctionModule(6, i, i % 2 === 0);
    this.setFunctionModule(i, 6, i % 2 === 0);
  }
  this.drawFinderPattern(3, 3);
  this.drawFinderPattern(n - 4, 3);
  this.drawFinderPattern(3, n - 4);

  var pos = QR_PATTERN_POSITION_TABLE[this.version - 1];
  var numAlign = pos.length;
  for (var ai = 0; ai < numAlign; ai++) {
    for (var aj = 0; aj < numAlign; aj++) {
      if ((ai === 0 && aj === 0) || (ai === 0 && aj === numAlign - 1) || (ai === numAlign - 1 && aj === 0)) continue;
      this.drawAlignmentPattern(pos[aj], pos[ai]);
    }
  }
  this.drawFormatBits(0, true);   /* 评估期：格式位按 0 处理 */
  this.drawVersionBits(true);   /* 评估期：版本位按 0 处理 */
};

QRMatrix.prototype.drawFinderPattern = function (cx, cy) {
  for (var dy = -4; dy <= 4; dy++) {
    for (var dx = -4; dx <= 4; dx++) {
      var dist = Math.max(Math.abs(dx), Math.abs(dy));
      var x = cx + dx, y = cy + dy;
      if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
        this.setFunctionModule(x, y, dist !== 2 && dist !== 4);
      }
    }
  }
};

QRMatrix.prototype.drawAlignmentPattern = function (cx, cy) {
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      this.setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
};

QRMatrix.prototype.drawFormatBits = function (mask, test) {
  var n = this.size;
  var data = (EC_FORMAT_BITS[this.ecLevel] << 3) | mask;
  var rem = data;
  for (var i = 0; i < 10; i++) rem = ((rem << 1) ^ ((rem >>> 9) * 0x537)) & 0x3FF;
  var bits = ((data << 10) | rem) ^ 0x5412;
  function bit(i) { return test ? false : (((bits >>> i) & 1) === 1); }
  /* 第一份 */
  for (var i = 0; i <= 5; i++) this.setFunctionModule(8, i, bit(i));
  this.setFunctionModule(8, 7, bit(6));
  this.setFunctionModule(8, 8, bit(7));
  this.setFunctionModule(7, 8, bit(8));
  for (var i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, bit(i));
  /* 第二份 */
  for (var i = 0; i < 8; i++) this.setFunctionModule(n - 1 - i, 8, bit(i));
  for (var i = 8; i < 15; i++) this.setFunctionModule(8, n - 15 + i, bit(i));
  this.setFunctionModule(8, n - 8, test ? false : true); /* 固定黑模块 */
};

QRMatrix.prototype.drawVersionBits = function (test) {
  if (this.version < 7) return;
  var n = this.size;
  var rem = this.version;
  for (var i = 0; i < 12; i++) rem = ((rem << 1) ^ ((rem >>> 11) * 0x1F25)) & 0xFFF;
  var bits = (this.version << 12) | rem;
  function bit(i) { return test ? false : (((bits >>> i) & 1) === 1); }
  for (var i = 0; i < 18; i++) {
    var a = n - 11 + (i % 3), b = Math.floor(i / 3);
    this.setFunctionModule(a, b, bit(i));
    this.setFunctionModule(b, a, bit(i));
  }
};

QRMatrix.prototype.drawCodewords = function (codewords) {
  var n = this.size, i = 0;
  for (var right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < n; vert++) {
      for (var j = 0; j < 2; j++) {
        var x = right - j;
        var upward = ((right + 1) & 2) === 0;
        var y = upward ? n - 1 - vert : vert;
        if (!this.isFunction[y][x] && i < codewords.length * 8) {
          this.modules[y][x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
};

QRMatrix.prototype.maskBit = function (mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
  return false;
};

QRMatrix.prototype.applyMask = function (mask) {
  for (var y = 0; y < this.size; y++) {
    for (var x = 0; x < this.size; x++) {
      if (!this.isFunction[y][x] && this.maskBit(mask, x, y)) {
        this.modules[y][x] ^= 1;
      }
    }
  }
};

QRMatrix.prototype.penaltyScore = function () {
  var n = this.size, m = this.modules, score = 0, x, y;

  /* 规则1：连续同色模块 */
  for (y = 0; y < n; y++) {
    var runColor = m[y][0], runLen = 1;
    for (x = 1; x < n; x++) {
      if (m[y][x] === runColor) runLen++;
      else { if (runLen >= 5) score += 3 + (runLen - 5); runColor = m[y][x]; runLen = 1; }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (x = 0; x < n; x++) {
    var rc2 = m[0][x], rl2 = 1;
    for (y = 1; y < n; y++) {
      if (m[y][x] === rc2) rl2++;
      else { if (rl2 >= 5) score += 3 + (rl2 - 5); rc2 = m[y][x]; rl2 = 1; }
    }
    if (rl2 >= 5) score += 3 + (rl2 - 5);
  }

  /* 规则2：2x2 同色块 */
  for (y = 0; y < n - 1; y++) {
    for (x = 0; x < n - 1; x++) {
      var c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }

  /* 规则3：类定位图形 1011101（前后各4个浅模块） */
  var pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  var pattern2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (y = 0; y < n; y++) {
    for (x = 0; x <= n - 11; x++) {
      var ok1 = true, ok2 = true;
      for (var k = 0; k < 11; k++) {
        if (m[y][x + k] !== pattern[k]) ok1 = false;
        if (m[y][x + k] !== pattern2[k]) ok2 = false;
      }
      if (ok1) score += 40;
      if (ok2) score += 40;
    }
  }
  for (x = 0; x < n; x++) {
    for (y = 0; y <= n - 11; y++) {
      var okv1 = true, okv2 = true;
      for (var k2 = 0; k2 < 11; k2++) {
        if (m[y + k2][x] !== pattern[k2]) okv1 = false;
        if (m[y + k2][x] !== pattern2[k2]) okv2 = false;
      }
      if (okv1) score += 40;
      if (okv2) score += 40;
    }
  }

  /* 规则4：深浅比例 */
  var dark = 0;
  for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (m[y][x] === 1) dark++;
  var total = n * n;
  var ratio = dark * 100 / total;
  var k = Math.floor(Math.abs(ratio - 50) / 5);
  score += k * 10;
  return score;
};

/* ---------- 对外接口 ---------- */
function qrEncode(text, options) {
  options = options || {};
  var ecLevel = options.ecLevel || 'M';
  if (EC_LEVELS[ecLevel] === undefined) throw new Error('纠错等级无效');
  var minVersion = options.minVersion || 1, maxVersion = options.maxVersion || 40;
  var mode = pickMode(text);
  for (var v = minVersion; v <= maxVersion; v++) {
    var needBits = 4 + charCountBits(mode, v) + (mode === MODE.BYTE ? utf8Bytes(text).length * 8 :
      mode === MODE.NUMERIC ? (Math.floor(text.length / 3) * 10 + (text.length % 3 === 2 ? 7 : text.length % 3 === 1 ? 4 : 0)) :
      (Math.floor(text.length / 2) * 11 + (text.length % 2 ? 6 : 0)));
    if (needBits <= dataCodewordCapacity(v, EC_LEVELS[ecLevel]) * 8) {
      var cw = buildCodewords(v, ecLevel, text);
      var matrix = new QRMatrix(v, ecLevel, cw, options.mask);
      return { version: v, ecLevel: ecLevel, mask: matrix.mask, mode: mode, size: matrix.size, modules: matrix.modules };
    }
  }
  throw new Error('数据过长，无法编码（最大支持 40 版本）');
}

/* 渲染为 SVG 字符串（含静默区，scale 为每模块像素） */
function qrToSVG(text, options) {
  options = options || {};
  var qr = qrEncode(text, options);
  var scale = options.scale || 8;
  var quiet = options.quiet !== undefined ? options.quiet : 4;
  var n = qr.size;
  var total = (n + quiet * 2) * scale;
  var rects = [];
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      if (qr.modules[y][x] === 1) {
        rects.push('<rect x="' + ((x + quiet) * scale) + '" y="' + ((y + quiet) * scale) + '" width="' + scale + '" height="' + scale + '"/>');
      }
    }
  }
  var dark = options.dark || '#000000', light = options.light || '#FFFFFF';
  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + total + '" height="' + total + '" viewBox="0 0 ' + total + ' ' + total + '">' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>' +
      rects.join('') + '</svg>',
    version: qr.version, ecLevel: qr.ecLevel, mask: qr.mask, size: n, moduleCount: n, quietZone: quiet, scale: scale
  };
}

global.PayInvoiceQR = {
  encode: qrEncode,
  toSVG: qrToSVG,
  utf8Bytes: utf8Bytes,
  MODE: MODE,
  EC_LEVELS: EC_LEVELS,
  _internal: { gfMul: gfMul, rsGenPoly: rsGenPoly, rsRemainder: rsRemainder, dataCodewordCapacity: dataCodewordCapacity, buildCodewords: buildCodewords }
};
})(typeof window !== 'undefined' ? window : globalThis);
