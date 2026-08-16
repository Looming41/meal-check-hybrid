#!/usr/bin/env python3
"""
5단계 — 브라우저용 ONNX로 내보내기
    python train/5_export.py [--quantize]

무엇을 만드나
─────────────
  models/food-classifier.onnx   브라우저에서 돌릴 모델
  models/food-classes.json      클래스 ↔ 앱 음식 id 대응표

크기가 핵심이다. 사용자가 이걸 다 받아야 인식이 시작되므로
CLIP(150MB)보다 훨씬 작아야 갈아탈 이유가 생긴다.
--quantize를 주면 int8로 양자화해 크기가 대략 1/4이 된다.
정확도는 보통 1%p 안팎 떨어지므로, 떨어진 만큼이 받아들일 만한지
4_evaluate.py 결과와 비교해 정하면 된다.
"""
import argparse, json, shutil, sys
from pathlib import Path

try:
    import torch, torch.nn as nn
    from torchvision import models
except ImportError as e:
    print(f'✗ 패키지 없음: {e}\n  pip install -r train/requirements.txt')
    sys.exit(1)

ap = argparse.ArgumentParser()
ap.add_argument('--ckpt', default='train/runs/best.pt')
ap.add_argument('--out', default='models')
ap.add_argument('--quantize', action='store_true', help='int8 양자화 (크기 약 1/4)')
ap.add_argument('--opset', type=int, default=17)
args = ap.parse_args()

CKPT = Path(args.ckpt)
OUT = Path(args.out)
OUT.mkdir(parents=True, exist_ok=True)

if not CKPT.exists():
    print(f'✗ {CKPT}가 없습니다. 먼저 3_train.py를 실행하세요.')
    sys.exit(1)

ck = torch.load(CKPT, map_location='cpu', weights_only=False)
classes, food_ids = ck['classes'], ck['food_ids']
n, size = len(classes), ck['img_size']

print('=' * 66)
print(f'5단계 — ONNX 내보내기  ·  클래스 {n}개  ·  입력 {size}x{size}')
print('=' * 66)

def build(arch, k):
    if arch == 'mobilenetv3':
        m = models.mobilenet_v3_large()
        m.classifier[3] = nn.Linear(m.classifier[3].in_features, k)
    elif arch == 'efficientnet_b0':
        m = models.efficientnet_b0()
        m.classifier[1] = nn.Linear(m.classifier[1].in_features, k)
    else:
        m = models.resnet50()
        m.fc = nn.Linear(m.fc.in_features, k)
    return m

model = build(ck['arch'], n)
model.load_state_dict(ck['state_dict'])
model.eval()

# 정규화를 모델 안에 넣지 않는다. 브라우저 쪽(identify.js)에서 같은 mean/std로
# 맞추고, 그 값을 food-classes.json에 실어 보내 어긋날 일을 없앤다.
raw = OUT / 'food-classifier.onnx'
torch.onnx.export(
    model, torch.randn(1, 3, size, size), raw,
    input_names=['input'], output_names=['logits'],
    dynamic_axes={'input': {0: 'batch'}, 'logits': {0: 'batch'}},
    opset_version=args.opset, do_constant_folding=True
)
mb = raw.stat().st_size / 1e6
print(f'  내보냄: {raw}  ({mb:.1f}MB)')

if args.quantize:
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        q = OUT / 'food-classifier-int8.onnx'
        quantize_dynamic(raw, q, weight_type=QuantType.QUInt8)
        qmb = q.stat().st_size / 1e6
        print(f'  양자화: {q}  ({qmb:.1f}MB, {qmb/mb*100:.0f}%)')
        shutil.move(str(q), str(raw))
        print(f'  → {raw}로 교체했습니다.')
        print('  ⚠️ 양자화 후 정확도를 4_evaluate.py로 다시 확인하세요.')
    except ImportError:
        print('  · onnxruntime 미설치로 양자화를 건너뜁니다 (pip install onnxruntime)')

# 브라우저가 쓸 메타데이터. 전처리 값이 어긋나면 정확도가 통째로 무너지므로
# 학습에 쓴 값을 그대로 실어 보낸다.
meta = {
    'classes': classes,
    'food_ids': food_ids,
    'img_size': size,
    'mean': ck['mean'],
    'std': ck['std'],
    'arch': ck['arch'],
    'val_top1': ck.get('top1'),
    'val_top3': ck.get('top3'),
    'note': 'food_ids[i]가 data/foods-ko.json의 음식 id입니다. '
            '"new:"로 시작하면 아직 영양 테이블에 없는 음식입니다.'
}
(OUT / 'food-classes.json').write_text(
    json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

new_ids = [i for i in food_ids if str(i).startswith('new:')]
print(f'  메타: {OUT}/food-classes.json')
if new_ids:
    print(f'\n  ⚠️ 영양 테이블에 없는 음식 {len(new_ids)}종이 포함돼 있습니다.')
    print('     이 음식이 인식되면 앱이 영양 정보를 못 찾습니다.')
    print('     data/foods-ko.json에 추가하거나, 2_prepare.py를 --drop-unmapped로 다시 돌리세요.')

print(f"""
{'=' * 66}
배포
  1. {OUT}/ 폴더를 웹서버에 올립니다 (dist/models/ 아래 권장)
  2. js/app.js의 LOCAL_MODEL_URL을 그 주소로 지정
  3. npm run build

이 모델은 사용자 기기에서 돌아갑니다.
  · 호출 비용 0원 · 사진이 기기 밖으로 나가지 않음 · 한도 없음
{'=' * 66}
""")
