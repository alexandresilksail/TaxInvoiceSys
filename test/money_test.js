/*
 * 金额计算模块测试（Node 运行）
 * 覆盖：分解析与四舍五入、零税额、非法输入、边界金额、多行明细合计、
 *       人民币大写、税率换算、数量×单价精度。
 */
'use strict';

const assert = require('assert');
require('../src/money.js');
const M = globalThis.PayInvoiceMoney;
assert.ok(M, 'PayInvoiceMoney 未挂载');

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log('  PASS ' + name); }

console.log('== toCents 解析与四舍五入 ==');
ok('基本解析', function () {
  assert.strictEqual(M.toCents('100'), 10000);
  assert.strictEqual(M.toCents('0.05'), 5);
  assert.strictEqual(M.toCents('0.5'), 50);
  assert.strictEqual(M.toCents('1234.56'), 123456);
  assert.strictEqual(M.toCents('000123.45'), 12345);
  assert.strictEqual(M.toCents('.5'), 50);
  assert.strictEqual(M.toCents('5.'), 500);
  assert.strictEqual(M.toCents('0'), 0);
  assert.strictEqual(M.toCents('0.00'), 0);
});
ok('第 3 位小数起四舍五入', function () {
  assert.strictEqual(M.toCents('0.005'), 1);   /* 0.5 分 → 进位 */
  assert.strictEqual(M.toCents('0.004'), 0);
  assert.strictEqual(M.toCents('0.995'), 100); /* 99.5 分 → 进位到 100 */
  assert.strictEqual(M.toCents('0.994'), 99);
  assert.strictEqual(M.toCents('1.005'), 101);
  assert.strictEqual(M.toCents('1.004'), 100);
  assert.strictEqual(M.toCents('0.999'), 100);
  assert.strictEqual(M.toCents('9.999'), 1000);
});
ok('数字入参', function () {
  assert.strictEqual(M.toCents(100), 10000);
  assert.strictEqual(M.toCents(0.1), 10);
  assert.strictEqual(M.toCents(0.30000000000000004), 30); /* 浮点噪声被整数化 */
  assert.strictEqual(M.toCents(1.005), 101);              /* 数字走 String(1.005)="1.005" */
});
ok('非法输入一律 null', function () {
  [null, undefined, '', ' ', 'abc', '-5', '+5', '1e3', '1E3', '1,000', '1 000',
   '12.3.4', '--1', '0x10', 'Infinity', 'NaN', {}, [], true, false].forEach(function (v) {
    assert.strictEqual(M.toCents(v), null, '应为 null: ' + JSON.stringify(v));
  });
  assert.strictEqual(M.toCents(-0.01), null);
  assert.strictEqual(M.toCents(NaN), null);
  assert.strictEqual(M.toCents(Infinity), null);
});
ok('超范围金额拒绝（¥100亿 上限）', function () {
  assert.strictEqual(M.toCents('10000000000.00'), 1000000000000); /* 恰好等于上限 */
  assert.strictEqual(M.toCents('10000000000.01'), null);          /* 超出 1 分 */
  assert.strictEqual(M.toCents('9999999999.99'), 999999999999); /* 上限内通过 */
  assert.strictEqual(M.toCents('100000000000000'), null);  /* 1e14 元 */
});

console.log('== rateToBp 税率换算 ==');
ok('百分数 → 万分比', function () {
  assert.strictEqual(M.rateToBp('13%'), 1300);
  assert.strictEqual(M.rateToBp('9%'), 900);
  assert.strictEqual(M.rateToBp('6%'), 600);
  assert.strictEqual(M.rateToBp('0.5%'), 50);
  assert.strictEqual(M.rateToBp('0%'), 0);
  assert.strictEqual(M.rateToBp('3%'), 300);
  assert.strictEqual(M.rateToBp('1%'), 100);
});
ok('无 % 号与非法值', function () {
  assert.strictEqual(M.rateToBp('0.06'), 6);
  assert.strictEqual(M.rateToBp(' 13% '), 1300);
  assert.strictEqual(M.rateToBp('101%'), null);
  assert.strictEqual(M.rateToBp('100%'), 10000);
  assert.strictEqual(M.rateToBp(''), null);
  assert.strictEqual(M.rateToBp(null), null);
  assert.strictEqual(M.rateToBp('abc'), null);
  assert.strictEqual(M.rateToBp('13'), 1300);
});

