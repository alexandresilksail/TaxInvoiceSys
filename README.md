# payinvoice 开票助手（TaxInvoiceSys）

> 依据《上海电子税务局发票开具与配套软件管理操作方案》生成的**单文件离线**开票辅助工具。
> 官方平台：国家税务总局上海市电子税务局 https://etax.shanghai.chinatax.gov.cn

## 交付物

**[payinvoice开票助手.html](payinvoice开票助手.html)**（124 KB）——双击即可在 Chrome / Edge 等现代浏览器运行，零依赖、无需联网、`file://` 协议直接可用。

### 功能模块（对应方案七章）

| 模块 | 对应章节 | 功能 |
|---|---|---|
| 开票工作台 | 一、三 | 购销双方信息 + 交易明细编辑，税额/价税合计、人民币大写、数电票票面预览、开票前自检；GB 32100 税号校验位验证 |
| 便捷开票二维码中心 | 二 | 基础信息二维码（48h）/ 交易信息二维码（24h），SM4 国密加密载荷，规范合规面板，PNG 下载/打印 |
| 自助开票指引 | 三 | 9 步开票流程（含预期结果与异常处理），可勾选进度 |
| 前置条件检查 | 一 | 6 项检查清单 + 纳税人类型分支 |
| 配套软件管理 | 四、五 | 发票助手 PC 版/安卓版/打印控件安装、卸载、残留清理、冲突处理 |
| 异常处理 | 六 | 8 类异常现象与解决方案 |
| 合规与安全 | 七 | 8 条合规提示 + 数据边界说明 |
| 数据管理 | — | localStorage 导入导出/清空/示例数据 |

## 仓库结构

```
├── payinvoice开票助手.html      # 交付物：单文件离线应用（build.py 产出）
├── payinvoice开票助手-使用说明.md # 使用说明
├── build.py                    # 组装脚本：src/* → 单文件 HTML
├── src/                        # 源码（全部纯 JS，无外部依赖）
│   ├── qr_tables.js            #   QR 标准表（RS 分块表、校正图形定位表）
│   ├── qrcode.js               #   QR 编码器（ISO/IEC 18004，v1-40，L/M/Q/H）
│   ├── sm4_tables.json         #   SM4 标准表（源自 gmssl）
│   ├── crypto.js               #   国密加密（SM4-CBC + SHA-256/HMAC）
│   ├── style.css               #   样式
│   └── app.js                  #   应用主逻辑
├── test/                       # 验证脚本
│   ├── e2e.py                  #   Playwright 端到端测试（41 项）
│   ├── final_e2e.py            #   最终闭环：生成→PNG→解码→解密
│   ├── compare_python.py       #   与 Python qrcode 库矩阵级比对
│   ├── gen_js_matrices.js      #   JS 矩阵生成
│   ├── gen_forced.js           #   强制掩码矩阵生成
│   └── render_png.js           #   PNG 渲染（Node 手写 PNG writer）
└── docs/
    └── 上海电子税务局发票开具与配套软件管理操作方案.md  # 原始方案文档
```

## 构建

```bash
python3 build.py   # 输出 payinvoice开票助手.html（当前目录）
```

## 测试

```bash
python3 test/e2e.py         # 端到端测试（需 playwright）
python3 test/final_e2e.py   # 二维码最终闭环验证（需 playwright + opencv）
node test/gen_js_matrices.js && python3 test/compare_python.py  # QR 矩阵级比对
```

## 质量验证记录

| 项目 | 方法 | 结果 |
|---|---|---|
| QR 编码器 | 与 Python `qrcode` 库矩阵级比对（40 版本 × 4 等级 × 3 模式 + 随机大文本） | 480+ 例 100% 一致 |
| 二维码可读性 | OpenCV 端到端解码生成的 PNG | 通过 |
| PNG 导出保真 | SVG 矩阵 vs canvas PNG 矩阵逐模块比对 | 0/11025 差异 |
| SM4 加密 | 与 gmssl / OpenSSL 三方交叉验证 + 20 轮随机数据 | 20/20 一致 |
| 应用端到端 | Playwright + Chromium（8 视图、表单、二维码、下载、持久化） | 41/41 通过 |

## 合规声明

1. 本工具生成的二维码为本地加密载荷，供内部流转与打印；**正式开票二维码以电子税务局官方生成结果为准**。
2. 软件仅从官方渠道下载（上海税务网站 → 纳税服务 → 下载中心 → 软件下载 → 发票助手），严禁破解、篡改版本。
3. 不绕过实名认证、人脸识别或税务监管；开票数据必须真实反映交易实际。咨询热线 12366。
