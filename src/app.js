/* ============================================================
 * payinvoice 开票助手 - 应用主逻辑
 * 依赖：PayInvoiceQR（QR 编码器）、PayInvoiceCrypto（国密加密）
 * ============================================================ */
(function () {
'use strict';

/* ============================================================
 * 一、工具函数
 * ============================================================ */

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtTime(ts) {
  var d = new Date(ts);
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* 金额展示/大写统一走 PayInvoiceMoney（整数"分"运算，见 money.js） */
function fmtCents(c) { return PayInvoiceMoney.fmtCents(c); }
function rmbUpperCents(c) { return PayInvoiceMoney.rmbUpperCents(c); }

/* GB 32100-2015 统一社会信用代码校验位验证 */
var USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY'; // 31 个字符（不含 I O Z S V）
var USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

function checkUSCC(code) {
  code = String(code || '').trim().toUpperCase();
  if (code.length !== 18) return { ok: false, reason: '统一社会信用代码应为 18 位' };
  var sum = 0;
  for (var i = 0; i < 17; i++) {
    var v = USCC_CHARS.indexOf(code.charAt(i));
    if (v < 0) return { ok: false, reason: '第 ' + (i + 1) + ' 位含无效字符（不得使用 I/O/Z/S/V）' };
    sum += v * USCC_WEIGHTS[i];
  }
  var expect = USCC_CHARS[sum % 31];
  if (expect !== code.charAt(17)) {
    return { ok: false, reason: '校验位不符：第 18 位应为 ' + expect };
  }
  return { ok: true, reason: 'GB 32100 校验通过' };
}

/* 旧式 15 位纳税人识别号（税务机关编制）仅做数字检查 */
function checkLegacyTaxNo(code) {
  return /^\d{15}$/.test(String(code || '').trim());
}

/* 综合税号校验：18 位走 GB32100，15 位走旧规则，其他长度提示 */
function validateTaxNo(code) {
  code = String(code || '').trim();
  if (code === '') return { ok: false, empty: true, reason: '' };
  if (code.length === 18) {
    var r = checkUSCC(code);
    return { ok: r.ok, reason: r.reason };
  }
  if (code.length === 15) {
    return { ok: checkLegacyTaxNo(code), reason: checkLegacyTaxNo(code) ? '15 位税号格式有效' : '15 位税号应为纯数字' };
  }
  if (code.length === 20) {
    return { ok: /^[0-9A-Z]{20}$/.test(code.toUpperCase()), reason: '20 位税务登记证号格式检查' };
  }
  return { ok: false, reason: '长度无效：应为 15/18/20 位' };
}

/* ============================================================
 * 二、状态管理（localStorage）
 * ============================================================ */

var STORAGE_KEY = 'payinvoice_helper_v1';

function defaultState() {
  return {
    seller: { name: '', taxNo: '', addrTel: '', bankAcc: '' },
    buyer: { name: '', taxNo: '', addrTel: '', bankAcc: '', email: '' },
    invoiceType: 'special',   // special 专票 / normal 普票
    invoiceForm: 'digital',   // digital 数电票 / electronic 电子发票(税控) / paper 纸质
    remark: '',
    items: [
      { id: genId(), name: '', qty: '', price: '', taxRate: '13%' }
    ],
    qr: {
      tab: 'basic',           // basic 基础信息 / txn 交易信息
      basicGenAt: 0,          // 基础信息二维码生成时间戳
      txnGenAt: 0,            // 交易信息二维码生成时间戳
      printWidth: 5           // 计划打印宽度 cm
      /* 注意：加密口令不存入 state（不落 localStorage、不进备份），仅存于内存 qrPassword */
    },
    progress: { prereq: {}, guide: {} },
    savedAt: 0
  };
}

function genId() { return 'it' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* 二维码加密口令：仅存于当前页面内存，不写入 localStorage、不进入导出备份 */
var qrPassword = '';

/* ---------- 本地/导入数据白名单校验 ----------
 * 任何进入 state 的数据（本地存储回读或备份导入）都必须经过 sanitizeState：
 *  - 拒绝非对象/数组/超大结构的脏数据；
 *  - 字段逐一类型校验、长度截断、条数限量，防 localStorage 超限与结构破坏；
 *  - 剔除口令等不应持久化的字段。 */
function sStr(v, max) {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number' && isFinite(v)) return String(v).slice(0, max);
  return '';
}
function sNum(v, min, max, dflt) {
  var n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function sBoolMap(v) {
  var out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    Object.keys(v).forEach(function (k) {
      if (k.length <= 64 && typeof v[k] === 'boolean') out[k] = v[k];
    });
  }
  return out;
}

function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  return {
    id: sStr(it.id, 40) || genId(),
    name: sStr(it.name, 200),
    qty: sStr(it.qty, 30),
    price: sStr(it.price, 30),
    amount: sStr(it.amount, 30),
    taxRate: sStr(it.taxRate, 10),
    tax: sStr(it.tax, 30),
    /* 自动带出标记：true 表示该值为公式计算结果，可被后续编辑刷新 */
    _amtAuto: it._amtAuto === true,
    _taxAuto: it._taxAuto === true
  };
}

function sanitizeState(obj) {
  var d = defaultState();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('备份文件结构不正确（应为 JSON 对象）');
  var qr = (obj.qr && typeof obj.qr === 'object' && !Array.isArray(obj.qr)) ? obj.qr : {};
  var items = Array.isArray(obj.items) ? obj.items.slice(0, 200).map(sanitizeItem).filter(Boolean) : [];
  if (items.length === 0) items = d.items;
  return {
    seller: {
      name: sStr(obj.seller && obj.seller.name, 200),
      taxNo: sStr(obj.seller && obj.seller.taxNo, 40),
      addrTel: sStr(obj.seller && obj.seller.addrTel, 120),
      bankAcc: sStr(obj.seller && obj.seller.bankAcc, 120)
    },
    buyer: {
      name: sStr(obj.buyer && obj.buyer.name, 200),
      taxNo: sStr(obj.buyer && obj.buyer.taxNo, 40),
      addrTel: sStr(obj.buyer && obj.buyer.addrTel, 120),
      bankAcc: sStr(obj.buyer && obj.buyer.bankAcc, 120),
      email: sStr(obj.buyer && obj.buyer.email, 100)
    },
    invoiceType: obj.invoiceType === 'normal' ? 'normal' : 'special',
    invoiceForm: ['digital', 'electronic', 'paper'].indexOf(obj.invoiceForm) >= 0 ? obj.invoiceForm : 'digital',
    remark: sStr(obj.remark, 500),
    items: items,
    qr: {
      tab: qr.tab === 'txn' ? 'txn' : 'basic',
      basicGenAt: sNum(qr.basicGenAt, 0, 8.64e15, 0),
      txnGenAt: sNum(qr.txnGenAt, 0, 8.64e15, 0),
      printWidth: sNum(qr.printWidth, 1.8, 30, 5)   /* 打印宽度限制 1.8~30 cm */
    },
    progress: { prereq: sBoolMap(obj.progress && obj.progress.prereq), guide: sBoolMap(obj.progress && obj.progress.guide) },
    savedAt: sNum(obj.savedAt, 0, 8.64e15, 0)
  };
}

var state = loadState();

function loadState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return sanitizeState(JSON.parse(raw));
  } catch (e) {
    return defaultState();
  }
}

var saveTimer = null;

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    state.savedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      flashSaved();
    } catch (e) {
      toast('保存失败：' + (e && e.message ? e.message : '存储空间不足'), 'err');
    }
  }, 300);
}

function flashSaved() {
  var el = $('#saveFlag');
  if (!el) return;
  el.textContent = '已自动保存 ' + fmtTime(state.savedAt).slice(11);
  el.className = 'badge badge-green';
}

/* ============================================================
 * 三、路由与视图框架
 * ============================================================ */

var ROUTES = [
  { path: 'workbench', nav: '开票工作台', ico: '🧾', title: '开票工作台', render: renderWorkbench },
  { path: 'qr', nav: '便捷开票二维码', ico: '📱', title: '便捷开票二维码中心', render: renderQR },
  { path: 'guide', nav: '自助开票指引', ico: '🧭', title: '电子税务局自助开票流程', render: renderGuide },
  { path: 'prereq', nav: '前置条件检查', ico: '✅', title: '前置条件检查', render: renderPrereq },
  { path: 'software', nav: '配套软件管理', ico: '💻', title: '配套软件安装 / 卸载管理', render: renderSoftware },
  { path: 'fault', nav: '异常处理', ico: '🛠️', title: '异常处理手册', render: renderFault },
  { path: 'comply', nav: '合规与安全', ico: '🔒', title: '合规与安全提示', render: renderComply },
  { path: 'data', nav: '数据管理', ico: '🗂️', title: '数据管理', render: renderData }
];

var currentRoute = 'workbench';

function currentPath() {
  var h = location.hash.replace(/^#\/?/, '');
  return ROUTES.some(function (r) { return r.path === h; }) ? h : 'workbench';
}

function navigate(path, replace) {
  if (replace) {
    history.replaceState(null, '', '#/' + path);
  } else {
    location.hash = '#/' + path;
  }
}

window.addEventListener('hashchange', function () {
  var p = currentPath();
  if (p !== currentRoute) {
    currentRoute = p;
    renderShell();
  }
  closeSidebar();
});

function renderShell() {
  var route = ROUTES.filter(function (r) { return r.path === currentRoute; })[0];
  $('#topbarTitle').textContent = route.title;
  $$('.nav-item').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-path') === currentRoute);
  });
  var content = $('#content');
  content.innerHTML = route.render();
  route.afterRender && route.afterRender();
  window.scrollTo(0, 0);
}

/* ============================================================
 * 四、开票工作台
 * ============================================================ */

