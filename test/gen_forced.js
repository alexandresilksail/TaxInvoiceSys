/* 调试：对每个失败用例，遍历 8 个掩码，判断是否存在与 Python 一致的矩阵 */
require('/workspace/src/qr_tables.js');
require('/workspace/src/qrcode.js');
const QR = globalThis.PayInvoiceQR;
const fs = require('fs');

const cases = [
  ['numeric', '12345678901234567890'],
  ['alnum', 'HELLO WORLD 123 ABC'],
  ['byte', 'PAYINVOICE 开票助手 SM4 TEST'],
];
const js = JSON.parse(fs.readFileSync('/workspace/test/js_matrices.json', 'utf8'));
fs.writeFileSync('/workspace/test/js_matrices_allmasks.json', JSON.stringify(
  Object.fromEntries(Object.entries(js).filter(([k, v]) => !v.error).map(([k, v]) => [k, v.modules]))
));

// 生成 8 掩码矩阵
const allMaskOut = {};
for (const ec of ['L', 'M', 'Q', 'H']) {
  for (let v = 1; v <= 40; v++) {
    for (const [name, text] of cases) {
      const key = `${ec}-${v}-${name}`;
      if (js[key] && js[key].error) continue;
      const masks = [];
      for (let m = 0; m < 8; m++) {
        try {
          const r = QR.encode(text, { ecLevel: ec, minVersion: v, maxVersion: v, mask: m });
          masks.push(r.modules);
        } catch (e) { masks.push(null); }
      }
      allMaskOut[key] = masks;
    }
  }
}
fs.writeFileSync('/workspace/test/js_matrices_forced.json', JSON.stringify(allMaskOut));
console.log('forced-mask cases:', Object.keys(allMaskOut).length);
