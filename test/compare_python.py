import json, sys
import qrcode
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H

EC = {'L': ERROR_CORRECT_L, 'M': ERROR_CORRECT_M, 'Q': ERROR_CORRECT_Q, 'H': ERROR_CORRECT_H}

cases = [
    ('numeric', '12345678901234567890'),
    ('alnum', 'HELLO WORLD 123 ABC'),
    ('byte', 'PAYINVOICE 开票助手 SM4 TEST'),
]

js = json.load(open('/root/.codebuddy/artifact/payinvoice/test/js_matrices.json'))

total, match, mismatch, err = 0, 0, 0, 0
details = []
for ec in ['L','M','Q','H']:
    for v in range(1, 41):
        for name, text in cases:
            key = f'{ec}-{v}-{name}'
            j = js.get(key, {})
            total += 1
            if 'error' in j:
                # JS 判定超容量时，Python 参考应同样放不下
                qr = qrcode.QRCode(version=v, error_correction=EC[ec], box_size=1, border=0)
                try:
                    qr.add_data(text, optimize=0)
                    qr.make(fit=False)
                    details.append(f'{key}: JS says too long, PY succeeded (modules={len(qr.modules)})')
                    mismatch += 1
                except Exception:
                    err += 1
                continue
            qr = qrcode.QRCode(version=v, error_correction=EC[ec], box_size=1, border=0)
            qr.add_data(text, optimize=0)
            try:
                qr.make(fit=False)
            except Exception as e:
                details.append(f'{key}: PY failed ({e}) but JS ok')
                mismatch += 1
                continue
            pym = [[1 if c else 0 for c in row] for row in qr.modules]
            if pym == j['modules']:
                match += 1
            else:
                mismatch += 1
                # 找出差异类型
                n = len(pym)
                diff_cells = sum(1 for y in range(n) for x in range(n) if pym[y][x] != j['modules'][y][x])
                py_mask = getattr(qr, 'mask_pattern', None)
                details.append(f'{key}: MISMATCH diff_cells={diff_cells} js_mask={j.get("mask")} py_mask={py_mask}')

print(f'total={total} match={match} mismatch={mismatch} both_too_long={err}')
for d in details[:20]:
    print(d)
sys.exit(0 if mismatch == 0 else 1)