console.log('== mulQtyPrice 数量×单价 ==');
ok('典型场景', function () {
  assert.strictEqual(M.mulQtyPrice('1', '100000.00'), 10000000);
  assert.strictEqual(M.mulQtyPrice('12', '500.00'), 600000);
  assert.strictEqual(M.mulQtyPrice('2', '0.1'), 20);
  assert.strictEqual(M.mulQtyPrice('0.1', '0.2'), 2);
  assert.strictEqual(M.mulQtyPrice('3', '0.335'), 101); /* 1.005 → 100.5 分 → 进位 101 */
  assert.strictEqual(M.mulQtyPrice('0.001', '3.333'), 0); /* 0.3333 分 */
});
ok('零与空', function () {
  assert.strictEqual(M.mulQtyPrice('0', '100'), 0);
  assert.strictEqual(M.mulQtyPrice('', '100'), null);
  assert.strictEqual(M.mulQtyPrice('1', ''), null);
  assert.strictEqual(M.mulQtyPrice('1', 'abc'), null);
  assert.strictEqual(M.mulQtyPrice('-1', '100'), null);
});
ok('小数数量精确到 6 位，最后一步才舍入到分', function () {
  assert.strictEqual(M.mulQtyPrice('0.001', '3.333'), 0);   /* 0.3333 分 */
  assert.strictEqual(M.mulQtyPrice('0.0005', '100'), 5);    /* 5 分 */
  assert.strictEqual(M.mulQtyPrice('0.0004', '100'), 4);
  assert.strictEqual(M.mulQtyPrice('1.2345', '1'), 123);    /* 123.45 分 */
  assert.strictEqual(M.mulQtyPrice('1.2349', '1'), 123);
  assert.strictEqual(M.mulQtyPrice('1.235', '1'), 124);     /* 123.5 分进位 */
});

console.log('== taxOfCents 行税额 ==');
ok('典型税率', function () {
  assert.strictEqual(M.taxOfCents(1000000, 600), 60000);  /* ¥10000 × 6% = ¥600 */
  assert.strictEqual(M.taxOfCents(600000, 600), 36000);
  assert.strictEqual(M.taxOfCents(10000, 1300), 1300);
  assert.strictEqual(M.taxOfCents(1, 5000), 1);  /* 1 分 × 50% = 0.5 分 → 进位 */
  assert.strictEqual(M.taxOfCents(1, 1300), 0);  /* 1 分 × 13% = 0.13 分 → 舍去 */
  assert.strictEqual(M.taxOfCents(10000, 0), 0); /* 零税率 */
  assert.strictEqual(M.taxOfCents(0, 1300), 0);
  assert.strictEqual(M.taxOfCents(333, 500), 17); /* 3.33 × 5% = 0.1665 → 17? 实际 0.17 → 17 分? */
});
ok('非法参数', function () {
  assert.strictEqual(M.taxOfCents(null, 600), null);
  assert.strictEqual(M.taxOfCents(10000, null), null);
  assert.strictEqual(M.taxOfCents(-1, 600), null);
  assert.strictEqual(M.taxOfCents(10000, -5), null);
});

