/*
 * 加密模块安全测试（Node 运行，无需浏览器）
 * 覆盖：
 *  - PBKDF2-HMAC-SHA256 与 Node 原生实现交叉验证（函数/随机盐/多块输出）
 *  - HMAC-SHA256 与 Node 原生交叉验证
 *  - P2 载荷往返加密、错误口令拒绝、篡改检测、旧版 P1 拒绝、短口令拒绝
 *  - randomBytes 强制安全随机源
 *  - 恒定时间比较
 */
'use strict';

const assert = require('assert');
const nodeCrypto = require('crypto');

/* 按本仓库惯例手动加载源文件（源码挂在 globalThis 上，无模块导出） */
require('../src/crypto.js');
const C = globalThis.PayInvoiceCrypto;
assert.ok(C, 'PayInvoiceCrypto 未挂载');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  PASS ' + name);
}

function toHex(bytes) {
  return bytes.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
}

const VECTORS_SHA256 = [
  { p: 'password', s: 'salt', c: 1, dkLen: 32 },
  { p: 'password', s: 'salt', c: 2, dkLen: 32 },
  { p: 'password', s: 'salt', c: 4096, dkLen: 32 },
  { p: 'passwordPASSWORDpassword', s: 'saltSALTsaltSALTsaltSALTsaltSALTsalt', c: 4096, dkLen: 40 },
  { p: 'pass\x00word', s: 'sa\x00lt', c: 4096, dkLen: 16 },
  { p: '', s: 'salt', c: 1024, dkLen: 48 }
];

console.log('== PBKDF2-HMAC-SHA256 交叉验证（对照 Node 原生 crypto） ==');
VECTORS_SHA256.forEach(function (v, i) {
  ok('PBKDF2 向量 #' + i + ' (c=' + v.c + ', dkLen=' + v.dkLen + ')', function () {
    const mine = C.pbkdf2Sha256(C.utf8Bytes(v.p), C.utf8Bytes(v.s), v.c, v.dkLen);
    const ref = nodeCrypto.pbkdf2Sync(v.p, Buffer.from(v.s, 'utf8'), v.c, v.dkLen, 'sha256');
    assert.strictEqual(toHex(mine), ref.toString('hex'));
  });
});

console.log('== PBKDF2 参数校验 ==');
ok('迭代次数 0 拒绝', function () {
  assert.throws(function () { C.pbkdf2Sha256(C.utf8Bytes('p'), C.utf8Bytes('s'), 0, 16); }, /迭代次数/);
});
ok('派生结果长度精确（跨块边界 dkLen=50）', function () {
  const out = C.pbkdf2Sha256(C.utf8Bytes('pw'), C.utf8Bytes('salt'), 100, 50);
  assert.strictEqual(out.length, 50);
  const ref = nodeCrypto.pbkdf2Sync('pw', Buffer.from('salt', 'utf8'), 100, 50, 'sha256');
  assert.strictEqual(toHex(out), ref.toString('hex'));
});

console.log('== HMAC-SHA256 交叉验证 ==');
ok('HMAC 多组输入对照 Node', function () {
  const cases = [
    [C.utf8Bytes('key'), C.utf8Bytes('The quick brown fox jumps over the lazy dog')],
    [C.utf8Bytes(''), C.utf8Bytes('')],
    [C.utf8Bytes('a'.repeat(200)), C.utf8Bytes('b'.repeat(1000))],
    [C.utf8Bytes('中文口令-测试'), C.utf8Bytes('数据完整性')]
  ];
  cases.forEach(function (c, i) {
    const mine = toHex(C.hmacSha256(c[0], c[1]));
    const ref = nodeCrypto.createHmac('sha256', Buffer.from(c[0])).update(Buffer.from(c[1])).digest('hex');
    assert.strictEqual(mine, ref, 'HMAC case ' + i);
  });
});

console.log('== SHA-256 交叉验证 ==');
ok('SHA-256 对照 Node', function () {
  const inputs = ['', 'abc', '中文测试消息', 'x'.repeat(1000)];
  inputs.forEach(function (t) {
    assert.strictEqual(C.sha256Hex(C.utf8Bytes(t)),
      nodeCrypto.createHash('sha256').update(t, 'utf8').digest('hex'));
  });
});

console.log('== P2 载荷加解密 ==');
const sample = {
  buyer: { name: '某某科技有限公司', taxNo: '91310000MA1K35QX9G' },
  items: [{ name: '技术服务费', amount: 10600, taxRate: 0.06 }],
  totals: { amount: 10000, tax: 600, total: 10600 },
  meta: { schema: 'payinvoice.backup.v1' }
};

ok('encrypt/decrypt 往返一致', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  assert.ok(p.indexOf('P2.') === 0, '前缀应为 P2.');
  const back = C.decryptPayload(p, 'Test-12345');
  assert.deepStrictEqual(back, sample);
});