var TAX_RATES = ['13%', '9%', '6%', '5%', '3%', '1%', '0.5%', '0%'];

function renderWorkbench() {
  var s = state.seller, b = state.buyer;
  var totals = calcTotals();
  return ''
    + '<div class="grid-2">'
    /* ---- 左：表单 ---- */
    + '<div>'
    + '<div class="card"><div class="card-title">纳税人类型与票种</div>'
    + '<div class="form-row">'
    + fieldSelect('纳税人类型', 'wb_taxpayer', ['企业（可直接开具数电票）', '个体工商户（可直接开具数电票）', '自然人（需代开或临时登记）'])
    + fieldSelect('发票类型', 'wb_invType', ['增值税专用发票', '增值税普通发票'])
    + '</div>'
    + '<div class="form-row">'
    + fieldSelect('发票形式', 'wb_invForm', ['数电票（无需票种核定）', '电子发票（税控）', '纸质发票（需税控设备）'])
    + fieldInput('备注', 'wb_remark', state.remark, '如：差额征税、折扣说明等')
    + '</div>'
    + alertHtml('info', '💡', '数电票无需票种核定与发票领用，但开具前须在「我要办税 → 发票使用 → 发票额度」确认可用额度充足。')
    + '</div>'

    + '<div class="card"><div class="card-title">销售方信息（本单位）</div>'
    + '<div class="form-row">'
    + fieldInput('销售方名称', 'wb_sName', s.name, '', true)
    + fieldInput('纳税人识别号', 'wb_sTax', s.taxNo, '18 位统一社会信用代码', true)
    + '</div>'
    + '<div class="form-row">'
    + fieldInput('地址电话', 'wb_sAddr', s.addrTel)
    + fieldInput('开户行及账号', 'wb_sBank', s.bankAcc, '开具专票时必填')
    + '</div></div>'

    + '<div class="card"><div class="card-title">购买方信息</div>'
    + '<div class="alert alert-ok" style="margin-bottom:12px"><span>📱</span><span>购买方信息可通过「便捷开票二维码」扫码带入（48 小时内有效），无需手工录入。也可在二维码中心生成。</span></div>'
    + '<div class="form-row">'
    + fieldInput('购买方名称', 'wb_bName', b.name, '', true)
    + fieldInput('纳税人识别号', 'wb_bTax', b.taxNo, '自动执行 GB 32100 校验位验证', true)
    + '</div>'
    + '<div class="form-row">'
    + fieldInput('地址电话', 'wb_bAddr', b.addrTel, '开具专票时必填')
    + fieldInput('开户行及账号', 'wb_bBank', b.bankAcc, '开具专票时必填')
    + '</div>'
    + fieldInput('接收发票邮箱', 'wb_bEmail', b.email, '用于电子邮件交付')
    + '</div>'

    + '<div class="card"><div class="card-title">交易明细</div>'
    + '<div class="item-row item-head"><span></span><span>项目名称（税收分类编码）</span><span>数量</span><span>单价</span><span>金额</span><span>税率</span><span>税额</span><span></span></div>'
    + state.items.map(function (it, i) {
      var line = lineCalc(it);
      return '<div class="item-row" data-id="' + it.id + '">'
        + '<span class="idx">' + (i + 1) + '</span>'
        + '<input data-f="name" value="' + escapeHtml(it.name) + '" placeholder="如：*信息技术服务*软件开发">'
        + '<input data-f="qty" type="number" min="0" step="any" value="' + escapeHtml(it.qty) + '" placeholder="0">'
        + '<input data-f="price" type="number" min="0" step="any" value="' + escapeHtml(it.price) + '" placeholder="0.00">'
        + '<input data-f="amount" type="number" min="0" step="any" value="' + escapeHtml(it.amount !== '' && it.amount != null ? it.amount : line.amtStr) + '" placeholder="0.00">'
        + '<select data-f="taxRate">' + TAX_RATES.map(function (r) { return '<option' + (it.taxRate === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>'
        + '<input data-f="tax" value="' + escapeHtml(it.tax !== '' && it.tax != null ? it.tax : line.taxStr) + '" placeholder="自动" title="留空则按金额×税率自动计算；填 0 表示零税额">'
        + '<button class="del" data-act="del-item" title="删除本行">✕</button>'
        + '</div>';
    }).join('')
    + '<div class="btn-row"><button class="btn btn-light btn-sm" data-act="add-item">＋ 添加明细行</button>'
    + '<button class="btn btn-light btn-sm" data-act="clear-items">清空明细</button></div>'
    + '<div class="hint" style="margin-top:8px">金额列为不含税金额；数量×单价与金额不一致时以金额列为准，税额可按行覆盖。</div>'
    + '</div>'
    + '</div>'

    /* ---- 右：预览与合计 ---- */
    + '<div>'
    + '<div class="card"><div class="card-title">票面预览（数电票样式）</div>'
    + renderInvoicePreview(totals)
    + '</div>'
    + '<div class="card"><div class="card-title">合计与校验</div>'
    + '<div class="kv" data-kv="amount"><span class="k">不含税金额合计</span><span class="v">¥ ' + fmtCents(totals.amountCents) + '</span></div>'
    + '<div class="kv" data-kv="tax"><span class="k">税额合计</span><span class="v">¥ ' + fmtCents(totals.taxCents) + '</span></div>'
    + '<div class="kv" data-kv="upper"><span class="k">价税合计（大写）</span><span class="v" style="font-size:12px">' + (rmbUpperCents(totals.totalCents) || '—') + '</span></div>'
    + '<div class="kv" data-kv="total"><span class="k">价税合计（小写）</span><span class="v" style="color:var(--red);font-size:16px">¥ ' + fmtCents(totals.totalCents) + '</span></div>'
    + '<div class="btn-row">'
    + '<button class="btn btn-primary" data-act="goto-qr">📱 生成便捷开票二维码</button>'
    + '<button class="btn btn-navy" data-act="open-etax">🌐 打开电子税务局</button>'
    + '</div>'
    + '</div>'
    + '<div class="card"><div class="card-title">开票前自检</div>'
    + renderSelfCheck(totals)
    + '</div>'
    + '</div>'
    + '</div>';
}

function fieldInput(label, id, value, hint, required) {
  return '<div class="field"><label>' + escapeHtml(label) + (required ? '<span class="req">*</span>' : '') + '</label>'
    + '<input id="' + id + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(hint || '') + '">'
    + (hint ? '<div class="hint">' + escapeHtml(hint) + '</div>' : '')
    + '</div>';
}

function fieldSelect(label, id, options) {
  return '<div class="field"><label>' + escapeHtml(label) + '</label>'
    + '<select id="' + id + '">' + options.map(function (o) { return '<option>' + escapeHtml(o) + '</option>'; }).join('') + '</select></div>';
}

function alertHtml(type, ico, text) {
  return '<div class="alert alert-' + type + '"><span>' + ico + '</span><span>' + escapeHtml(text) + '</span></div>';
}

/* 行计算（金额单位：分）：
 * 金额 = 用户手填金额优先（_amtAuto 标记的自动值除外）；
 *        为空或非法时回落到 数量×单价 自动值。
 * 税额 = 用户手填税额优先（含 "0"，表示零税额/免税，_taxAuto 标记除外）；
 *        未手填时按行金额 × 税率四舍五入到分。 */
function lineCalc(it) {
  var auto = PayInvoiceMoney.mulQtyPrice(it.qty, it.price);
  var amt = null;
  if (it.amount !== '' && it.amount != null) {
    amt = PayInvoiceMoney.toCents(it.amount);
    if (amt == null) amt = auto; /* 手填非法时回落到自动值，自检会提示 */
  } else {
    amt = auto;
  }
  /* 自动带出的金额：随 数量×单价 重新计算；无法计算时保留原值（与输入框显示保持一致） */
  if (it._amtAuto && auto != null) amt = auto;
  var tax = null;
  if (it.tax !== '' && it.tax != null && !it._taxAuto) {
    tax = PayInvoiceMoney.toCents(it.tax); /* "0" → 0，零税额 */
  }
  if (tax == null) {
    var bp = PayInvoiceMoney.rateToBp(it.taxRate);
    if (amt != null && bp != null) tax = PayInvoiceMoney.taxOfCents(amt, bp);
  }
  return {
    amt: amt,                                  /* 分；null = 无效 */
    tax: tax,                                  /* 分；null = 无效 */
    amtStr: amt == null ? '' : PayInvoiceMoney.centsToStr(amt),
    taxStr: tax == null ? '' : PayInvoiceMoney.centsToStr(tax),
    amountValid: it.amount === '' || it.amount == null || PayInvoiceMoney.toCents(it.amount) != null,
    taxValid: it.tax === '' || it.tax == null || PayInvoiceMoney.toCents(it.tax) != null
  };
}

/* 合计（全部为整数分运算，无浮点累加误差）；
 * 有效行 = 手填/自动金额可解析且 > 0 的明细行 */
function calcTotals() {
  var amountCents = 0, taxCents = 0, validLines = 0, allValid = true;
  state.items.forEach(function (it) {
    var line = lineCalc(it);
    if (!line.amountValid || !line.taxValid) allValid = false;
    if (line.amt != null && line.amt > 0) {
      amountCents += line.amt;
      validLines++;
    }
    if (line.tax != null && line.tax > 0) taxCents += line.tax;
  });
  return {
    amountCents: amountCents,
    taxCents: taxCents,
    totalCents: amountCents + taxCents,
    validLines: validLines,
    allValid: allValid
  };
}

function ph(v, label) {
  return v && String(v).trim() ? escapeHtml(v) : '<span class="ph">' + escapeHtml(label) + '</span>';
}

function renderInvoicePreview(t) {
  var s = state.seller, b = state.buyer;
  var typeName = state.invoiceType === 'special' ? '增值税专用发票' : '增值税普通发票';
  var formName = { digital: '数电票', electronic: '电子发票（税控）', paper: '纸质发票' }[state.invoiceForm] || '';
  return '<div class="invoice-preview">'
    + '<div class="inv-head"><div class="inv-title">' + escapeHtml(typeName) + '</div>'
    + '<div class="inv-no">' + escapeHtml(formName) + ' · 发票号码：20 位数电票号（开具后生成）</div></div>'
    + '<div class="inv-grid">'
    + '<div><div class="k">销售方名称</div><div class="v">' + ph(s.name, '请填写销售方名称') + '</div></div>'
    + '<div><div class="k">购买方名称</div><div class="v">' + ph(b.name, '请填写购买方名称') + '</div></div>'
    + '<div><div class="k">销售方税号</div><div class="v">' + ph(s.taxNo, '请填写纳税人识别号') + '</div></div>'
    + '<div><div class="k">购买方税号</div><div class="v">' + ph(b.taxNo, '请填写纳税人识别号') + '</div></div>'
    + (state.invoiceType === 'special' ? '<div><div class="k">地址电话</div><div class="v">' + ph(b.addrTel, '专票必填') + '</div></div>' : '')
    + (state.invoiceType === 'special' ? '<div><div class="k">开户行及账号</div><div class="v">' + ph(b.bankAcc, '专票必填') + '</div></div>' : '')
    + '</div>'
    + '<div class="tbl-wrap" style="border:none"><table class="tbl"><thead><tr><th>项目名称</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th class="num">税率</th><th class="num">税额</th></tr></thead><tbody>'
    + (state.items.length === 0 ? '<tr><td colspan="6" class="empty">暂无明细行</td></tr>' : '')
    + state.items.map(function (it) {
      var line = lineCalc(it);
      var amt = line.amtStr;   /* 规范化到分的展示值 */
      var tax = line.taxStr;
      return '<tr><td>' + (it.name ? escapeHtml(it.name) : '<span style="color:var(--ink-3)">（未填写）</span>') + '</td>'
        + '<td class="num">' + escapeHtml(it.qty || '—') + '</td>'
        + '<td class="num">' + (it.price ? escapeHtml(it.price) : '—') + '</td>'
        + '<td class="num">' + (amt ? escapeHtml(amt) : '—') + '</td>'
        + '<td class="num">' + escapeHtml(it.taxRate || '—') + '</td>'
        + '<td class="num">' + (tax ? escapeHtml(tax) : '—') + '</td></tr>';
    }).join('')
    + '</tbody></table></div>'
    + '<div class="inv-total"><span class="cap">价税合计（大写）：' + (rmbUpperCents(t.totalCents) || '—') + '</span>'
    + '<span>小写：<span class="amt">¥ ' + fmtCents(t.totalCents) + '</span></span></div>'
    + (state.remark ? '<div style="margin-top:6px;font-size:11.5px;color:var(--ink-2)">备注：' + escapeHtml(state.remark) + '</div>' : '')
    + '</div>';
}

function renderSelfCheck(t) {
  var s = state.seller, b = state.buyer;
  var checks = [];
  checks.push([!!s.name.trim(), '销售方名称已填写']);
  checks.push([!!s.taxNo.trim(), '销售方税号已填写']);
  checks.push([!!b.name.trim(), '购买方名称已填写']);
  checks.push([!!b.taxNo.trim(), '购买方税号已填写']);
  if (state.invoiceType === 'special') {
    checks.push([!!b.addrTel.trim(), '专票地址电话已填写']);
    checks.push([!!b.bankAcc.trim(), '专票开户行及账号已填写']);
  }
  checks.push([state.items.some(function (it) {
    return it.name && it.name.trim() && (function () { var l = lineCalc(it); return l.amt != null && l.amt > 0; })();
  }), '至少一行有效交易明细（名称 + 金额）']);
  checks.push([t.totalCents > 0, '价税合计大于 0']);
  checks.push([t.allValid, '明细金额/税额均为有效数字（非负、小数不超限）']);
  var taxNoCheck = validateTaxNo(b.taxNo);
  checks.push([!b.taxNo.trim() || taxNoCheck.ok, '购买方税号校验（' + (b.taxNo.trim() ? (taxNoCheck.ok ? '通过' : '未通过') : '待填写') + '）']);
  var okCount = checks.filter(function (c) { return c[0]; }).length;
  return '<div style="font-size:12.5px;color:var(--ink-2);margin-bottom:8px">已通过 ' + okCount + ' / ' + checks.length + ' 项</div>'
    + '<ul class="spec-list">' + checks.map(function (c) {
      return '<li><span class="' + (c[0] ? 'ok-ico' : 'bad-ico') + '">' + (c[0] ? '✓' : '✗') + '</span>'
        + '<span class="sp-name">' + escapeHtml(c[1]) + '</span>'
        + '<span class="sp-val ' + (c[0] ? 'badge-green' : 'badge-amber') + ' badge">' + (c[0] ? '通过' : '待完善') + '</span></li>';
    }).join('') + '</ul>';
}

/* ---- 工作台事件绑定 ---- */

function bindWorkbench() {
  // 文本/选择输入 → 状态
  [['wb_sName', 'seller', 'name'], ['wb_sTax', 'seller', 'taxNo'], ['wb_sAddr', 'seller', 'addrTel'], ['wb_sBank', 'seller', 'bankAcc'],
   ['wb_bName', 'buyer', 'name'], ['wb_bTax', 'buyer', 'taxNo'], ['wb_bAddr', 'buyer', 'addrTel'], ['wb_bBank', 'buyer', 'bankAcc'],
   ['wb_bEmail', 'buyer', 'email'], ['wb_remark', null, 'remark']].forEach(function (m) {
    var el = document.getElementById(m[0]);
    if (!el) return;
    el.addEventListener('input', function () {
      if (m[1]) state[m[1]][m[2]] = el.value; else state[m[2]] = el.value;
      saveState();
      // 局部刷新：预览/自检/大写
      if (m[1] === 'buyer' || m[1] === 'seller' || m[2] === 'remark') refreshWorkbenchPreview();
    });
  });

  var typeSel = document.getElementById('wb_invType');
  if (typeSel) {
    typeSel.value = state.invoiceType === 'special' ? '增值税专用发票' : '增值税普通发票';
    typeSel.addEventListener('change', function () {
      state.invoiceType = typeSel.value === '增值税专用发票' ? 'special' : 'normal';
      saveState(); renderShell();
    });
  }
  var formSel = document.getElementById('wb_invForm');
  if (formSel) {
    formSel.value = { digital: '数电票（无需票种核定）', electronic: '电子发票（税控）', paper: '纸质发票（需税控设备）' }[state.invoiceForm];
    formSel.addEventListener('change', function () {
      state.invoiceForm = formSel.value.indexOf('数电票') === 0 ? 'digital' : formSel.value.indexOf('税控') > 0 ? 'electronic' : 'paper';
      saveState(); renderShell();
    });
  }

  // 明细行输入
  $$('.item-row[data-id]').forEach(function (row) {
    var id = row.getAttribute('data-id');
    $$('input,select', row).forEach(function (inp) {
      inp.addEventListener('input', function () {
        var it = state.items.filter(function (x) { return x.id === id; })[0];
        if (!it) return;
        var f = inp.getAttribute('data-f');
        it[f] = inp.value;
        /* 用户在金额/税额列直接输入 → 标记为手填（此后不被自动计算覆盖）；
           自动带出的值带 _amtAuto/_taxAuto 标记，可被后续数量/单价/税率变更刷新 */
        if (f === 'amount') it._amtAuto = false;
        if (f === 'tax') it._taxAuto = false;
        var line = lineCalc(it);
        /* 金额列为空/非法/自动值时，用 数量×单价 的规范化结果带出 */
        if (f !== 'amount' && (it._amtAuto || PayInvoiceMoney.toCents(it.amount) == null) && line.amtStr !== '') {
          it.amount = line.amtStr;
          it._amtAuto = true;
          var amtInput = $('input[data-f="amount"]', row);
          if (amtInput) amtInput.value = line.amtStr;
        }
        /* 税额列为空/非法/自动值时，按 金额×税率 带出；金额手改时自动税额跟随刷新 */
        var taxFollow = (f === 'amount' && it._taxAuto) || (f !== 'tax' && (it._taxAuto || PayInvoiceMoney.toCents(it.tax) == null));
        if (taxFollow && line.taxStr !== '') {
          it.tax = line.taxStr;
          it._taxAuto = true;
          var taxInput = $('input[data-f="tax"]', row);
          if (taxInput) taxInput.value = line.taxStr;
        }
        saveState(); refreshWorkbenchPreview();
      });
    });
  });

  // 按钮
  bindAction('add-item', function () {
    state.items.push({ id: genId(), name: '', qty: '', price: '', amount: '', taxRate: '13%', tax: '' });
    saveState(); renderShell();
  });
  bindAction('clear-items', function () {
    state.items = [{ id: genId(), name: '', qty: '', price: '', amount: '', taxRate: '13%', tax: '' }];
    saveState(); renderShell();
  });
  bindAction('del-item', function (btn) {
    var row = btn.closest('.item-row');
    var id = row.getAttribute('data-id');
    state.items = state.items.filter(function (x) { return x.id !== id; });
    if (state.items.length === 0) state.items.push({ id: genId(), name: '', qty: '', price: '', amount: '', taxRate: '13%', tax: '' });
    saveState(); renderShell();
  });
  bindAction('goto-qr', function () { navigate('qr'); });
  bindAction('open-etax', function () { window.open('https://etax.shanghai.chinatax.gov.cn', '_blank', 'noopener'); });
}

function refreshWorkbenchPreview() {
  var t = calcTotals();
  var previewCard = $('.card .invoice-preview');
  if (previewCard) {
    var card = previewCard.closest('.card');
    card.innerHTML = '<div class="card-title">票面预览（数电票样式）</div>' + renderInvoicePreview(t);
  }
  var checkCard = null;
  $$('.card').forEach(function (c) {
    if ($('.card-title', c) && $('.card-title', c).textContent === '开票前自检') checkCard = c;
  });
  if (checkCard) {
    checkCard.innerHTML = '<div class="card-title">开票前自检</div>' + renderSelfCheck(t);
  }
  /* 合计区用 data-kv 定位，避免依赖 DOM 顺序 */
  var kv = {};
  $$('.kv[data-kv]').forEach(function (el) { kv[el.getAttribute('data-kv')] = el.querySelector('.v'); });
  if (kv.amount) kv.amount.textContent = '¥ ' + fmtCents(t.amountCents);
  if (kv.tax) kv.tax.textContent = '¥ ' + fmtCents(t.taxCents);
  if (kv.upper) kv.upper.textContent = rmbUpperCents(t.totalCents) || '—';
  if (kv.total) kv.total.textContent = '¥ ' + fmtCents(t.totalCents);
}

/* ============================================================
 * 五、便捷开票二维码中心
 * ============================================================ */

var QR_COUNTDOWN = { basic: 48 * 3600 * 1000, txn: 24 * 3600 * 1000 };
var countdownTimer = null;

function qrPayload(type) {
  var s = state.seller, b = state.buyer;
  var t = calcTotals();
  if (type === 'basic') {
    return {
      type: 'basic', ver: 1,
      buyer: { name: b.name, taxNo: b.taxNo, addrTel: b.addrTel, bankAcc: b.bankAcc, email: b.email },
      ts: state.qr.basicGenAt
    };
  }
  return {
    type: 'txn', ver: 1,
    seller: { name: s.name, taxNo: s.taxNo },
    buyer: { name: b.name, taxNo: b.taxNo },
    items: state.items.filter(function (it) { return it.name && it.name.trim(); }).map(function (it) {
      var line = lineCalc(it);
      return {
        name: it.name, qty: it.qty, price: it.price,
        amount: line.amtStr,
        taxRate: it.taxRate,
        tax: line.taxStr
      };
    }).filter(function (row) { return row.amount !== ''; }),
    total: {
      amount: PayInvoiceMoney.centsToStr(t.amountCents),
      tax: PayInvoiceMoney.centsToStr(t.taxCents),
      total: PayInvoiceMoney.centsToStr(t.totalCents)
    },
    ts: state.qr.txnGenAt
  };
}

function renderQR() {
  var tab = state.qr.tab;
  var payload = qrPayload(tab);
  var genAt = tab === 'basic' ? state.qr.basicGenAt : state.qr.txnGenAt;
  var password = qrPassword;            /* 仅内存，不持久化 */
  var pwdOk = password.length >= 8;
  var hasData = tab === 'basic'
    ? (state.buyer.name.trim() && state.buyer.taxNo.trim())
    : (state.seller.name.trim() && state.seller.taxNo.trim() && payload.items.length > 0);

  var svgHtml = '', meta = '', encrypted = null;
  if (hasData && pwdOk) {
    try {
      encrypted = PayInvoiceCrypto.encryptPayload(payload, password);
      var r = PayInvoiceQR.toSVG(encrypted, { ecLevel: 'M', quiet: 4, scale: 8 });
      svgHtml = r.svg;
      var n = r.moduleCount;
      var totalModules = n + 8; // 含两侧静默区
      var minPrintCm = 1.8;
      var perModuleCm = (state.qr.printWidth / totalModules);
      meta = {
        version: r.version, ec: r.ecLevel, mask: r.mask, n: n, totalModules: totalModules,
        payloadLen: encrypted.length, perModuleCm: perModuleCm, minPrintCm: minPrintCm,
        sizeOk: state.qr.printWidth >= minPrintCm
      };
    } catch (e) {
      svgHtml = '<div class="alert alert-err"><span>⚠️</span><span>生成失败：' + escapeHtml(e.message) + '。请缩短内容或检查输入。</span></div>';
    }
  } else if (hasData) {
    svgHtml = '<div class="alert alert-warn"><span>⚠️</span><span>请先输入至少 8 位加密口令（字母、数字组合）再生成二维码。口令仅保存在当前页面内存中：不写入本地存储、不进入导出备份，刷新页面后需重新输入。</span></div>';
  }

  var remaining = genAt ? (genAt + QR_COUNTDOWN[tab] - Date.now()) : -1;
  var expired = remaining <= 0;

  return ''
    + '<div class="alert alert-info"><span>📋</span><span>依据《便捷开票二维码应用规范》：QR 码、M 级纠错、尺寸 ≥ 1.8cm×1.8cm、四周静默区 ≥ 4 模块、涉及纳税人信息必须采用国密算法加密。本工具二维码内容为本地加密载荷，仅供内部流转与打印；正式开票二维码请以电子税务局官方生成结果为准。</span></div>'
    + '<div class="qr-tabs">'
    + '<button class="qr-tab' + (tab === 'basic' ? ' active' : '') + '" data-act="qr-tab" data-v="basic">基础信息二维码（购买方长期使用 · 48 小时）</button>'
    + '<button class="qr-tab' + (tab === 'txn' ? ' active' : '') + '" data-act="qr-tab" data-v="txn">交易信息二维码（单笔即时 · 24 小时）</button>'
    + '</div>'
    + '<div class="qr-layout">'
    /* ---- 左：二维码展示 ---- */
    + '<div>'
    + '<div class="qr-stage">'
    + (hasData ? svgHtml : '<div class="empty">' + (tab === 'basic'
      ? '请先在「开票工作台」填写购买方名称与纳税人识别号'
      : '请先在「开票工作台」填写销售方信息与至少一行交易明细') + '</div>')
    + '</div>'
    + '<div class="countdown' + (expired && genAt ? ' expired' : '') + '">'
    + (genAt ? (expired
      ? '<div>⏰ 二维码已过期（' + (tab === 'basic' ? '48' : '24') + ' 小时有效期）<br><span style="font-size:12px">请点击「重新生成」获取新二维码</span></div>'
      : '<div>有效期剩余（' + (tab === 'basic' ? '基础信息 48 小时' : '交易信息 24 小时') + '）</div><div class="big" id="qrCountdown">' + fmtRemaining(remaining) + '</div><div style="font-size:11px;margin-top:2px">生成时间：' + fmtTime(genAt) + '</div>')
    : '<div>尚未生成二维码<br><span style="font-size:12px">点击「生成二维码」开始计时</span></div>')
    + '</div>'
    + '<div class="btn-row" style="margin-top:12px">'
    + '<button class="btn btn-primary" data-act="qr-gen" ' + (hasData ? '' : 'disabled') + '>🔄 ' + (genAt ? '重新生成' : '生成二维码') + '</button>'
    + '<button class="btn btn-navy" data-act="qr-png" ' + (hasData && !expired && encrypted ? '' : 'disabled') + '>💾 下载 PNG</button>'
    + '<button class="btn btn-ghost" data-act="qr-print" ' + (hasData && !expired && encrypted ? '' : 'disabled') + '>🖨️ 打印</button>'
    + '</div>'
    + '</div>'
    /* ---- 右：加密载荷 + 规范面板 ---- */
    + '<div>'
    + '<div class="card"><div class="card-title">国密加密载荷（SM4-CBC）</div>'
    + '<div class="form-row">'
    + '<div class="field"><label>加密口令</label><input id="qrPwd" type="password" autocomplete="off" value="' + escapeHtml(qrPassword) + '" placeholder="至少 8 位（字母数字组合）"><div class="hint">口令经 PBKDF2-HMAC-SHA256（10 万次迭代）派生加密与校验密钥；载荷 = salt + IV + SM4 密文 + HMAC（P2 格式）。仅存于当前页面内存，不写入本地存储、不进入导出备份。</div></div>'
    + '<div class="field"><label>计划打印宽度（cm）</label><input id="qrWidth" type="number" min="1.8" max="30" step="0.1" value="' + state.qr.printWidth + '"><div class="hint">用于核算每模块物理尺寸是否满足 ≥1.8cm（允许 1.8~30）</div></div>'
    + '</div>'
    + (encrypted ? '<div class="payload-box" id="qrPayloadBox">' + escapeHtml(encrypted) + '<button class="btn btn-sm btn-light copy-btn" data-act="qr-copy">复制</button></div>'
      : '<div class="empty">' + (hasData ? '输入加密口令后自动生成加密载荷' : '填写开票信息后自动生成加密载荷') + '</div>')
    + '</div>'
    + '<div class="card"><div class="card-title">规范合规面板</div>'
    + '<ul class="spec-list">'
    + specRow('编码格式', 'QR 码（ISO/IEC 18004）', true)
    + specRow('纠错等级', meta ? meta.ec + ' 级' : 'M 级', meta ? meta.ec === 'M' : true)
    + specRow('静默区', meta ? meta.totalModules - meta.n + ' 模块（两侧合计）' : '≥ 4 模块', meta ? (meta.totalModules - meta.n) >= 4 : true)
    + specRow('物理尺寸', meta ? state.qr.printWidth.toFixed(1) + ' cm（每模块 ' + meta.perModuleCm.toFixed(3) + ' cm）' : '≥ 1.8 cm × 1.8 cm', meta ? meta.sizeOk : true)
    + specRow('模块总数', meta ? meta.n + ' × ' + meta.n : '—', true)
    + specRow('二维码版本', meta ? 'Version ' + meta.version : '—', true)
    + specRow('加密算法', 'SM4-CBC（GM/T 0002-2012）+ PBKDF2 / HMAC-SHA256', true)
    + specRow('载荷长度', meta ? meta.payloadLen + ' 字符' : '—', true)
    + '</ul>'
    + (meta && !meta.sizeOk ? '<div class="alert alert-warn" style="margin-top:10px"><span>⚠️</span><span>计划打印宽度 ' + state.qr.printWidth.toFixed(1) + ' cm 小于规范要求的 1.8 cm，请增大打印宽度。</span></div>' : '')
    + '</div>'
    + '<div class="card"><div class="card-title">扫码带入流程</div>'
    + '<ol style="padding-left:20px;font-size:13px;color:var(--ink-2);line-height:2">'
    + '<li>购买方使用 <b>微信 / 支付宝 / 个人所得税 APP / 电子税务局 APP</b> 扫描二维码</li>'
    + '<li>购买方核对 / 补填抬头信息后提交</li>'
    + '<li>销售方进入「我要办税 → 发票使用 → 蓝字发票开具 → 立即开票」</li>'
    + '<li>在开票列表选择「扫码带入」→ 购买方信息自动填充 → 继续开票</li>'
    + '</ol></div>'
    + '</div>'
    + '</div>';
}

function specRow(name, val, ok) {
  return '<li><span class="' + (ok ? 'ok-ico' : 'bad-ico') + '">' + (ok ? '✓' : '✗') + '</span>'
    + '<span class="sp-name">' + escapeHtml(name) + '</span><span class="sp-val">' + escapeHtml(val) + '</span></li>';
}

function fmtRemaining(ms) {
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return p(h) + ':' + p(m) + ':' + p(sec);
}

function bindQR() {
  bindAction('qr-tab', function (btn) {
    state.qr.tab = btn.getAttribute('data-v');
    saveState(); renderShell();
  });
  var pwd = document.getElementById('qrPwd');
  if (pwd) {
    pwd.addEventListener('input', function () {
      qrPassword = pwd.value;   /* 仅内存，不调用 saveState（口令不落盘） */
    });
    pwd.addEventListener('change', function () {
      renderShell();            /* 失焦后用新口令重新生成二维码 */
    });
  }
  var w = document.getElementById('qrWidth');
  if (w) w.addEventListener('input', function () {
    var nw = parseFloat(w.value);
    state.qr.printWidth = isFinite(nw) ? Math.min(30, Math.max(1.8, nw)) : 5;
    saveState();
  });
  if (w) w.addEventListener('change', function () { renderShell(); });

  bindAction('qr-gen', function () {
    if (qrPassword.length < 8) {
      toast('请先输入至少 8 位加密口令再生成二维码', 'err');
      var pwdEl = document.getElementById('qrPwd');
      if (pwdEl) pwdEl.focus();
      return;
    }
    if (state.qr.tab === 'basic') state.qr.basicGenAt = Date.now();
    else state.qr.txnGenAt = Date.now();
    saveState(); renderShell();
    toast('二维码已生成，有效期计时开始', 'ok');
  });
  bindAction('qr-png', function () { downloadPNG(); });
  bindAction('qr-print', function () { printQR(); });
  bindAction('qr-copy', function (btn) {
    var text = $('#qrPayloadBox').textContent.replace(/复制$/, '');
    copyText(text, btn);
  });

  // 倒计时
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  if (currentRoute !== 'qr') { clearInterval(countdownTimer); countdownTimer = null; return; }
  var el = document.getElementById('qrCountdown');
  if (!el) return;
  var genAt = state.qr.tab === 'basic' ? state.qr.basicGenAt : state.qr.txnGenAt;
  if (!genAt) return;
  var remaining = genAt + QR_COUNTDOWN[state.qr.tab] - Date.now();
  if (remaining <= 0) {
    clearInterval(countdownTimer); countdownTimer = null;
    renderShell();
    return;
  }
  el.textContent = fmtRemaining(remaining);
}

function currentQRSVGString() {
  var stage = $('.qr-stage svg');
  if (!stage) return null;
  return new XMLSerializer().serializeToString(stage);
}

/* 取当前二维码的加密载荷文本（与页面展示一致） */
function currentQRPayload() {
  var box = $('#qrPayloadBox');
  if (!box) return null;
  return box.textContent.replace(/复制$/, '').replace(/已复制$/, '');
}

/* 生成高密度 SVG（16px/模块，约 1800px，供打印/导出） */
function hiResSVG() {
  var payload = currentQRPayload();
  if (!payload) return null;
  try {
    return PayInvoiceQR.toSVG(payload, { ecLevel: 'M', quiet: 4, scale: 16 }).svg;
  } catch (e) {
    return null;
  }
}

function downloadPNG() {
  var svgStr = hiResSVG() || currentQRSVGString();
  if (!svgStr) { toast('请先生成二维码', 'err'); return; }
  var img = new Image();
  var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  img.onload = function () {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = img.width || 400;
      canvas.height = img.height || 400;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        var name = state.qr.tab === 'basic' ? '基础信息二维码' : '交易信息二维码';
        a.download = 'payinvoice_' + name + '_' + Date.now() + '.png';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        toast('PNG 已下载（' + canvas.width + '×' + canvas.height + ' px，16px/模块）', 'ok');
      }, 'image/png');
    } catch (e) {
      toast('PNG 导出失败：' + e.message, 'err');
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = function () { URL.revokeObjectURL(url); toast('SVG 渲染失败', 'err'); };
  img.src = url;
}

function printQR() {
  var svgStr = hiResSVG() || currentQRSVGString();
  if (!svgStr) { toast('请先生成二维码', 'err'); return; }
  var w = window.open('', '_blank');
  if (!w) { toast('浏览器拦截了打印窗口，请允许弹出窗口', 'err'); return; }
  w.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>打印便捷开票二维码</title>'
    + '<style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif}'
    + 'img{max-width:92vw;max-height:72vh}'
    + 'p{font-size:12px;color:#555;margin-top:12px}'
    + '@media print{@page{margin:1cm}}</style></head><body>'
    + '<img src="data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr))) + '">'
    + '<p>便捷开票二维码 · ' + (state.qr.tab === 'basic' ? '基础信息（48 小时）' : '交易信息（24 小时）') + ' · 由 payinvoice 开票助手生成</p>'
    + '</body></html>');
  w.document.close();
  setTimeout(function () { w.print(); }, 400);
}

function copyText(text, btn) {
  function done() {
    if (btn) { var old = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = old; }, 1500); }
    toast('已复制到剪贴板', 'ok');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else {
    fallbackCopy(text); done();
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

/* ============================================================
 * 六、自助开票指引（9 步）
 * ============================================================ */

var GUIDE_STEPS = [
  { t: '登录电子税务局', a: '浏览器访问 https://etax.shanghai.chinatax.gov.cn，选择「企业业务」，输入税号/账号密码，或使用「电子税务局 APP 扫码」/插入 CA 证书登录。', e: '进入电子税务局首页，右上角显示企业名称。', f: '密码错误/账号锁定：通过「忘记密码」找回或联系主管税务机关重置；扫码登录失败见异常处理「用户令牌无效」。' },
  { t: '进入开票模块', a: '「我要办税 → 发票使用 → 蓝字发票开具 → 立即开票」', e: '进入开票信息填写页面。', f: '菜单缺失：检查实名认证状态与办税员权限（「用户管理 → 办税员权限」），或确认登录身份为开票主体本身。' },
  { t: '选择发票类型与形式', a: '发票类型：增值税专用发票 / 增值税普通发票；发票形式：数电票 / 电子发票（税控）/ 纸质发票。', e: '页面切换为对应票种开具界面。', f: '无数电票选项：确认纳税人类型与注册信息，自然人需代开；额度不足见异常处理。' },
  { t: '填写购买方信息', a: '方式一（推荐）：选择「扫码带入」，自动同步 48 小时内的扫码信息；方式二：手动录入购买方名称、税号，专票还必须填写地址电话、开户行及账号。', e: '购买方信息完整准确，系统自动校验税号规则。', f: '扫码带入无信息：确认二维码未过期（基础信息 48 小时/交易信息 24 小时）且网络正常；税号校验不通过：核对购买方税号，或让购买方重新扫码提交。' },
  { t: '填写交易信息', a: '逐行填写：项目名称（选择税收分类编码）、数量、单价、金额、税率/征收率、税额、价税合计；差额征税/折扣等按需选择。', e: '系统自动计算税额与价税合计，行数据校验通过。', f: '税率带出不符：核实商品/服务税收分类编码；合计不符：检查数量×单价与折扣行；差额征税需先备案。' },
  { t: '确认信息', a: '点击「预览」核对票面全部信息（购销双方、明细、税率、价税合计）。', e: '票面预览无误。', f: '信息错误：返回修改；已开具信息错误见异常处理「发票信息错误」。' },
  { t: '发票开具', a: '确认无误后点击「发票开具」，按提示完成短信/APP 验证（如开通）。', e: '系统返回开具成功，生成数电票票号（20 位）。', f: '开具失败报错：核对额度、网络、登录状态；额度不足见异常处理。' },
  { t: '选择交付方式', a: '可选：二维码交付（生成票面二维码供购买方扫码下载）、电子邮件交付（填写购买方邮箱，可设置自动交付）、PDF 下载、OFD 下载。', e: '交付状态显示「已交付」，购买方收到发票文件或二维码。', f: '邮件未收到：检查垃圾邮件箱，确认邮箱无误后在「发票查询」重新交付；PDF/OFD 下载失败：换浏览器或清理缓存后重试。' },
  { t: '验证开票结果', a: '「我要办税 → 发票使用 → 发票查询」按条件查询；核对票号、金额、税率、交付状态；可通过全国增值税发票查验平台验证真伪。', e: '查询结果与票面一致，状态「已开具」。', f: '查询不到：确认开具主体与登录主体一致；数电票通常即时可查。' }
];

function renderGuide() {
  var done = state.progress.guide || {};
  var doneCount = GUIDE_STEPS.filter(function (_, i) { return done[i]; }).length;
  return ''
    + '<div class="card"><div class="card-title">固定导航路径</div>'
    + '<div class="alert alert-info"><span>🧭</span><span><b>我要办税 → 发票使用 → 蓝字发票开具 → 立即开票</b>（数电票无需票种核定与发票领用，每次开具前在「发票额度」确认可用额度充足）</span></div>'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
    + '<span style="font-size:12.5px;color:var(--ink-2)">进度：' + doneCount + ' / ' + GUIDE_STEPS.length + ' 步</span>'
    + '<button class="btn btn-sm btn-light" data-act="guide-reset">重置进度</button>'
    + '</div>'
    + '<div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + (doneCount / GUIDE_STEPS.length * 100) + '%;background:var(--green);transition:width .3s"></div></div>'
    + '</div>'
    + '<div class="card steps">'
    + GUIDE_STEPS.map(function (s, i) {
      return '<div class="step-item' + (done[i] ? ' done' : '') + '">'
        + '<div class="step-no">' + (done[i] ? '✓' : (i + 1)) + '</div>'
        + '<div class="step-body"><div class="step-title">' + escapeHtml(s.t) + '</div>'
        + '<div class="step-act">' + escapeHtml(s.a) + '</div>'
        + '<div class="step-exp">✅ 预期：' + escapeHtml(s.e) + '</div>'
        + '<div class="step-err">⚠️ 异常：' + escapeHtml(s.f) + '</div></div>'
        + '<button class="step-check' + (done[i] ? ' on' : '') + '" data-act="guide-toggle" data-i="' + i + '">' + (done[i] ? '已完成' : '标记完成') + '</button>'
        + '</div>';
    }).join('')
    + '</div>';
}

function bindGuide() {
  bindAction('guide-toggle', function (btn) {
    var i = btn.getAttribute('data-i');
    state.progress.guide[i] = !state.progress.guide[i];
    saveState(); renderShell();
  });
  bindAction('guide-reset', function () { state.progress.guide = {}; saveState(); renderShell(); });
}

/* ============================================================
 * 七、前置条件检查
 * ============================================================ */

var PREREQ_ITEMS = [
  { name: '实名认证状态', desc: '登录后进入「我的信息 → 用户管理」查看办税员实名认证状态。法定代表人/财务负责人/办税员须已完成实名认证；未通过可下载「电子税务局」APP 完成人脸识别，或到主管税务机关办税服务厅办理。' },
  { name: '税务登记状态', desc: '「我的信息 → 纳税人信息 → 登记信息」登记状态应为「正常」。非正常户需先补申报、缴清欠税及罚款，申请解除非正常。' },
  { name: '票种核定情况', desc: '数电票无需票种核定、无需发票领用；电子发票（税控）/纸质发票需已核定对应票种，未核定在「我要办税 → 发票使用 → 发票票种核定」申请。' },
  { name: '可用开票额度', desc: '「我要办税 → 发票使用 → 发票额度」查看数电票授信额度，可用额度须 ≥ 本次开票金额；不足时在「发票额度调整」申请调整或联系主管税务机关。' },
  { name: '操作系统兼容性', desc: '数电票打印控件支持 Windows 7 / 10 / 11；发票助手 PC 版为免安装客户端；发票助手安卓版支持 Android。macOS 无法安装打印控件，需改用 Windows 电脑或到办税服务厅。' },
  { name: '软件版本兼容性', desc: '官网「下载中心 → 软件下载 → 发票助手」应使用官方最新版本；旧版本可能存在数电票兼容问题，先卸载旧版再装最新版。' }
];

function renderPrereq() {
  var done = state.progress.prereq || {};
  var doneCount = PREREQ_ITEMS.filter(function (_, i) { return done[i]; }).length;
  return ''
    + '<div class="card"><div class="card-title">纳税人类型分支</div>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>纳税人类型</th><th>开票资格</th><th>执行路径</th></tr></thead><tbody>'
    + '<tr><td><b>企业</b></td><td>可直接开具数电票（专票/普票）</td><td>直接按「自助开票指引」执行</td></tr>'
    + '<tr><td><b>个体工商户</b></td><td>可直接开具数电票（专票/普票）</td><td>直接按「自助开票指引」执行</td></tr>'
    + '<tr><td><b>自然人</b></td><td>一般不得直接开具数电票</td><td>办理临时税务登记后按企业流程开具，或通过电子税务局「代开增值税发票」申请税务机关代开</td></tr>'
    + '</tbody></table></div></div>'
    + '<div class="card"><div class="card-title">前置条件检查清单（' + doneCount + ' / ' + PREREQ_ITEMS.length + '）</div>'
    + PREREQ_ITEMS.map(function (it, i) {
      return '<div class="check-item' + (done[i] ? ' checked' : '') + '">'
        + '<div class="check-box" data-act="prereq-toggle" data-i="' + i + '">' + (done[i] ? '✓' : '') + '</div>'
        + '<div><div class="check-name">' + escapeHtml(it.name) + '</div><div class="check-desc">' + escapeHtml(it.desc) + '</div></div></div>';
    }).join('')
    + '<div class="btn-row"><button class="btn btn-sm btn-light" data-act="prereq-reset">重置检查</button>'
    + '<button class="btn btn-sm btn-navy" data-act="goto-guide">前往自助开票指引 →</button></div>'
    + '</div>';
}

function bindPrereq() {
  bindAction('prereq-toggle', function (el) {
    var i = el.getAttribute('data-i');
    state.progress.prereq[i] = !state.progress.prereq[i];
    saveState(); renderShell();
  });
  bindAction('prereq-reset', function () { state.progress.prereq = {}; saveState(); renderShell(); });
  bindAction('goto-guide', function () { navigate('guide'); });
}

/* ============================================================
 * 八、配套软件管理
 * ============================================================ */

var SW_TABS = [
  { key: 'pc', name: '发票助手 PC 版（免安装客户端）' },
  { key: 'android', name: '发票助手安卓版' },
  { key: 'control', name: '数电票纳税人端打印控件' }
];

var SW_INSTALL = {
  pc: [
    ['从官网下载中心下载发票助手 PC 版安装包/客户端包', '下载完成，文件完整', '下载中断：重新下载并核对文件大小'],
    ['解压（如为压缩包），双击运行客户端；免安装，无需写入系统目录', '客户端界面正常打开', '无法运行：右键「以管理员身份运行」；被杀毒软件拦截：添加信任'],
    ['功能定位：仅支持生成企业信息二维码（基础信息二维码）', '可填写企业信息并生成二维码', '功能不符预期：确认 PC 版定位，如需扫码识别请使用安卓版'],
    ['生成二维码后保存/打印（≥1.8cm×1.8cm，四周留白 ≥4 模块）', '二维码清晰可扫', '扫不出：见异常处理「二维码无效」']
  ],
  android: [
    ['从官网下载中心获取安卓安装包（APK），或通过官方指引的渠道安装', '下载完成', '提示「禁止安装未知来源应用」：在系统设置中允许当前浏览器/文件管理器安装'],
    ['点击安装 → 授予相机（扫码）、存储（保存二维码）权限', '安装成功，桌面出现图标', '解析包错误：重新下载完整 APK，核对系统版本'],
    ['功能使用：支持二维码生成与扫码识别；可通过 USB 与计算机开票系统同步数据', '生成/扫码功能正常，USB 连接电脑后可同步', 'USB 连接无反应：更换数据线/USB 口，开启手机「USB 调试」或文件传输模式，重装电脑端驱动'],
    ['扫码提交的抬头信息同步至销售方开票列表（48 小时内有效）', '电子税务局「立即开票」列表可见待开票信息', '同步失败：确认扫码 APP 为微信/支付宝/个税 APP/电子税务局 APP，检查网络与有效期']
  ],
  control: [
    ['从官网下载中心下载「数电票纳税人端打印控件」安装程序', '下载完成', '确认选择 Win7/Win10/Win11 对应版本与 32/64 位'],
    ['右键安装图标 → 以管理员身份运行', '弹出安装界面', '报错「无法访问/拒绝访问」：确认管理员权限；UAC 弹窗点「是」'],
    ['进入安装界面 → 点击「安装」，按提示完成（安装路径建议默认，避免中文或特殊字符路径）', '进度条正常推进', '卡死/报错：见异常处理「安装失败」'],
    ['等待完成 → 点击「完成」', '安装结束', '—'],
    ['验证安装：桌面图标已生成、任务栏出现「已启动」提示（或浏览器打印插件加载成功）', '图标与运行提示均在', '无图标：检查是否安装到其他路径；无「已启动」提示：重启浏览器或电脑'],
    ['打印测试：在电子税务局下载 OFD/PDF 发票后，选择「打印」测试输出', '打印预览正常，版式不错位', '打印乱码/无响应：确认控件为最新版；确认浏览器未禁用插件；重装控件']
  ]
};

var SW_UNINSTALL_VERIFY = [
  ['进程', '任务管理器中无该软件相关进程'],
  ['服务', 'services.msc 中无该软件相关服务'],
  ['文件', 'Program Files、临时文件夹无残留'],
  ['注册表', '搜索 ITSKHD、Servyou 等关键词无相关项'],
  ['功能', '浏览器打印发票不再调用该控件']
];

function renderSoftware() {
  return ''
    + '<div class="alert alert-warn"><span>⚠️</span><span>官方下载来源（唯一合规渠道）：上海税务网站 → 纳税服务 → 下载中心 → 软件下载 → 发票助手。核对文件名、版本号、发布日期，下载官方数字签名安装包；不使用任何第三方站点、网盘、破解版本。</span></div>'
    + '<div class="card"><div class="card-title">安装前通用检查</div>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>检查项</th><th>通过标准</th><th>未通过处理</th></tr></thead><tbody>'
    + '<tr><td>操作系统版本</td><td>打印控件：Windows 7 / 10 / 11（32/64 位与安装包一致）；PC 版：免安装客户端；安卓版：Android 系统</td><td>系统不兼容：更换电脑或到办税服务厅办理</td></tr>'
    + '<tr><td>管理员权限</td><td>使用管理员账户或右键「以管理员身份运行」</td><td>权限不足：联系本单位 IT 管理员授权</td></tr>'
    + '<tr><td>旧版本残留</td><td>无历史版本/失败安装残留</td><td>先彻底卸载并清理残留后再安装</td></tr>'
    + '<tr><td>安全软件</td><td>安装过程中可暂时关闭第三方安全软件实时防护</td><td>仍失败：见异常处理「安装失败」</td></tr>'
    + '</tbody></table></div></div>'
    + SW_TABS.map(function (tab) {
      return '<div class="card"><div class="card-title">' + escapeHtml(tab.name) + '</div>'
        + '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--ink-2)">安装步骤</div>'
        + stepTable(SW_INSTALL[tab.key])
        + '</div>';
    }).join('')
    + '<div class="card"><div class="card-title">卸载程序</div>'
    + '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--ink-2)">标准卸载</div>'
    + '<ol style="padding-left:20px;font-size:13px;line-height:2;color:var(--ink-2)">'
    + '<li>控制面板 → 程序和功能（Win11：设置 → 应用 → 已安装的应用）</li>'
    + '<li>找到目标软件（如「数电票纳税人端打印控件」「发票助手」）→ 右键/双击 → 卸载</li>'
    + '<li>按向导提示完成卸载；卸载中断/报错：重启电脑后重试，仍失败走深度卸载</li>'
    + '</ol>'
    + '<div style="font-size:13px;font-weight:600;margin:12px 0 8px;color:var(--ink-2)">深度卸载</div>'
    + '<ol style="padding-left:20px;font-size:13px;line-height:2;color:var(--ink-2)">'
    + '<li>打开软件安装目录（默认如 C:\\Program Files\\ 下对应目录），找到 uninstall.exe</li>'
    + '<li>右键 uninstall.exe → 以管理员身份运行，向导执行完毕</li>'
    + '<li>安卓版：手机「设置 → 应用管理」中选择发票助手 → 卸载（设备管理应用需先撤销设备管理器权限）</li>'
    + '</ol>'
    + '<div style="font-size:13px;font-weight:600;margin:12px 0 8px;color:var(--ink-2)">清理残留</div>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>清理对象</th><th>操作动作</th><th>预期结果</th></tr></thead><tbody>'
    + '<tr><td>Program Files 目录</td><td>检查 C:\\Program Files\\ 与 C:\\Program Files (x86)\\ 下是否残留软件目录，确认无用时删除</td><td>无软件相关目录</td></tr>'
    + '<tr><td>临时文件夹</td><td>Win+R 输入 %temp% 清理临时文件</td><td>临时文件清空（占用中文件跳过）</td></tr>'
    + '<tr><td>注册表项</td><td>Win+R 输入 regedit，先导出备份注册表，再搜索关键词 <b>ITSKHD、Servyou</b> 等，删除相关项（仅删除确认属于该软件的项）</td><td>搜索无相关残留项</td></tr>'
    + '</tbody></table></div>'
    + '<div style="font-size:13px;font-weight:600;margin:12px 0 8px;color:var(--ink-2)">安装冲突处理</div>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>处理方式</th><th>操作动作</th><th>适用场景</th></tr></thead><tbody>'
    + '<tr><td>专业卸载工具</td><td>使用 Revo Uninstaller 等专业工具，卸载后扫描并清除残留文件和注册表项</td><td>反复安装失败、标准卸载报错</td></tr>'
    + '<tr><td>更换安装路径</td><td>重新安装时选择不含中文、空格及特殊字符的路径（如 D:\\TaxSoftware）</td><td>原路径含中文导致安装/打印异常</td></tr>'
    + '<tr><td>重新安装官方最新版</td><td>从官网下载中心重新下载最新安装包，按安装前检查后安装</td><td>清理完成后恢复正常使用</td></tr>'
    + '</tbody></table></div>'
    + '<div style="font-size:13px;font-weight:600;margin:12px 0 8px;color:var(--ink-2)">卸载完成验证</div>'
    + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>验证项</th><th>通过标准</th></tr></thead><tbody>'
    + SW_UNINSTALL_VERIFY.map(function (r) { return '<tr><td>' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td></tr>'; }).join('')
    + '</tbody></table></div>'
    + '</div>';
}

function stepTable(rows) {
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>操作动作</th><th>预期结果</th><th>异常处理</th></tr></thead><tbody>'
    + rows.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(r[0]) + '</td><td>' + escapeHtml(r[1]) + '</td><td>' + escapeHtml(r[2]) + '</td></tr>';
    }).join('')
    + '</tbody></table></div>';
}

/* ============================================================
 * 九、异常处理
 * ============================================================ */

var FAULTS = [
  { name: '二维码无效', cause: '1. 二维码模糊、破损、尺寸过小或打印留白不足；2. 二维码过期（基础信息超 48 小时、交易信息超 24 小时）；3. 扫码 APP 不受支持；4. 网络不通', steps: ['核对清晰度与尺寸（≥1.8cm×1.8cm、四周留白 ≥4 模块）', '超时则让购买方重新生成或让销售方重新生成', '确认使用微信、支付宝、个人所得税 APP 或电子税务局 APP 扫码', '检查双方网络后重试'] },
  { name: '用户令牌无效', cause: '电子税务局 APP 版本过旧、登录态失效、账号在别处被顶下线', steps: ['将电子税务局 APP 更新至最新版本', '退出后重新登录', '重启 APP 与手机网络', '仍失败联系主管税务机关或 12366'] },
  { name: '人脸识别失败 / 人脸识别二维码无效', cause: '扫码 APP 用错、光线不佳、网络不稳、实名信息不符', steps: ['确认使用电子税务局 APP 或个人所得税 APP 扫码（不要用浏览器扫）', '光线充足、正对摄像头', '切换网络重试', '多次失败转办税服务厅实名认证'] },
  { name: '安装失败', cause: '权限不足、系统不兼容、安全软件拦截、旧版本残留、安装路径含中文/特殊字符', steps: ['右键「以管理员身份运行」', '使用兼容性模式（右键属性 → 兼容性 → 按需选 Win7 模式）', '暂时关闭安全软件后重试', '彻底清理旧版残留', '更换为英文/数字路径', '重新下载官方最新安装包'] },
  { name: '卸载残留', cause: '标准卸载不完整、安装目录残留、注册表项残留', steps: ['使用安装目录下 uninstall.exe 深度卸载', '清理 Program Files、%temp% 临时文件夹', '备份后清理注册表（ITSKHD、Servyou 等关键词）', '使用 Revo Uninstaller 等专业工具', '按卸载完成验证清单逐项核对'] },
  { name: '开票额度不足', cause: '数电票可用额度低于开票金额、额度未生效、当月额度已用尽', steps: ['「我要办税 → 发票使用 → 发票额度」查看明细', '在电子税务局「发票额度调整」申请调整', '联系主管税务机关核实', '额度恢复后再开具'] },
  { name: '发票信息错误', cause: '购买方信息、明细、税率、金额填错', steps: ['数电票：通过「我要办税 → 发票使用 → 红字发票开具」发起红冲，注明错误原因，待对方确认（如对方已抵扣用途确认需其确认）', '税控电子/纸质发票：当月未抄税可作废，跨月需红冲', '红冲/作废成功后重新开具正确发票并交付'] },
  { name: '其他（开具报错、无法打印、无法交付）', cause: '登录态失效、浏览器兼容性、控件未装、额度/网络问题', steps: ['重新登录或更换浏览器（推荐 Chrome/Edge 最新版）', '确认打印控件已安装并「已启动」', '确认额度与网络', '截图报错信息联系主管税务机关或拨打 12366'] }
];

function renderFault() {
  return ''
    + '<div class="alert alert-info"><span>🔎</span><span>点击异常标题展开处理步骤；步骤按优先级排序，请依次执行。</span></div>'
    + FAULTS.map(function (f, i) {
      return '<div class="card fault-card" data-fault="' + i + '">'
        + '<div class="fault-head" data-act="fault-toggle"><span>⚠️</span><span>' + escapeHtml(f.name) + '</span><span class="arrow">▼</span></div>'
        + '<div class="fault-body"><div class="fault-cause"><b>可能原因：</b>' + escapeHtml(f.cause) + '</div>'
        + '<ol>' + f.steps.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol></div>'
        + '</div>';
    }).join('');
}

function bindFault() {
  bindAction('fault-toggle', function (el) {
    el.closest('.fault-card').classList.toggle('open');
  });
}

/* ============================================================
 * 十、合规与安全
 * ============================================================ */

var COMPLY = [
  '所有操作必须符合国家税务总局和上海市税务局最新政策；政策更新时以官网最新公告为准。',
  '纳税人信息在二维码生成、传输、扫码全流程必须加密，采用国密算法，保障数据传输安全。',
  '二维码仅用于合规便捷开票，不得用于非法开票、不得买卖发票、不得虚开。',
  '发票助手、数电票打印控件等软件必须从官方渠道下载（上海税务网站 → 纳税服务 → 下载中心 → 软件下载 → 发票助手），严禁使用破解、篡改版本。',
  '不得通过任何技术手段绕过实名认证、人脸识别或税务监管。',
  '开票数据（购销双方、明细、税额）必须真实反映交易实际，红冲/作废须如实填写原因。',
  '注册表清理等高风险操作前务必备份；不熟悉时联系本单位 IT 人员或主管税务机关。',
  '平台地址仅限 https://etax.shanghai.chinatax.gov.cn，谨防仿冒钓鱼网站。'
];

function renderComply() {
  return ''
    + '<div class="card"><div class="card-title">合规与安全提示</div>'
    + COMPLY.map(function (c, i) {
      return '<div class="comply-item"><div class="comply-no">' + (i + 1) + '</div><div class="comply-text">' + escapeHtml(c) + '</div></div>';
    }).join('')
    + '</div>'
    + '<div class="card"><div class="card-title">本工具的数据边界</div>'
    + '<div class="alert alert-info"><span>🔒</span><span>payinvoice 开票助手的全部数据（开票信息、二维码记录）仅存储于本机浏览器 localStorage，不上传任何服务器；二维码内容经 SM4 国密算法本地加密。清除浏览器数据或点击「数据管理 → 清空本地数据」即可彻底删除。</span></div>'
    + '<div class="alert alert-warn"><span>📋</span><span>本工具生成的二维码为本地加密载荷，用于内部流转、打印与测试；正式开票二维码以国家税务总局上海市电子税务局官方生成结果为准。</span></div>'
    + '</div>';
}

/* ============================================================
 * 十一、数据管理
 * ============================================================ */

/* 数据管理操作防重复提交：按操作类型分别加锁，互不阻塞 */
var dataBusy = { exporting: false, importing: false };

function renderData() {
  var raw = '';
  try { raw = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
  var bytes = new Blob([raw]).size;
  return ''
    + '<div class="card"><div class="card-title">本地数据概览</div>'
    + '<div class="kv"><span class="k">存储键名</span><span class="v mono">' + STORAGE_KEY + '</span></div>'
    + '<div class="kv"><span class="k">数据大小</span><span class="v">' + (bytes / 1024).toFixed(2) + ' KB（localStorage 上限约 5 MB）</span></div>'
    + '<div class="kv"><span class="k">最后保存</span><span class="v">' + (state.savedAt ? fmtTime(state.savedAt) : '尚未保存') + '</span></div>'
    + '<div class="kv"><span class="k">明细行数</span><span class="v">' + state.items.length + '</span></div>'
    + '<div class="kv"><span class="k">基础信息二维码</span><span class="v">' + (state.qr.basicGenAt ? '已生成（' + fmtTime(state.qr.basicGenAt) + '）' : '未生成') + '</span></div>'
    + '<div class="kv"><span class="k">交易信息二维码</span><span class="v">' + (state.qr.txnGenAt ? '已生成（' + fmtTime(state.qr.txnGenAt) + '）' : '未生成') + '</span></div>'
    + '</div>'
    + '<div class="card"><div class="card-title">导出 / 导入 / 清除</div>'
    + '<div class="btn-row">'
    + '<button class="btn btn-navy" data-act="data-export">⬇️ 导出备份（JSON）</button>'
    + '<button class="btn btn-ghost" data-act="data-import">⬆️ 导入备份</button>'
    + '<button class="btn btn-danger" data-act="data-clear">🗑️ 清空本地数据</button>'
    + '<button class="btn btn-light" data-act="data-demo">📦 载入示例数据</button>'
    + '</div>'
    + '<input type="file" id="importFile" accept=".json,application/json" style="display:none">'
    + '<div class="hint" style="margin-top:10px">导出的 JSON 包含开票信息、明细、二维码时间戳与进度，<b>不含加密口令</b>（口令仅存于当前页面内存）；导入将覆盖当前全部本地数据（文件须 ≤2 MB，内容经结构白名单校验，非法字段自动清理）。</div>'
    + '</div>';
}

function bindData() {
  bindAction('data-export', function () {
    if (dataBusy.exporting) return;            /* 防重复提交 */
    dataBusy.exporting = true;
    try {
      state.savedAt = Date.now();
      /* state 中不含加密口令（口令仅存内存），导出内容天然不含口令 */
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'payinvoice_backup_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('备份已导出（不含加密口令）', 'ok');
    } finally {
      setTimeout(function () { dataBusy.exporting = false; }, 800);
    }
  });
  bindAction('data-import', function () {
    if (dataBusy.importing) return;
    $('#importFile').click();
  });
  bindAction('data-clear', function () {
    if (!confirm('确认清空全部本地数据？此操作不可恢复（建议先导出备份）。')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    toast('本地数据已清空', 'ok');
    renderShell();
  });
  bindAction('data-demo', function () {
    state = demoState();
    saveState();
    renderShell();
    toast('示例数据已载入', 'ok');
  });
  var file = $('#importFile');
  if (file) file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {           /* 备份上限 2MB，防 localStorage 写爆 */
      toast('导入失败：文件超过 2 MB 上限', 'err');
      file.value = '';
      return;
    }
    if (dataBusy.importing) { file.value = ''; return; } /* 防重复提交 */
    dataBusy.importing = true;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(reader.result);
        var clean = sanitizeState(obj);        /* 白名单校验，失败抛错 */
        localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
        state = clean;
        renderShell();
        toast('备份导入成功（已按结构校验清理）', 'ok');
      } catch (e) {
        toast('导入失败：' + e.message, 'err');
      } finally {
        dataBusy.importing = false;
        file.value = '';
      }
    };
    reader.onerror = function () {
      dataBusy.importing = false;
      toast('导入失败：文件读取错误', 'err');
      file.value = '';
    };
    reader.readAsText(f);
  });
}

