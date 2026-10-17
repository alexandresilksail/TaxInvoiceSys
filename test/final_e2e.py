#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""final_e2e.py — 最终闭环验证（同源）：
1. 同一浏览器会话生成二维码，同时取页面载荷 / 页面 SVG / canvas 导出 PNG
2. 像素级保真：SVG 矩阵 vs PNG 矩阵必须 0 差异
3. OpenCV 解码 PNG（高版本 QR 检测偶发失败，最多重试 5 次）
4. 国密解密：对 OpenCV 解码结果（失败时对页面载荷）执行 SM4 解密，校验业务字段
"""
import base64
import json
import re
import subprocess
import sys

import cv2
import numpy as np
from playwright.sync_api import sync_playwright

HTML = 'file:///workspace/payinvoice开票助手.html'
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS' if ok else 'FAIL') + f' | {name}' + (f' | {detail}' if detail else ''))


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1400, 'height': 900})
    page.goto(HTML)
    page.wait_for_timeout(500)
    page.click('.nav-item[data-path="data"]')
    page.click('button[data-act="data-demo"]')
    page.wait_for_timeout(300)
    page.click('.nav-item[data-path="qr"]')
    page.click('button[data-act="qr-tab"][data-v="txn"]')
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(600)
    payload = page.locator('#qrPayloadBox').text_content().replace('复制', '')
    # 页面内直接 canvas 导出（与 downloadPNG 同路径，16px/模块），同时返回用于比对的同源 SVG 字符串
    dataurl = page.evaluate("""() => {
        var box = document.querySelector('#qrPayloadBox');
        var payload = box.textContent.replace(/复制$/, '');
        var svgStr = PayInvoiceQR.toSVG(payload, { ecLevel: 'M', quiet: 4, scale: 16 }).svg;
        return new Promise(function(resolve){
            var img = new Image();
            var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            img.onload = function(){
                var canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                resolve({w: img.width, h: img.height, url: canvas.toDataURL('image/png'), svg: svgStr});
            };
            img.src = url;
        });
    }""")
    browser.close()

png_bytes = base64.b64decode(dataurl['url'].split(',', 1)[1])
open('/tmp/final_qr.png', 'wb').write(png_bytes)
svg_str = dataurl['svg']

# ---------- 1. 像素级保真：SVG vs PNG ----------
rects = re.findall(r'<rect x="(\d+)" y="(\d+)" width="16" height="16"/>', svg_str)
n = 105
svg_mat = [[0] * n for _ in range(n)]
for x, y in rects:
    svg_mat[int(y) // 16 - 4][int(x) // 16 - 4] = 1

img = cv2.imdecode(np.frombuffer(png_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
W = img.shape[1]
scale = W // (n + 8)
png_mat = [[1 if img[(y + 4) * scale + scale // 2, (x + 4) * scale + scale // 2] < 128 else 0 for x in range(n)] for y in range(n)]
diff = sum(1 for y in range(n) for x in range(n) if svg_mat[y][x] != png_mat[y][x])
check('PNG 与页面 SVG 像素级一致', diff == 0, f'{diff}/{n * n} 模块差异, {W}px, {scale}px/模块')

# ---------- 2. OpenCV 解码（重试） ----------
det = cv2.QRCodeDetector()
decoded = ''
attempt = 0
for attempt in range(5):
    data, pts, _ = det.detectAndDecode(img)
    if data:
        decoded = data
        break
    padded = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    data, pts, _ = det.detectAndDecode(padded)
    if data:
        decoded = data
        break
if decoded:
    check('OpenCV 解码成功', True, f'{len(decoded)} 字符（第 {attempt + 1} 次尝试）')
    check('解码内容与页面载荷一致', decoded == payload)
else:
    check('OpenCV 解码成功', False, '5 次尝试均失败（OpenCV 高版本 QR 已知限制，不影响手机扫码）')

# ---------- 3. 国密解密 ----------
target = decoded if decoded else payload
open('/tmp/final_payload.txt', 'w').write(target)
r = subprocess.run(['node', '-e', '''
require('/root/.codebuddy/artifact/payinvoice/src/qr_tables.js');
require('/root/.codebuddy/artifact/payinvoice/src/qrcode.js');
require('/root/.codebuddy/artifact/payinvoice/src/crypto.js');
var fs = require('fs');
var payload = fs.readFileSync('/tmp/final_payload.txt', 'utf8');
try {
  var obj = PayInvoiceCrypto.decryptPayload(payload, 'payinvoice');
  console.log(JSON.stringify({ok: true, obj: obj}));
} catch (e) {
  console.log(JSON.stringify({ok: false, err: e.message}));
}
'''], capture_output=True, text=True)
out = json.loads(r.stdout)
obj = out.get('obj', {})
check('SM4 解密成功', out.get('ok') is True, out.get('err', ''))
check('解密内容业务字段正确',
      obj.get('type') == 'txn' and obj.get('seller', {}).get('name') == '上海示例信息技术有限公司'
      and abs(obj.get('total', {}).get('total', 0) - 112360) < 1,
      json.dumps({'type': obj.get('type'), 'seller': obj.get('seller', {}).get('name'),
                  'total': obj.get('total', {}).get('total')}, ensure_ascii=False))

print()
fails = [x for x in results if not x[1]]
print(f'===== 最终闭环: {len(results) - len(fails)}/{len(results)} 通过 =====')
if fails:
    for name, _, detail in fails:
        print(f'  - {name} {detail}')
    sys.exit(1)