ok('每次加密输出不同（随机 salt+IV）', function () {
  const p1 = C.encryptPayload(sample, 'Test-12345');
  const p2 = C.encryptPayload(sample, 'Test-12345');
  assert.notStrictEqual(p1, p2);
  assert.deepStrictEqual(C.decryptPayload(p1, 'Test-12345'), sample);
  assert.deepStrictEqual(C.decryptPayload(p2, 'Test-12345'), sample);
});

ok('错误口令拒绝', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  assert.throws(function () { C.decryptPayload(p, 'Wrong-12345'); }, /完整性校验失败/);
});

ok('密文篡改检测（Encrypt-then-MAC）', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  const b64 = p.slice(3);
  const bytes = C.base64ToBytes(b64);
  bytes[40] ^= 0x01; /* 改密文中间一个字节 */
  const tampered = 'P2.' + C.bytesToBase64(bytes);
  assert.throws(function () { C.decryptPayload(tampered, 'Test-12345'); }, /完整性校验失败/);
});

ok('MAC 篡改检测', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  const bytes = C.base64ToBytes(p.slice(3));
  bytes[bytes.length - 1] ^= 0x80;
  assert.throws(function () { C.decryptPayload('P2.' + C.bytesToBase64(bytes), 'Test-12345'); }, /完整性校验失败/);
});

ok('截断载荷拒绝', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  const bytes = C.base64ToBytes(p.slice(3)).slice(0, 60);
  assert.throws(function () { C.decryptPayload('P2.' + C.bytesToBase64(bytes), 'Test-12345'); }, /长度无效/);
});

ok('旧版 P1 载荷拒绝', function () {
  assert.throws(function () { C.decryptPayload('P1.QUJD', 'Test-12345'); }, /旧版载荷/);
});

ok('非 P2 前缀拒绝', function () {
  assert.throws(function () { C.decryptPayload('XX.QUJD', 'Test-12345'); }, /不是有效的加密载荷/);
});

ok('非法 Base64 拒绝', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  const bad = p.slice(0, 5) + '!!!' + p.slice(9);
  assert.throws(function () { C.decryptPayload(bad, 'Test-12345'); }, /Base64/);
});

ok('口令少于 8 位拒绝', function () {
  assert.throws(function () { C.encryptPayload(sample, '1234567'); }, /至少 8 位/);
});

ok('空口令解密拒绝', function () {
  const p = C.encryptPayload(sample, 'Test-12345');
  assert.throws(function () { C.decryptPayload(p, ''); }, /请输入加密口令/);
});

ok('中文字段与特殊字符往返', function () {
  const obj = { note: '备注：含"引号"、\\反斜杠、换行\n第二行、emoji 🎫', no: '¥100.00' };
  assert.deepStrictEqual(C.decryptPayload(C.encryptPayload(obj, 'Test-12345'), 'Test-12345'), obj);
});

console.log('== randomBytes / timingSafeEqual ==');
ok('randomBytes 长度与去重（统计意义上）', function () {
  const a = C.randomBytes(16);
  const b = C.randomBytes(16);
  assert.strictEqual(a.length, 16);
  assert.strictEqual(b.length, 16);
  assert.notDeepStrictEqual(a, b);
});
ok('randomBytes 拒绝缺失随机源时抛错（模拟）', function () {
  const saved = globalThis.crypto;
  /* Node 22 全局 crypto 可临时删除 */
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  delete globalThis.crypto;
  try {
    assert.throws(function () { C.randomBytes(8); }, /安全随机数源/);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'crypto', desc);
    else globalThis.crypto = saved;
  }
});
ok('timingSafeEqual 正确性', function () {
  const a = [1, 2, 3], b = [1, 2, 3], c = [1, 2, 4], d = [1, 2];
  assert.strictEqual(C.timingSafeEqual(a, b), true);
  assert.strictEqual(C.timingSafeEqual(a, c), false);
  assert.strictEqual(C.timingSafeEqual(a, d), false);
});

console.log('== 性能基准（页面交互可接受性） ==');
const t0 = Date.now();
C.encryptPayload(sample, 'Bench-12345');
const t1 = Date.now();
console.log('  INFO encryptPayload(含 PBKDF2 x2) 耗时: ' + (t1 - t0) + 'ms');
ok('单次加密耗时 < 8000ms（桌面浏览器可接受）', function () {
  assert.ok(t1 - t0 < 8000, '耗时过长: ' + (t1 - t0) + 'ms');
});
const t2 = Date.now();
C.decryptPayload(C.encryptPayload(sample, 'Bench-12345'), 'Bench-12345');
const t3 = Date.now();
console.log('  INFO decryptPayload(含 PBKDF2 x2) 耗时: ' + (t3 - t2) + 'ms');

console.log('\ncrypto_test: ' + passed + ' 项全部通过');
