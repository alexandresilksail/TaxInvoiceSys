/* 端到端验证：渲染 PNG 并用 OpenCV 解码 */
const zlib = require('zlib');
const fs = require('fs');

require('/workspace/src/qr_tables.js');
require('/workspace/src/qrcode.js');
const QR = globalThis.PayInvoiceQR;

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function writePNG(path, modules, scale, quiet) {
  const n = modules.length;
  const total = (n + quiet * 2) * scale;
  const raw = Buffer.alloc((total * 4 + 1) * total); // RGBA
  let p = 0;
  for (let y = 0; y < total; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < total; x++) {
      const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
      const dark = (mx >= 0 && my >= 0 && mx < n && my < n && modules[my][mx] === 1);
      const v = dark ? 0 : 255;
      raw[p++] = v; raw[p++] = v; raw[p++] = v; raw[p++] = 255;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(total, 0); ihdr.writeUInt32BE(total, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path, png);
}

const texts = [
  '12345678901234567890',
  'HELLO WORLD 123 ABC',
  'PAYINVOICE 开票助手 SM4 国密加密测试 payload',
  JSON.stringify({ type: 'base', v: 1, buyer: { name: '上海示例贸易有限公司', taxNo: '91310000123456789X' }, ts: 1729000000 }),
  'A'.repeat(800),
];
const levels = ['L', 'M', 'Q', 'H'];
const out = [];
for (let i = 0; i < texts.length; i++) {
  for (const ec of levels) {
    try {
      const r = QR.encode(texts[i], { ecLevel: ec });
      const path = `/workspace/test/e2e_${i}_${ec}.png`;
      writePNG(path, r.modules, 4, 4);
      out.push({ file: path, text: texts[i], ec, version: r.version });
    } catch (e) {
      out.push({ file: null, text: texts[i], ec, error: e.message });
    }
  }
}
fs.writeFileSync('/workspace/test/e2e_manifest.json', JSON.stringify(out));
console.log('rendered:', out.filter(o => o.file).length, '/', out.length);