function demoState() {
  var s = defaultState();
  s.seller = { name: '上海示例信息技术有限公司', taxNo: '91310000MA1FL0XXXX'.replace(/X/g, '0') + 'X', addrTel: '上海市浦东新区示例路 1 号 021-00000000', bankAcc: '招商银行上海分行 121900000000001' };
  s.buyer = { name: '上海示例贸易有限公司', taxNo: '91310115MA1K3XXXX'.replace(/X/g, '0') + 'X', addrTel: '上海市闵行区示例大道 88 号 021-11111111', bankAcc: '工商银行上海分行 100100000000002', email: 'finance@example.com' };
  s.items = [
    { id: genId(), name: '*信息技术服务*软件开发服务', qty: '1', price: '100000.00', amount: '100000.00', taxRate: '6%', tax: '6000.00' },
    { id: genId(), name: '*软件开发*软件维护服务', qty: '12', price: '500.00', amount: '6000.00', taxRate: '6%', tax: '360.00' }
  ];
  s.remark = '示例数据，仅供演示';
  return s;
}

/* ============================================================
 * 十二、通用事件与提示
 * ============================================================ */

function bindAction(act, fn) {
  $$('[data-act="' + act + '"]').forEach(function (el) {
    el.addEventListener('click', function () { fn(el); });
  });
}

