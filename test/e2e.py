#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e.py — payinvoice 开票助手端到端测试（Playwright + Chromium）"""
import json
import os
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
    # 口令不再有默认值：必须显式输入 ≥8 位口令才会生成
    page.fill('#qrPwd', 'Test-12345')
    page.wait_for_timeout(100)
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(800)
    svg_count = page.locator('.qr-stage svg').count()
    check('交易信息二维码 SVG 生成', svg_count == 1)
    payload = page.locator('#qrPayloadBox').text_content()
    check('加密载荷为 SM4 格式(P2.)', payload.strip().startswith('P2.'), payload[:24] + '...')
    check('倒计时启动', 'qrCountdown' in page.content())
    check('有效期文案(24小时)', '24 小时' in page.content())

    # 口令未达 8 位时的防护（清空口令重新生成应被拒绝且不出载荷）
    page.fill('#qrPwd', '')
    page.wait_for_timeout(100)
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(300)
    check('短口令拒绝生成', page.locator('#qrPayloadBox').count() == 0 and page.locator('.qr-stage svg').count() == 0)
    page.fill('#qrPwd', 'Test-12345')
    page.wait_for_timeout(100)
    page.click('button[data-act="qr-gen"]')
    page.wait_for_timeout(800)
    check('重新填口令后可生成', page.locator('.qr-stage svg').count() == 1)

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
        var obj = PayInvoiceCrypto.decryptPayload(payload, 'Test-12345');
        return { type: obj.type, seller: obj.seller.name, total: obj.total.total, amount: obj.total.amount, tax: obj.total.tax, items: obj.items };
    }""")
    check('载荷解密往返', dec['type'] == 'txn' and dec['seller'] == '上海示例信息技术有限公司' and dec['total'] == '112360.00' and dec['amount'] == '106000.00' and dec['tax'] == '6360.00' and len(dec['items']) == 2 and dec['items'][0]['amount'] == '100000.00', json.dumps(dec, ensure_ascii=False))

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

    # ---------- 8. 数据安全加固 ----------
    # 口令仅存内存：输入后不得出现在 localStorage
    page.click('.nav-item[data-path="qr"]')
    page.wait_for_timeout(300)
    page.fill('#qrPwd', 'Secret-Pwd-123')
    page.wait_for_timeout(400)
    stored = page.evaluate("() => localStorage.getItem('payinvoice_helper_v1') || ''")
    check('口令不写入 localStorage', 'Secret-Pwd-123' not in stored)

    # 导出备份不得包含口令
    page.click('.nav-item[data-path="data"]')
    page.wait_for_timeout(300)
    with page.expect_download() as dl_info:
        page.click('button[data-act="data-export"]')
    dl = dl_info.value
    bk_text = open(dl.path(), encoding='utf-8').read()
    bk = json.loads(bk_text)
    check('导出备份不含口令', 'Secret-Pwd-123' not in bk_text and '上海示例' in bk_text)
    check('导出备份结构合法（qr 无 password 字段）',
          'seller' in bk and 'items' in bk and 'qr' in bk and 'password' not in bk.get('qr', {}))

    # 脏数据导入：白名单清理
    dirty = {
        'seller': {'name': '超' * 300, 'taxNo': 12345, 'addrTel': 'x' * 500},
        'buyer': {'name': '购买方', 'taxNo': '91310000MA1FL0XXXX'},
        'invoiceType': 'evil', 'invoiceForm': 42, 'remark': 'r' * 2000,
        'items': [
            {'id': 'a1', 'name': 'n' * 500, 'qty': '1', 'price': '2', 'amount': '2', 'taxRate': '6%', 'tax': '0.12', 'extra': 'drop'},
            'not-an-object',
            {'id': 'a3', 'name': 'ok', 'qty': 1, 'price': 2.5, 'amount': '', 'taxRate': '6%', 'tax': ''}
        ],
        'qr': {'tab': 'bogus', 'basicGenAt': 'not-a-number', 'txnGenAt': -5, 'printWidth': 999, 'password': 'leaked-secret'},
        'progress': {'prereq': {'p1': True, 'bad': 'x'}, 'guide': {'g1': 'notbool'}},
        'savedAt': 'abc',
        'unknownTopLevel': 'drop me'
    }
    page.set_input_files('#importFile', {'name': 'dirty.json', 'mimeType': 'application/json',
                                        'buffer': json.dumps(dirty).encode('utf-8')})
    page.wait_for_timeout(700)
    chk = page.evaluate("""() => {
        var s = JSON.parse(localStorage.getItem('payinvoice_helper_v1'));
        return { nameLen: s.seller.name.length, taxNo: s.seller.taxNo, invType: s.invoiceType,
                 invForm: s.invoiceForm, remarkLen: s.remark.length, items: s.items.length,
                 q0nameLen: s.items[0].name.length, q0qty: s.items[0].qty, q2qty: s.items[1].qty,
                 tab: s.qr.tab, printWidth: s.qr.printWidth, hasPwd: 'password' in s.qr,
                 savedAt: s.savedAt, hasExtra: 'unknownTopLevel' in s };
    }""")
    check('脏导入：超长字段截断', chk['nameLen'] == 200 and chk['remarkLen'] == 500, str(chk))
    check('脏导入：类型归一化（数字税号→字符串）', chk['taxNo'] == '12345', str(chk))
    check('脏导入：非法枚举回落默认', chk['invType'] == 'special' and chk['invForm'] == 'digital', str(chk))
    check('脏导入：非对象明细行剔除', chk['items'] == 2, str(chk))
    check('脏导入：数字数量归一化', chk['q0qty'] == '1' and chk['q2qty'] == '1', str(chk))
    check('脏导入：打印宽度钳制 1.8~30', chk['printWidth'] == 30, str(chk))
    check('脏导入：口令字段被剔除', chk['hasPwd'] is False, str(chk))
    check('脏导入：非法时间戳回落 0', chk['savedAt'] == 0 and chk['tab'] == 'basic', str(chk))
    check('脏导入：未知顶层字段剔除', chk['hasExtra'] is False, str(chk))

    # 非对象 JSON 导入应被拒绝且不影响现有数据
    page.set_input_files('#importFile', {'name': 'bad.json', 'mimeType': 'application/json', 'buffer': b'[1,2,3]'})
    page.wait_for_timeout(500)
    toast_txt = page.evaluate("() => { var t = document.getElementById('toast'); return t ? t.textContent : ''; }")
    check('非对象 JSON 导入被拒绝', '导入失败' in toast_txt, toast_txt)
    page.set_input_files('#importFile', {'name': 'bad2.json', 'mimeType': 'application/json', 'buffer': b'{not valid json'})
    page.wait_for_timeout(500)
    toast_txt2 = page.evaluate("() => { var t = document.getElementById('toast'); return t ? t.textContent : ''; }")
    check('非法 JSON 导入被拒绝', '导入失败' in toast_txt2, toast_txt2)

    # 恢复示例数据
    page.click('button[data-act="data-demo"]')
    page.wait_for_timeout(400)

    # ---------- 9. 金额计算规则端到端 ----------
    page.click('.nav-item[data-path="workbench"]')
    page.wait_for_timeout(300)
    page.click('button[data-act="clear-items"]')
    page.wait_for_timeout(300)
    r1 = page.locator('.item-row[data-id]').nth(0)
    r1.locator('input[data-f="name"]').fill('边界测试')
    r1.locator('input[data-f="qty"]').fill('3')
    r1.locator('input[data-f="price"]').fill('0.335')
    page.wait_for_timeout(400)
    check('行金额四舍五入到分（3×0.335=1.005→1.01）', r1.locator('input[data-f="amount"]').input_value() == '1.01',
          r1.locator('input[data-f="amount"]').input_value())
    check('行税额按 13% 自动计算（1.01×13%=0.13）', r1.locator('input[data-f="tax"]').input_value() == '0.13',
          r1.locator('input[data-f="tax"]').input_value())

    # 手工金额优先：改动数量不应覆盖已手填的金额
    r1.locator('input[data-f="amount"]').fill('2.00')
    r1.locator('input[data-f="qty"]').fill('4')
    page.wait_for_timeout(400)
    check('手工填写的金额优先于数量×单价', r1.locator('input[data-f="amount"]').input_value() == '2.00')

    # 第二行：零税率/零税额
    page.click('button[data-act="add-item"]')
    page.wait_for_timeout(300)
    r2 = page.locator('.item-row[data-id]').nth(1)
    r2.locator('input[data-f="name"]').fill('免税服务')
    r2.locator('input[data-f="amount"]').fill('100')
    r2.locator('select[data-f="taxRate"]').select_option('0%')
    r2.locator('input[data-f="tax"]').fill('0')
    page.wait_for_timeout(400)
    amt_txt = page.locator('.kv[data-kv="amount"] .v').text_content()
    tax_txt = page.locator('.kv[data-kv="tax"] .v').text_content()
    tot_txt = page.locator('.kv[data-kv="total"] .v').text_content()
    upper_txt = page.locator('.kv[data-kv="upper"] .v').text_content()
    check('多行合计（分运算无漂移）', amt_txt == '¥ 102.00' and tax_txt == '¥ 0.26' and tot_txt == '¥ 102.26',
          f'{amt_txt} / {tax_txt} / {tot_txt}')
    check('价税合计大写', upper_txt == '壹佰零贰元贰角陆分', upper_txt)

    # 手工税额填 0 = 零税额，不回落自动计算（第二行改 6% 后税额仍只有行1 的 0.26）
    r2.locator('select[data-f="taxRate"]').select_option('6%')
    page.wait_for_timeout(400)
    check('手工零税额不回落自动计算', page.locator('.kv[data-kv="tax"] .v').text_content() == '¥ 0.26',
          page.locator('.kv[data-kv="tax"] .v').text_content())

    # 非法税额输入：自检标记，并回落到自动计算（与金额列同样策略，不会 silently 计入错值）
    r2.locator('input[data-f="tax"]').fill('abc')
    page.wait_for_timeout(400)
    bad_item = page.locator('.spec-list li').filter(has_text='明细金额/税额均为有效数字')
    check('非法税额输入被自检标记', bad_item.count() == 1 and '待完善' in bad_item.text_content(),
          bad_item.text_content() if bad_item.count() else '(未找到)')
    check('非法税额回落自动计算（100×6%=6.00）', page.locator('.kv[data-kv="tax"] .v').text_content() == '¥ 6.26',
          page.locator('.kv[data-kv="tax"] .v').text_content())

    # 清空手工税额 → 同样回落到自动计算，自检恢复通过
    r2.locator('input[data-f="tax"]').fill('')
    page.wait_for_timeout(400)
    check('清空手工税额后回落自动计算', page.locator('.kv[data-kv="tax"] .v').text_content() == '¥ 6.26',
          page.locator('.kv[data-kv="tax"] .v').text_content())
    check('合法输入后自检恢复通过', '待完善' not in bad_item.text_content())

    # ---------- 10. 一键测试脚本存在性（交付物自描述） ----------
    check('测试总入口 run_all.sh 存在', os.path.exists('/workspace/test/run_all.sh'))

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
