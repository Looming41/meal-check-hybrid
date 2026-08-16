#!/usr/bin/env python3
"""
4단계 — 평가. 특히 "헷갈리는 음식"을 가르는지 본다
    python train/4_evaluate.py

전체 정확도만 보면 안 되는 이유
──────────────────────────────
평균 80%여도 된장찌개·김치찌개·순두부찌개를 못 가르면 이 앱은 실패한다.
그 셋은 나트륨·칼륨·자극성이 달라 판정이 갈리기 때문이다.
반면 '사과'와 '바나나'를 헷갈리는 일은 거의 없고 있어도 덜 위험하다.

그래서 이 스크립트는 **판정이 갈리는 묶음**을 따로 뽑아 본다.
"""
import json, sys
from pathlib import Path
from collections import defaultdict

try:
    import torch, torch.nn as nn
    import torchvision.transforms as T
    from torchvision import models
    from torch.utils.data import DataLoader, Dataset
    from PIL import Image
except ImportError as e:
    print(f'✗ 패키지 없음: {e}\n  pip install -r train/requirements.txt')
    sys.exit(1)

CKPT = Path('train/runs/best.pt')
DATA = Path('train/data')
if not CKPT.exists():
    print(f'✗ {CKPT}가 없습니다. 먼저 3_train.py를 실행하세요.')
    sys.exit(1)

ck = torch.load(CKPT, map_location='cpu', weights_only=False)
classes, food_ids = ck['classes'], ck['food_ids']
n = len(classes)
dev = ('cuda' if torch.cuda.is_available()
       else 'mps' if torch.backends.mps.is_available() else 'cpu')

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
model.to(dev).eval()

tf = T.Compose([
    T.Resize(int(ck['img_size'] * 1.14)), T.CenterCrop(ck['img_size']),
    T.ToTensor(), T.Normalize(ck['mean'], ck['std'])
])

class Val(Dataset):
    def __init__(self, tsv):
        self.rows = [l.rsplit('\t', 1) for l in
                     Path(tsv).read_text(encoding='utf-8').splitlines() if l.strip()]
    def __len__(self): return len(self.rows)
    def __getitem__(self, i):
        p_, y = self.rows[i]
        try: img = Image.open(p_).convert('RGB')
        except Exception: img = Image.new('RGB', (224, 224))
        return tf(img), int(y)

# Windows는 DataLoader 워커를 spawn으로 띄우면서 이 모듈을 다시 임포트한다.
# 실행부가 최상위에 있으면 워커마다 재실행되므로 반드시 가드한다.
if __name__ == '__main__':
    ld = DataLoader(Val(DATA / 'val.tsv'), batch_size=64, num_workers=4)

    print('=' * 66)
    print(f'4단계 — 평가  ·  클래스 {n}개')
    print('=' * 66)

    correct1 = correct3 = total = 0
    per_cls = defaultdict(lambda: [0, 0])          # [맞음, 전체]
    confusion = defaultdict(int)                    # (정답, 오답) → 횟수

    with torch.no_grad():
        for x, y in ld:
            x, y = x.to(dev), y.to(dev)
            out = model(x)
            _, pred = out.topk(3, 1)
            eq = pred.eq(y.view(-1, 1))
            correct1 += eq[:, 0].sum().item()
            correct3 += eq.any(1).sum().item()
            total += y.size(0)
            for t_, p1 in zip(y.tolist(), pred[:, 0].tolist()):
                per_cls[t_][1] += 1
                if t_ == p1: per_cls[t_][0] += 1
                else: confusion[(t_, p1)] += 1

    print(f'\n[1] 전체')
    print(f'    top-1 {correct1/total*100:.1f}%   top-3 {correct3/total*100:.1f}%   ({total:,}장)')

    print('\n[2] 가장 못 맞히는 클래스 15개')
    worst = sorted(((c[0] / max(1, c[1]), i, c) for i, c in per_cls.items()))[:15]
    for acc, i, c in worst:
        print(f'    {classes[i]:<28} {acc*100:>5.1f}%  ({c[0]}/{c[1]})')

    print('\n[3] 가장 자주 헷갈리는 쌍 15개')
    for (t_, p1), cnt in sorted(confusion.items(), key=lambda kv: -kv[1])[:15]:
        print(f'    {classes[t_]:<24} → {classes[p1]:<24} {cnt:>4}회')

    # ── 판정이 갈리는 묶음 ──────────────────────────────────
    # 이 묶음 안에서 헷갈리면 나트륨·칼륨·질감이 달라 판정 결과가 바뀐다.
    CRITICAL = [
        ('붉은 찌개류', ['김치찌개', '순두부찌개', '부대찌개', '된장찌개', '청국장']),
        ('나물 반찬',   ['시금치나물', '콩나물무침', '쌈채소', '브로콜리']),
        ('국·탕',       ['미역국', '콩나물국', '설렁탕', '갈비탕', '육개장']),
        ('밥류',        ['흰쌀밥', '잡곡밥', '비빔밥', '볶음밥', '죽']),
        ('떡·면',       ['떡', '떡볶이', '라볶이', '냉면', '칼국수']),
    ]
    idx_of = {c: i for i, c in enumerate(classes)}

    print('\n[4] 판정이 갈리는 묶음 — 여기서 틀리면 결과가 바뀝니다')
    for label, group in CRITICAL:
        ids = [idx_of[g] for g in group if g in idx_of]
        if len(ids) < 2:
            continue
        inside = sum(confusion[(a, b)] for a in ids for b in ids if a != b)
        tot = sum(per_cls[a][1] for a in ids)
        hit = sum(per_cls[a][0] for a in ids)
        print(f'\n    {label} ({len(ids)}종)')
        print(f'      정확도 {hit/max(1,tot)*100:.1f}%  ·  묶음 안에서 서로 헷갈린 횟수 {inside}회')
        for a in ids:
            wrong = sorted(((confusion[(a, b)], b) for b in ids if b != a), reverse=True)
            top = wrong[0] if wrong and wrong[0][0] else None
            note = f'  주로 → {classes[top[1]]}' if top else ''
            print(f'      · {classes[a]:<22} {per_cls[a][0]/max(1,per_cls[a][1])*100:>5.1f}%{note}')

    # ── 같은 앱 음식으로 매핑되는 클래스는 틀려도 무해 ──────
    same = sum(cnt for (t_, p1), cnt in confusion.items()
               if food_ids[t_] == food_ids[p1])
    if same:
        print(f'\n[5] 오답 중 {same:,}건은 앱에서 같은 음식으로 매핑됩니다 (판정에 영향 없음)')

    print(f"""
{'=' * 66}
판단 기준
  · [4]의 묶음 정확도가 전체 정확도보다 크게 낮으면,
    그 묶음 이미지를 더 모으거나 epoch를 늘리는 것이 우선입니다.
  · top-3가 높으면(85%+) 앱의 "혹시 이건가요?" 후보로 충분히 쓸 만합니다.
  · [3]에서 특정 쌍이 압도적이면 그 두 클래스를 합치는 것도 방법입니다.

다음: python train/5_export.py
""")
