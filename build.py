#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — 将 payinvoice 开票助手组装为单文件离线 HTML
输出：/workspace/payinvoice开票助手.html
"""
import os
import datetime

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
OUT = '/workspace/payinvoice开票助手.html'

def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return f.read()

css = read('style.css')
qr_tables = read('qr_tables.js')
qrcode = read('qrcode.js')
crypto = read('crypto.js')
app = read('app.js')

# JS 内嵌进 <script> 时需避免出现 "</script>" 字样
for name, js in [('qr_tables.js', qr_tables), ('qrcode.js', qrcode), ('crypto.js', crypto), ('app.js', app)]:
    if '</script>' in js.lower():
        raise SystemExit(f'{name} 含有 </script>，需先转义')

html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="payinvoice 开票助手 — 国家税务总局上海市电子税务局增值税发票开具与配套软件管理工具：开票信息管理与票面预览、便捷开票二维码（国密加密）、自助开票指引、软件安装卸载管理、异常处理。">
<title>payinvoice 开票助手 — 上海电子税务局发票开具与配套软件管理</title>
<style>
__CSS__
</style>
</head>
<body>
<div class="scrim" id="scrim"></div>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-logo"><span class="brand-mark">票</span>payinvoice 开票助手</div>
      <div class="brand-sub">上海电子税务局 · 数电票开具工具集</div>
    </div>
    <nav class="nav" id="nav"></nav>
    <div class="sidebar-foot">
      数据仅存储于本机浏览器<br>二维码经 SM4 国密算法加密<br>v1.0 · 离线单文件版
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <button class="menu-toggle" id="menuToggle" title="菜单">☰</button>
        <span class="topbar-title" id="topbarTitle">开票工作台</span>
      </div>
      <div class="topbar-right">
        <span class="badge badge-gray" id="saveFlag">本地存储</span>
        <a class="btn btn-sm btn-primary" href="https://etax.shanghai.chinatax.gov.cn" target="_blank" rel="noopener" style="text-decoration:none">🌐 电子税务局</a>
      </div>
    </header>
    <main class="content" id="content"></main>
    <footer class="foot">
      payinvoice 开票助手 · 依据《便捷开票二维码应用规范》与上海市电子税务局开票流程编制 ·
      正式开票请以电子税务局官网为准 · 官方平台：etax.shanghai.chinatax.gov.cn · 咨询：12366
    </footer>
  </div>
</div>

<script>
__QR_TABLES__
</script>
<script>
__QRCODE__
</script>
<script>
__CRYPTO__
</script>
<script>
__APP__
</script>
</body>
</html>
'''

html = (html
        .replace('__CSS__', css)
        .replace('__QR_TABLES__', qr_tables)
        .replace('__QRCODE__', qrcode)
        .replace('__CRYPTO__', crypto)
        .replace('__APP__', app))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(html)

size = os.path.getsize(OUT)
print(f'构建完成: {OUT}')
print(f'文件大小: {size/1024:.1f} KB ({size:,} bytes)')
print(f'构建时间: {datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