function toast(msg, type) {
  var old = $('#toast');
  if (old) old.remove();
  var el = document.createElement('div');
  el.id = 'toast';
  var bg = type === 'err' ? 'var(--red)' : type === 'ok' ? 'var(--green)' : 'var(--navy)';
  el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:' + bg + ';color:#fff;padding:9px 18px;border-radius:8px;font-size:13px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:80vw;text-align:center';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 2400);
  setTimeout(function () { el.remove(); }, 3000);
}

function closeSidebar() {
  $('.sidebar').classList.remove('open');
  $('.scrim').classList.remove('show');
}

/* ============================================================
 * 十三、启动
 * ============================================================ */

function boot() {
  // 侧边栏导航
  var navHtml = '<div class="nav-sec">开票操作</div>';
  ROUTES.slice(0, 3).forEach(function (r) {
    navHtml += '<button class="nav-item" data-path="' + r.path + '"><span class="nav-ico">' + r.ico + '</span>' + r.nav + '</button>';
  });
  navHtml += '<div class="nav-sec">检查与管理</div>';
  ROUTES.slice(3).forEach(function (r) {
    navHtml += '<button class="nav-item" data-path="' + r.path + '"><span class="nav-ico">' + r.ico + '</span>' + r.nav + '</button>';
  });
  $('#nav').innerHTML = navHtml;
  $$('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { navigate(btn.getAttribute('data-path')); });
  });

  $('#menuToggle').addEventListener('click', function () {
    $('.sidebar').classList.toggle('open');
    $('.scrim').classList.toggle('show');
  });
  $('.scrim').addEventListener('click', closeSidebar);

  currentRoute = currentPath();
  if (!location.hash) navigate(currentRoute, true);
  renderShell();
  if (state.savedAt) flashSaved();

  // 税号实时校验样式
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'wb_bTax') {
      var v = e.target.value.trim();
      if (!v) { e.target.classList.remove('valid', 'invalid'); return; }
      var r = validateTaxNo(v);
      e.target.classList.toggle('valid', r.ok);
      e.target.classList.toggle('invalid', !r.ok);
    }
    if (e.target && e.target.id === 'wb_sTax') {
      var v2 = e.target.value.trim();
      if (!v2) { e.target.classList.remove('valid', 'invalid'); return; }
      var r2 = validateTaxNo(v2);
      e.target.classList.toggle('valid', r2.ok);
      e.target.classList.toggle('invalid', !r2.ok);
    }
  });
}

// 视图后置绑定
function afterRenderDispatch() {
  if (currentRoute === 'workbench') bindWorkbench();
  else if (currentRoute === 'qr') bindQR();
  else if (currentRoute === 'guide') bindGuide();
  else if (currentRoute === 'prereq') bindPrereq();
  else if (currentRoute === 'fault') bindFault();
  else if (currentRoute === 'data') bindData();
}

// 包装 renderShell 以支持 afterRender
var _origRenderShell = renderShell;
renderShell = function () {
  _origRenderShell();
  afterRenderDispatch();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
