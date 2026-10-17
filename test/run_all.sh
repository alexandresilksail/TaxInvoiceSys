#!/usr/bin/env bash
# run_all.sh — payinvoice 开票助手全部测试一键入口
# 用法：bash test/run_all.sh
# 包含：
#   1. crypto_test.js   国密/SHA/HMAC/PBKDF2/P2 载荷安全测试（Node）
#   2. money_test.js    金额计算与舍入规则测试（Node）
#   3. e2e.py           全功能端到端测试（Playwright + Chromium）
#   4. final_e2e.py     二维码像素级保真 + OpenCV 解码 + 解密闭环
#   5. compare_python.py QR 编码器与 Python qrcode 库矩阵级比对（需 qrcode/pillow）
set -u
cd "$(dirname "$0")/.."
FAIL=0

run() {
  local name="$1"; shift
  echo ""
  echo "============================================================"
  echo "  $name"
  echo "============================================================"
  if "$@"; then
    echo ">>> [OK] $name"
  else
    echo ">>> [FAIL] $name"
    FAIL=1
  fi
}

run "1/5 加密模块安全测试（Node）" node test/crypto_test.js
run "2/5 金额计算规则测试（Node）" node test/money_test.js
run "3/5 端到端功能测试（Playwright）" python3 test/e2e.py
run "4/5 二维码闭环验证（像素级+OpenCV）" python3 test/final_e2e.py
run "5/5 QR 编码器矩阵比对（Python qrcode）" python3 test/compare_python.py

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "===== 全部测试通过 ====="
else
  echo "===== 存在失败阶段，请检查上方输出 ====="
fi
exit $FAIL
