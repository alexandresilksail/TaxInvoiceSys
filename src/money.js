/* ============================================================
 * payinvoice 开票助手 - 金额计算模块（纯函数，无 DOM 依赖）
 * 依赖：无（可在 Node 中直接单测）
 *
 * 统一计算与舍入规则：
 *  1. 金额以"分"（整数）为最小单位存储与运算，全程不用浮点累加；
 *  2. 输入解析四舍五入到分（第 3 位小数起舍，0.005 分位进位）；
 *  3. 行税额 = 行金额(分) × 税率，先四舍五入到分，再参与合计；
 *  4. 合计：金额合计 = Σ 行金额(分)；税额合计 = Σ 行税额(分)；
 *     价税合计 = 金额合计 + 税额合计（整数相加，无累计误差）；
 *  5. 零税额：税率为 0 或手工税额填 0 时，该行税额为 0，
 *     且不得回落到"按税率自动计算"；
 *  6. 非法输入（非数字、负数、科学计数法、超出范围）一律返回 null，
 *     由调用方决定提示或忽略，禁止流入计算。
 * ============================================================ */
(function (root) {
'use strict';

/* 单笔金额上限：¥99,999,999,999.99（1e12 分）。
 * 该上限保证 金额(分) × 税率(万分比≤1300) ≤ 1.3e15 < 2^53，
 * 使后续所有乘除都在 IEEE754 精确整数范围内。 */
var MAX_AMOUNT_CENTS = 1000000000000;

/* 把十进制输入（字符串或数字）解析为 value × 10^scale 的整数，四舍五入。
 * 非法输入返回 null。scale ≤ 8。 */
function parseDecimal(input, scale) {
  if (typeof scale !== 'number' || scale < 0 || scale > 8) return null;
  var s;
  if (typeof input === 'number') {
    if (!isFinite(input) || input < 0) return null;
    s = String(input); /* 大数会得到科学计数法，被下方正则拒绝 */
  } else if (typeof input === 'string') {
    s = input.trim();
  } else {
    return null;
  }
  if (s === '') return null;
  /* 仅接受普通十进制：整数 / 小数；拒绝负号、正号、字母、科学计数法 */
  if (!/^\d+(\.\d*)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  var dot = s.indexOf('.');
  var intStr = dot < 0 ? s : s.slice(0, dot);
  var fracStr = dot < 0 ? '' : s.slice(dot + 1);
  if (intStr === '') intStr = '0';
  intStr = intStr.replace(/^0+/, '');
  if (intStr === '') intStr = '0';
  if (intStr.length > 13) return null; /* > 1e13，超出业务范围 */
  var value = parseInt(intStr, 10);
  for (var i = 0; i < scale; i++) value *= 10;
  if (fracStr === '') return value;
  if (fracStr.length <= scale) {
    var pad = fracStr;
    while (pad.length < scale) pad += '0';
    return value + parseInt(pad, 10);
  }
  /* 小数位超过 scale：第 scale+1 位起四舍五入 */
  var keep = parseInt(fracStr.slice(0, scale) || '0', 10);
  var nextDigit = parseInt(fracStr.charAt(scale), 10);
  if (nextDigit >= 5) keep += 1;
  var carry = 0;
  if (keep === Math.pow(10, scale)) { keep = 0; carry = 1; }
  return value + carry * Math.pow(10, scale) + keep;
}

/* 金额（元）→ 分。非法输入返回 null。 */
function toCents(input) {
  var c = parseDecimal(input, 2);
  if (c == null || c > MAX_AMOUNT_CENTS) return null;
  return c;
}

/* 数量 → 微（×1e6 的整数），四舍五入。非法输入返回 null。 */
function qtyToMicro(input) {
  var m = parseDecimal(input, 6);
  if (m == null || m > 1000000000000) return null; /* 数量上限 1e6 */
  return m;
}

/* 单价 → 万分之一元（×1e4 的整数），四舍五入到 4 位小数。 */
function priceToDeci(input) {
  var p = parseDecimal(input, 4);
  if (p == null || p > 100000000000) return null; /* 单价上限 ¥1e6 */
  return p;
}

/* 分 → "1234.56"（两位小数，无千分位） */
function centsToStr(cents) {
  if (typeof cents !== 'number' || !isFinite(cents)) return '';
  cents = Math.round(cents);
  var neg = cents < 0;
  if (neg) cents = -cents;
  var yuan = Math.floor(cents / 100), fen = cents % 100;
  return (neg ? '-' : '') + yuan + '.' + (fen < 10 ? '0' : '') + fen;
}

/* 分 → "1,234.56"（千分位，用于界面展示） */
function fmtCents(cents) {
  var s = centsToStr(cents);
  if (s === '') return '0.00';
  var neg = s.charAt(0) === '-';
  if (neg) s = s.slice(1);
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + parts.join('.');
}

/* 税率 → 万分比整数。"13%" → 1300，"0.5%" → 50，"0.06" → 6。
 * 非法或超过 100% 返回 null。 */
function rateToBp(rate) {
  var s = String(rate == null ? '' : rate).trim();
  if (s.charAt(s.length - 1) === '%') s = s.slice(0, -1).trim();
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  var bp = parseDecimal(s, 2); /* 百分数 × 100 = 万分比 */
  if (bp == null || bp > 10000) return null;
  return bp;
}

/* 整数四舍五入：roundHalfUp(num / den)，num、den 均为正整数且在 2^53 内 */
function divRoundHalfUp(num, den) {
  if (num === 0) return 0;
  var q = Math.floor(num / den);
  var r = num - q * den;
  if (r * 2 >= den) q += 1;
  return q;
}

/* 数量 × 单价 → 金额（分）。
 * 数量保留 6 位小数、单价保留 4 位小数后相乘，只在最后一步四舍五入到分，
 * 避免"单价先舍入到分再相乘"的双重舍入误差。 */
function mulQtyPrice(qty, price) {
  var q = qtyToMicro(qty);
  var p = priceToDeci(price);
  if (q == null || p == null) return null;
  if (q === 0 || p === 0) return 0;
  if (q > 9007199254740991 / p) return null; /* 乘积将超出 2^53，视为越界 */
  var num = q * p; /* 精确整数 */
  var cents = divRoundHalfUp(num, 100000000);
  if (cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

/* 行税额（分）= 金额(分) × 税率(万分比) / 10000，四舍五入到分 */
function taxOfCents(amountCents, rateBp) {
  if (typeof amountCents !== 'number' || typeof rateBp !== 'number') return null;
  if (!isFinite(amountCents) || !isFinite(rateBp)) return null;
  if (amountCents < 0 || rateBp < 0) return null;
  if (amountCents === 0 || rateBp === 0) return 0;
  var num = amountCents * rateBp; /* ≤ 1e12 × 1300 = 1.3e15，精确 */
  if (num > 9007199254740991) return null;
  return divRoundHalfUp(num, 10000);
}

/* ---------- 人民币大写（输入为"分"，整数运算） ---------- */
var RMB_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
var RMB_UNITS = ['', '拾', '佰', '仟'];
var RMB_GROUPS = ['', '万', '亿', '万亿', '亿亿'];

function rmbUpperCents(cents) {
  if (typeof cents !== 'number' || !isFinite(cents) || cents < 0 || cents > MAX_AMOUNT_CENTS) return '';
  cents = Math.round(cents);
  if (cents === 0) return '零元整';
  var yuan = Math.floor(cents / 100);
  var jiao = Math.floor((cents % 100) / 10);
  var fen = cents % 10;
  var intPart = '', fracPart = '';

  if (yuan > 0) {
    var s = String(yuan), groups = [];
    while (s.length > 0) { groups.unshift(s.slice(-4)); s = s.slice(0, -4); }
    var parts = [];
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g], unit = RMB_GROUPS[groups.length - 1 - g];
      var gStr = '', zero = false, allZero = true;
      for (var i = 0; i < grp.length; i++) {
        var digit = +grp.charAt(i);
        var pos = grp.length - 1 - i;
        if (digit === 0) {
          zero = true;
        } else {
          allZero = false;
          if (zero && gStr !== '') gStr += '零';
          zero = false;
          gStr += RMB_DIGITS[digit] + RMB_UNITS[pos];
        }
      }
      if (!allZero) {
        parts.push(gStr + unit);
      } else if (parts.length > 0 && g < groups.length - 1) {
        parts.push('零');
      }
    }
    intPart = parts.join('');
    intPart = intPart.replace(/零+/g, '零').replace(/零$/, '');
    intPart += '元';
  }

  if (jiao === 0 && fen === 0) {
    fracPart = '整';
  } else {
    if (jiao === 0 && intPart !== '') fracPart = '零'; /* 如 壹元零伍分 */
    if (jiao > 0) fracPart += RMB_DIGITS[jiao] + '角';
    if (fen > 0) fracPart += RMB_DIGITS[fen] + '分';
  }
  return intPart + fracPart;
}

/* 元（数字）→ 人民币大写（保持旧接口，内部走分） */
function rmbUpper(yuan) {
  var c = toCents(yuan);
  return c == null ? '' : rmbUpperCents(c);
}

root.PayInvoiceMoney = {
  MAX_AMOUNT_CENTS: MAX_AMOUNT_CENTS,
  parseDecimal: parseDecimal,
  toCents: toCents,
  qtyToMicro: qtyToMicro,
  priceToDeci: priceToDeci,
  centsToStr: centsToStr,
  fmtCents: fmtCents,
  rateToBp: rateToBp,
  mulQtyPrice: mulQtyPrice,
  taxOfCents: taxOfCents,
  rmbUpperCents: rmbUpperCents,
  rmbUpper: rmbUpper
};
})(typeof window !== 'undefined' ? window : globalThis);