console.log('== 多行明细合计（复现业务规则） ==');
/* 规则：行税额先舍入到分再合计；金额合计 = Σ 行金额 */
function lineAmount(it) {
  var auto = M.mulQtyPrice(it.qty, it.price);
  var amt = (it.amount !== '' && it.amount != null) ? M.toCents(it.amount) : auto;
  return amt;
}
function lineTax(it, amt) {
  if (it.tax !== '' && it.tax != null) return M.toCents(it.tax); /* 手工覆盖，含 0 */
  return amt == null ? null : M.taxOfCents(amt, M.rateToBp(it.taxRate));
}
ok('多行混合计算', function () {
  var items = [
    { qty: '1', price: '100000.00', amount: '', taxRate: '6%', tax: '' },
    { qty: '12', price: '500.00', amount: '', taxRate: '6%', tax: '' },
    { qty: '3', price: '0.335', amount: '', taxRate: '13%', tax: '' },
    { qty: '', price: '', amount: '88.88', taxRate: '0%', tax: '' },   /* 零税率 */
    { qty: '', price: '', amount: '10.00', taxRate: '6%', tax: '0' }    /* 手工零税额（免税） */
  ];
  var amount = 0, tax = 0;
  items.forEach(function (it) {
    var a = lineAmount(it);
    var t = lineTax(it, a);
    if (a != null && a > 0) amount += a;
    if (t != null && t > 0) tax += t;
  });
  /* 100000.00 + 6000.00 + 1.01 + 88.88 + 10.00 = 106099.89 元 */
  assert.strictEqual(amount, 10000000 + 600000 + 101 + 8888 + 1000);
  /* 6000.00 + 360.00 + 0.13 + 0 + 0 = 6360.13 元 */
  assert.strictEqual(tax, 600000 + 36000 + 13 + 0 + 0);
  assert.strictEqual(amount + tax, 10609989 + 636013);
});
ok('手工零税额不回落自动计算', function () {
  var it = { amount: '10000.00', taxRate: '13%', tax: '0' };
  assert.strictEqual(lineTax(it, M.toCents(it.amount)), 0);
});
ok('手工税额优先于自动', function () {
  var it = { amount: '100.00', taxRate: '13%', tax: '5.00' };
  assert.strictEqual(lineTax(it, M.toCents(it.amount)), 500);
});
ok('非法行金额不计入合计', function () {
  var it = { qty: '', price: '', amount: 'abc', taxRate: '6%', tax: '' };
  assert.strictEqual(lineAmount(it), null);
});
ok('合计无浮点漂移（10 万行 × 0.01）', function () {
  var amount = 0;
  for (var i = 0; i < 100000; i++) amount += 1; /* 每行 1 分 */
  assert.strictEqual(amount, 100000);
  assert.strictEqual(M.centsToStr(amount), '1000.00');
});

console.log('== 人民币大写 ==');
ok('典型金额（分入参）', function () {
  assert.strictEqual(M.rmbUpperCents(0), '零元整');
  assert.strictEqual(M.rmbUpperCents(100), '壹元整');
  assert.strictEqual(M.rmbUpperCents(110), '壹元壹角');
  assert.strictEqual(M.rmbUpperCents(105), '壹元零伍分');
  assert.strictEqual(M.rmbUpperCents(510), '伍元壹角');
  assert.strictEqual(M.rmbUpperCents(10500), '壹佰零伍元整');
  assert.strictEqual(M.rmbUpperCents(100000000), '壹佰万元整');
  assert.strictEqual(M.rmbUpperCents(1000000000000), '壹佰亿元整');
  assert.strictEqual(M.rmbUpperCents(M.MAX_AMOUNT_CENTS), '壹佰亿元整');
});
ok('旧接口（元）兼容', function () {
  assert.strictEqual(M.rmbUpper(106099.89), '壹拾万陆仟零玖拾玖元捌角玖分');
  assert.strictEqual(M.rmbUpper(0), '零元整');
  assert.strictEqual(M.rmbUpper(-1), '');
});

console.log('== 格式化 ==');
ok('centsToStr / fmtCents', function () {
  assert.strictEqual(M.centsToStr(123456), '1234.56');
  assert.strictEqual(M.centsToStr(5), '0.05');
  assert.strictEqual(M.centsToStr(0), '0.00');
  assert.strictEqual(M.fmtCents(123456), '1,234.56');
  assert.strictEqual(M.fmtCents(100000000), '1,000,000.00');
  assert.strictEqual(M.fmtCents(0), '0.00');
});

console.log('== parseDecimal 边界 ==');
ok('scale 进位', function () {
  assert.strictEqual(M.parseDecimal('1.2345', 3), 1235);
  assert.strictEqual(M.parseDecimal('1.2344', 3), 1234);
  assert.strictEqual(M.parseDecimal('0.0005', 3), 1);
  assert.strictEqual(M.parseDecimal('0.0004', 3), 0);
  assert.strictEqual(M.parseDecimal('999.999', 2), 100000); /* 99999.9 → 进位 */
  assert.strictEqual(M.parseDecimal('0', 5), 0);
  assert.strictEqual(M.parseDecimal('', 2), null);
  assert.strictEqual(M.parseDecimal('abc', 2), null);
  assert.strictEqual(M.parseDecimal('-1', 2), null);
});

console.log('\nmoney_test: ' + passed + ' 项全部通过');
