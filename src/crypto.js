/* ============================================================
 * payinvoice 国密加密模块（纯 JS，无外部依赖）
 * - SHA-256 / HMAC-SHA256
 * - SM4 分组密码（GM/T 0002-2012），CBC 模式 + PKCS#7 填充
 * 标准表来源：gmssl 库导出（与国密标准一致）
 * ============================================================ */
(function (global) {
'use strict';

var SM4_SBOX = [0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05, 0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99, 0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62, 0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6, 0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8, 0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35, 0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87, 0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e, 0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1, 0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3, 0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f, 0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51, 0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8, 0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0, 0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84, 0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48];
var SM4_CK = [0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269, 0x70777e85, 0x8c939aa1, 0xa8afb6bd, 0xc4cbd2d9, 0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249, 0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9, 0xc0c7ced5, 0xdce3eaf1, 0xf8ff060d, 0x141b2229, 0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299, 0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209, 0x10171e25, 0x2c333a41, 0x484f565d, 0x646b7279];
var SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

/* ---------- SM4 ---------- */
function sm4KeySchedule(keyBytes) {
  var k = [], i;
  for (i = 0; i < 4; i++) {
    k[i] = (SM4_FK[i] ^ ((keyBytes[4 * i] << 24) | (keyBytes[4 * i + 1] << 16) | (keyBytes[4 * i + 2] << 8) | keyBytes[4 * i + 3])) >>> 0;
  }
  var rk = [];
  for (i = 0; i < 32; i++) {
    var t = (k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ SM4_CK[i]) >>> 0;
    var a = (t >>> 24) & 0xFF, b = (t >>> 16) & 0xFF, c = (t >>> 8) & 0xFF, d = t & 0xFF;
    var s = ((SM4_SBOX[a] << 24) | (SM4_SBOX[b] << 16) | (SM4_SBOX[c] << 8) | SM4_SBOX[d]) >>> 0;
    var l = sm4Lp(s);
    rk[i] = (k[i] ^ l) >>> 0;
    k[i + 4] = rk[i];
  }
  return rk;
}

function tau(x) {
  return ((SM4_SBOX[(x >>> 24) & 0xFF] << 24) | (SM4_SBOX[(x >>> 16) & 0xFF] << 16) |
          (SM4_SBOX[(x >>> 8) & 0xFF] << 8) | SM4_SBOX[x & 0xFF]) >>> 0;
}
/* 加密轮函数线性变换 L(x) = x ^ (x<<<2) ^ (x<<<10) ^ (x<<<18) ^ (x<<<24) */
function sm4L(x) { return (x ^ rotl(x, 2) ^ rotl(x, 10) ^ rotl(x, 18) ^ rotl(x, 24)) >>> 0; }
/* 密钥扩展线性变换 L'(x) = x ^ (x<<<13) ^ (x<<<23)（与 L 不同！） */
function sm4Lp(x) { return (x ^ rotl(x, 13) ^ rotl(x, 23)) >>> 0; }
function sm4T(x) { return sm4L(tau(x)); }

function sm4CryptBlock(block, rk, decrypt) {
  var x = [], i;
  for (i = 0; i < 4; i++) {
    x[i] = ((block[4 * i] << 24) | (block[4 * i + 1] << 16) | (block[4 * i + 2] << 8) | block[4 * i + 3]) >>> 0;
  }
  for (i = 0; i < 32; i++) {
    var rki = decrypt ? rk[31 - i] : rk[i];
    var t = (x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rki) >>> 0;
    x[i + 4] = (x[i] ^ sm4T(t)) >>> 0;
  }
  var out = [];
  for (i = 0; i < 4; i++) {
    var v = x[35 - i];
    out.push((v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF);
  }
  return out;
}

function xorBytes(a, b) {
  var r = [];
  for (var i = 0; i < a.length; i++) r.push(a[i] ^ b[i]);
  return r;
}

function sm4EncryptCBC(plain, key, iv) {
  if (key.length !== 16) throw new Error('SM4 密钥必须为 16 字节');
  if (iv.length !== 16) throw new Error('IV 必须为 16 字节');
  /* PKCS#7 填充 */
  var padLen = 16 - (plain.length % 16);
  var data = plain.slice();
  for (var i = 0; i < padLen; i++) data.push(padLen);
  var rk = sm4KeySchedule(key);
  var out = [], prev = iv;
  for (var off = 0; off < data.length; off += 16) {
    var blk = xorBytes(data.slice(off, off + 16), prev);
    var enc = sm4CryptBlock(blk, rk, false);
    out = out.concat(enc);
    prev = enc;
  }
  return out;
}

function sm4DecryptCBC(cipher, key, iv) {
  if (key.length !== 16) throw new Error('SM4 密钥必须为 16 字节');
  if (iv.length !== 16) throw new Error('IV 必须为 16 字节');
  if (cipher.length % 16 !== 0) throw new Error('密文长度必须是 16 的倍数');
  var rk = sm4KeySchedule(key);
  var out = [], prev = iv;
  for (var off = 0; off < cipher.length; off += 16) {
    var blk = cipher.slice(off, off + 16);
    var dec = sm4CryptBlock(blk, rk, true);
    out = out.concat(xorBytes(dec, prev));
    prev = blk;
  }
  var padLen = out[out.length - 1];
  if (padLen < 1 || padLen > 16 || padLen > out.length) throw new Error('解密失败：填充无效');
  for (var i = 0; i < padLen; i++) {
    if (out[out.length - 1 - i] !== padLen) throw new Error('解密失败：口令错误或数据已损坏');
  }
  return out.slice(0, out.length - padLen);
}

/* ---------- SHA-256 ---------- */
var SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];

function sha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var msg = bytes.slice();
  var bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  /* 64 位大端长度（支持到 2^53，足够本地使用） */
  var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  msg.push((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF);
  msg.push((lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);
  var w = new Array(64);
  for (var off = 0; off < msg.length; off += 64) {
    for (var i = 0; i < 16; i++) {
      w[i] = ((msg[off + 4 * i] << 24) | (msg[off + 4 * i + 1] << 16) | (msg[off + 4 * i + 2] << 8) | msg[off + 4 * i + 3]) >>> 0;
    }
    for (var i2 = 16; i2 < 64; i2++) {
      var s0 = (rotr(w[i2 - 15], 7) ^ rotr(w[i2 - 15], 18) ^ (w[i2 - 15] >>> 3)) >>> 0;
      var s1 = (rotr(w[i2 - 2], 17) ^ rotr(w[i2 - 2], 19) ^ (w[i2 - 2] >>> 10)) >>> 0;
      w[i2] = (w[i2 - 16] + s0 + w[i2 - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (var t = 0; t < 64; t++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var temp1 = (hh + S1 + ch + SHA_K[t] + w[t]) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  var out = [];
  for (var i3 = 0; i3 < 8; i3++) {
    out.push((h[i3] >>> 24) & 0xFF, (h[i3] >>> 16) & 0xFF, (h[i3] >>> 8) & 0xFF, h[i3] & 0xFF);
  }
  return out;
}

function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

function hmacSha256(key, msg) {
  var k = key.slice();
  if (k.length > 64) k = sha256(k);
  while (k.length < 64) k.push(0);
  var iPad = [], oPad = [];
  for (var i = 0; i < 64; i++) { iPad.push(k[i] ^ 0x36); oPad.push(k[i] ^ 0x5C); }
  var inner = sha256(iPad.concat(msg));
  return sha256(oPad.concat(inner));
}

/* ---------- Base64（UTF-8 安全） ---------- */
var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes) {
  var out = '', i;
  for (i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    var trip = (b0 << 16) | (b1 << 8) | b2;
    out += B64CHARS[(trip >> 18) & 63] + B64CHARS[(trip >> 12) & 63];
    out += i + 1 < bytes.length ? B64CHARS[(trip >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64CHARS[trip & 63] : '=';
  }
  return out;
}

function base64ToBytes(str) {
  var out = [], i;
  for (i = 0; i + 4 <= str.length; i += 4) {
    var v0 = B64CHARS.indexOf(str[i]), v1 = B64CHARS.indexOf(str[i + 1]);
    var v2 = B64CHARS.indexOf(str[i + 2]), v3 = B64CHARS.indexOf(str[i + 3]);
    if (v0 < 0 || v1 < 0) break;
    var trip = (v0 << 18) | (v1 << 12) | ((v2 < 0 ? 0 : v2) << 6) | (v3 < 0 ? 0 : v3);
    out.push((trip >> 16) & 0xFF);
    if (v2 >= 0) out.push((trip >> 8) & 0xFF);
    if (v3 >= 0) out.push(trip & 0xFF);
  }
  return out;
}

/* ---------- UTF-8 ---------- */
function utf8Bytes(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return out;
}
function bytesToUtf8(bytes) {
  var out = '', i;
  for (i = 0; i < bytes.length;) {
    var b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; }
    else if (b < 0xE0) { out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2; }
    else if (b < 0xF0) { out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3; }
    else {
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      cp -= 0x10000;
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      i += 4;
    }
  }
  return out;
}

/* ---------- 高层 API：二维码载荷加解密 ---------- */
/* 载荷格式：P1. + base64( IV(16) || SM4-CBC(JSON) )，密钥 = SHA256(口令) 前 16 字节 */
function deriveKey(password) { return sha256(utf8Bytes(password)).slice(0, 16); }

function encryptPayload(obj, password) {
  var json = JSON.stringify(obj);
  var plain = utf8Bytes(json);
  var key = deriveKey(password);
  var iv = [];
  var rand = (typeof global.crypto !== 'undefined' && global.crypto.getRandomValues)
    ? global.crypto.getRandomValues(new Uint8Array(16))
    : null;
  if (rand) { for (var i = 0; i < 16; i++) iv.push(rand[i]); }
  else { for (var j = 0; j < 16; j++) iv.push(Math.floor(Math.random() * 256)); }
  var ct = sm4EncryptCBC(plain, key, iv);
  return 'P1.' + bytesToBase64(iv.concat(ct));
}

function decryptPayload(payload, password) {
  if (typeof payload !== 'string' || payload.indexOf('P1.') !== 0) throw new Error('不是有效的加密载荷');
  var raw = base64ToBytes(payload.slice(3));
  if (raw.length < 32 || raw.length % 16 !== 0) throw new Error('载荷长度无效');
  var iv = raw.slice(0, 16), ct = raw.slice(16);
  var key = deriveKey(password);
  var plain = sm4DecryptCBC(ct, key, iv);
  return JSON.parse(bytesToUtf8(plain));
}

global.PayInvoiceCrypto = {
  sm4EncryptCBC: sm4EncryptCBC,
  sm4DecryptCBC: sm4DecryptCBC,
  sm4KeySchedule: sm4KeySchedule,
  sha256: sha256,
  sha256Hex: function (bytes) { return sha256(bytes).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); },
  hmacSha256: hmacSha256,
  bytesToBase64: bytesToBase64,
  base64ToBytes: base64ToBytes,
  utf8Bytes: utf8Bytes,
  bytesToUtf8: bytesToUtf8,
  deriveKey: deriveKey,
  encryptPayload: encryptPayload,
  decryptPayload: decryptPayload
};
})(typeof window !== 'undefined' ? window : globalThis);
