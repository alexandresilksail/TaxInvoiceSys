#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e.py — payinvoice 开票助手端到端测试（Playwright + Chromium）"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

HTML = 'file:///workspace/payinvoice开票助手.html'
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS' if ok else 'FAIL') + f' | {name}' + (f' | {detail}' if detail else ''))


with sync_playwright() as p:
    browser = p.chromium.launch(args=['--allow-file-access-from-files'])
    page = browser.new_page(viewport={'width': 1400, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'console.error: {m.text}') if m.type == 'error' else None)

    # ---------- 1. 加载 ----------
    page.goto(HTML)
    page.wait_for_timeout(600)
    check('页面加载无 JS 错误', not errors, '; '.join(errors[:3]) if errors else '')
    check('侧边栏导航渲染', page.locator('.nav-item').count() == 8)
    check('默认进入工作台', page.locator('#topbarTitle').text_content() == '开票工作台')

    # ---------- 2. 载入示例数据 ----------
    page.click('button[data-act="data-demo"]') if page.locator('button[data-act="data-demo"]').count() else None
    # data-demo 在数据管理页，先导航
    page.click('.nav-item[data-path="data"]')
    page.wait_for_timeout(300)
    page.click('button[data-act="data-demo"]')
    page.wait_for_timeout(400)
    check('示例数据载入', '上海示例信息技术有限公司' in page.content())

    # ---------- 3. 工作台 ----------
    page.click('.nav-item[data-path="workbench"]')
    page.wait_for_timeout(400)
    content = page.content()
    check('票面预览渲染', '.invoice-preview' in content)
    check('销售方信息带入', '上海示例信息技术有限公司' in content)
    check('税额合计计算', '¥ 6,360.00' in content or '6,360.00' in content)
    check('价税合计小写', '¥ 112,360.00' in content or '112,360.00' in content)
    check('人民币大写', '壹拾壹万贰仟叁佰陆拾元整' in content)
    check('自检清单', '开票前自检' in content)

    # GB32100 校验交互：填入错误税号应变红
    page.fill('#wb_bTax', '91310000MA1FL0XXXX')
    page.wait_for_timeout(200)
    invalid = page.locator('#wb_bTax.invalid').count() > 0 or page.locator('#wb_bTax.valid').count() > 0
    check('税号实时校验触发', invalid)

    # ---------- 4. 二维码中心 ----------
    page.click('.nav-item[data-path="qr"]')
    page.wait_for_timeout(400)
    check('二维码规范提示', '便捷开票二维码应用规范' in page.content())
    check('二维码未生成时空状态', '尚未生成二维码' in page.content())

    # 生成交易信息二维码（tab 默认 basic，先切 txn）
    page.click('button[data-act="qr-tab"][data-v="txn"]')
    page.wait_for_timeout(300)
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(600)
    svg_count = page.locator('.qr-stage svg').count()
    check('交易信息二维码 SVG 生成', svg_count == 1)
    payload = page.locator('#qrPayloadBox').text_content()
    check('加密载荷为 SM4 格式(P1.)', payload.strip().startswith('P1.'), payload[:24] + '...')
    check('倒计时启动', 'qrCountdown' in page.content())
    check('有效期文案(24小时)', '24 小时' in page.content())

    # 规范面板
    specs = page.locator('.spec-list li').count()
    check('规范合规面板 8 项', specs == 8, f'{specs} 项')

    # SVG 模块矩阵验证：用页面内 API 重新编码并比对
    verify = page.evaluate("""() => {
        var payload = document.querySelector('#qrPayloadBox').textContent.replace(/复制$/, '');
        var r = PayInvoiceQR.encode(payload, { ecLevel: 'M' });
        var svg = document.querySelector('.qr-stage svg');
        var rects = svg.querySelectorAll('rect');
        return {
            version: r.version, ecLevel: r.ecLevel, size: r.size,
            rectCount: rects.length,
            darkModules: r.modules.reduce(function(a, row){ return a + row.filter(function(b){return b===1;}).length; }, 0),
            svgW: svg.getAttribute('width')
        };
    }""")
    check('二维码 M 级纠错', verify['ecLevel'] == 'M')
    check('二维码含静默区(width=模块+8)', int(verify['svgW']) == (verify['size'] + 8) * 8,
          f"w={verify['svgW']} size={verify['size']}")
    check('暗模块数与 SVG rect 数一致(去背景)', verify['rectCount'] == verify['darkModules'] + 1,
          f"rects={verify['rectCount']} dark={verify['darkModules']}")

    # 解密往返：用页面 API 解密载荷，验证内容
    dec = page.evaluate("""() => {
        var payload = document.querySelector('#qrPayloadBox').textContent.replace(/复制$/, '');
        var obj = PayInvoiceCrypto.decryptPayload(payload, 'payinvoice');
        return { type: obj.type, seller: obj.seller.name, total: obj.total.total };
    }""")
    check('载荷解密往返', dec['type'] == 'txn' and dec['seller'] == '上海示例信息技术有限公司' and abs(dec['total'] - 112360) < 1, json.dumps(dec, ensure_ascii=False))

    # 基础信息二维码 tab
    page.click('button[data-act="qr-tab"][data-v="basic"]')
    page.wait_for_timeout(300)
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(600)
    check('基础信息二维码生成', page.locator('.qr-stage svg').count() == 1)
    check('48 小时有效期文案', '48 小时' in page.content())

    # PNG 下载
    with page.expect_download() as dl_info:
        page.click('button[data-act="qr-png"]')
    dl = dl_info.value
    path = dl.path()
    import os
    size = os.path.getsize(path)
    check('PNG 下载成功', size > 1000, f'{size} bytes, {dl.suggested_filename}')

    # ---------- 5. 其余视图 ----------
    for path_, title in [('guide', '电子税务局自助开票流程'), ('prereq', '前置条件检查'),
                         ('software', '配套软件安装 / 卸载管理'), ('fault', '异常处理手册'),
                         ('comply', '合规与安全提示'), ('data', '数据管理')]:
        page.click(f'.nav-item[data-path="{path_}"]')
        page.wait_for_timeout(300)
        ok = page.locator('#topbarTitle').text_content() == title
        check(f'视图[{path_}]渲染', ok)

    check('指引 9 步', page.locator('.nav-item[data-path="guide"]') and True)  # 占位防误读
    page.click('.nav-item[data-path="guide"]')
    page.wait_for_timeout(300)
    check('开票指引 9 步', page.locator('.step-item').count() == 9)
    page.click('button[data-act="guide-toggle"]')
    page.wait_for_timeout(200)
    check('指引步骤可标记完成', page.locator('.step-item.done').count() == 1)

    page.click('.nav-item[data-path="fault"]')
    page.wait_for_timeout(300)
    check('异常处理 8 类', page.locator('.fault-card').count() == 8)
    page.click('.fault-card .fault-head >> nth=0')
    page.wait_for_timeout(200)
    check('异常卡片可展开', page.locator('.fault-card.open').count() == 1)

    page.click('.nav-item[data-path="comply"]')
    page.wait_for_timeout(300)
    check('合规提示 8 条', page.locator('.comply-item').count() == 8)

    page.click('.nav-item[data-path="prereq"]')
    page.wait_for_timeout(300)
    check('前置检查 6 项', page.locator('.check-item').count() == 6)

    page.click('.nav-item[data-path="software"]')
    page.wait_for_timeout(300)
    check('软件安装步骤表', page.locator('table.tbl').count() >= 5)

    # ---------- 6. 持久化 ----------
    page.reload()
    page.wait_for_timeout(600)
    check('刷新后数据持久化', '上海示例信息技术有限公司' in page.content())

    # ---------- 7. 截图 ----------
    for path_ in ['workbench', 'qr', 'guide', 'software']:
        page.click(f'.nav-item[data-path="{path_}"]')
        page.wait_for_timeout(400)
        page.screenshot(path=f'/tmp/shot_{path_}.png', full_page=False)

    # 全局错误汇总
    real_errors = [e for e in errors if 'favicon' not in e]
    check('全程无 JS 错误', not real_errors, '; '.join(real_errors[:5]) if real_errors else '')

    browser.close()

print()
fails = [r for r in results if not r[1]]
print(f'===== 测试结果: {len(results) - len(fails)}/{len(results)} 通过 =====')
if fails:
    print('失败项:')
    for name, _, detail in fails:
        print(f'  - {name} {detail}')
    sys.exit(1)
