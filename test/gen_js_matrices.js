/* 测试：输出全部版本×纠错等级的矩阵，与 Python qrcode 参考实现比对 */
require('/workspace/src/qr_tables.js');
require('/workspace/src/qrcode.js');
const QR = globalThis.PayInvoiceQR;

const fs = require('fs');
const out = {};

const cases = [
  { name: 'numeric', text: '12345678901234567890', forceVersion: null },
  { name: 'alnum', text: 'HELLO WORLD 123 ABC', forceVersion: null },
  { name: 'byte', text: 'PAYINVOICE 开票助手 SM4 TEST', forceVersion: null },
];

for (const ec of ['L', 'M', 'Q', 'H']) {
  for (let v = 1; v <= 40; v++) {
    for (const c of cases) {
      // 选取该版本容量内的文本长度
      let text = c.text;
      try {
        const r = QR.encode(text, { ecLevel: ec, minVersion: v, maxVersion: v });
        out[`${ec}-${v}-${c.name}`] = {
          modules: r.modules,
          mask: r.mask,
          version: r.version
        };
      } catch (e) {
        out[`${ec}-${v}-${c.name}`] = { error: e.message };
      }
    }
  }
}

fs.writeFileSync('/workspace/test/js_matrices.json', JSON.stringify(out));
console.log('cases:', Object.keys(out).length);

// GF 与 RS 单点自检
const t = QR._internal;
console.log('gfMul(0x80,0x80)=', t.gfMul(0x80, 0x80).toString(16), '(应为c1? 验证:0x80*0x80 in GF(2^8) with 0x11D = 0x1d? 打印即可)');
const gen2 = t.rsGenPoly(7);
console.log('gen(7):', gen2.map(x => x.toString(16)).join(','));
console.log('cap v1-M:', t.dataCodewordCapacity(1, 1), 'v10-M:', t.dataCodewordCapacity(10, 1), 'v40-H:', t.dataCodewordCapacity(40, 3));
