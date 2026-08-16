#!/usr/bin/env python3
"""
3단계 — 한국 음식 분류기 학습
    python train/3_train.py [옵션]

설계 결정
─────────
· **밑바닥부터 학습하지 않는다.** ImageNet으로 사전학습된 백본을 가져와
  마지막 층만 새로 배우게 한다(전이학습). 데이터가 84만 장이어도
  밑바닥 학습은 GPU 수십 시간이 들고, 전이학습은 몇 시간이면 끝난다.

· **작은 모델을 쓴다.** 브라우저에서 돌리는 것이 목표이므로 크기가 곧 제약이다.
  기본값 mobilenetv3는 ONNX로 약 10MB다. CLIP(150MB)의 1/15이라
  사용자가 기다리는 시간이 확 준다.

· **가중 샘플링**으로 클래스 불균형을 완화한다. 장수가 적은 음식도
  학습에 자주 등장하게 만든다. 이걸 안 하면 흔한 음식만 맞히는
  모델이 나온다.

· **가장 좋은 검증 정확도의 가중치만 저장한다.** 마지막 epoch가
  가장 좋은 경우는 드물다.

GPU가 없으면 매우 느립니다. Colab 무료 등급이면 충분합니다.
"""
import argparse, json, time, sys
from pathlib import Path

try:
    import torch
    import torch.nn as nn
    from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler
    import torchvision.transforms as T
    from torchvision import models
    from PIL import Image
except ImportError as e:
    print(f'✗ 필요한 패키지가 없습니다: {e}')
    print('  pip install -r train/requirements.txt')
    sys.exit(1)

p = argparse.ArgumentParser()
p.add_argument('--data', default='train/data')
p.add_argument('--out', default='train/runs')
p.add_argument('--arch', default='mobilenetv3',
               choices=['mobilenetv3', 'efficientnet_b0', 'resnet50'],
               help='백본. 브라우저용이면 mobilenetv3 권장')
p.add_argument('--epochs', type=int, default=8)
p.add_argument('--batch', type=int, default=64)
p.add_argument('--lr', type=float, default=3e-4)
p.add_argument('--img-size', type=int, default=224)
p.add_argument('--workers', type=int, default=6,
               help='데이터 로딩 워커 수. CPU 학습이면 코어의 1/3 정도가 적당')
p.add_argument('--freeze-epochs', type=int, default=1,
               help='처음 N epoch는 백본을 얼리고 분류층만 학습 (안정적)')
args = p.parse_args()

DATA = Path(args.data)
OUT = Path(args.out)
OUT.mkdir(parents=True, exist_ok=True)

meta = json.loads((DATA / 'classes.json').read_text(encoding='utf-8'))
classes = meta['classes']
n_cls = len(classes)

dev = ('cuda' if torch.cuda.is_available()
       else 'mps' if torch.backends.mps.is_available() else 'cpu')

print('=' * 66)
print(f'3단계 — 학습  ·  클래스 {n_cls}개  ·  장치 {dev}  ·  백본 {args.arch}')
print('=' * 66)

if dev == 'cpu':
    import os as _os
    cores = _os.cpu_count() or 4
    # CPU 학습은 스레드 설정이 속도를 크게 좌우한다.
    # DataLoader 워커와 연산 스레드가 서로 코어를 뺏지 않도록 나눠 준다.
    compute_threads = max(2, cores - args.workers)
    torch.set_num_threads(compute_threads)
    print(f'⚠️ GPU가 없어 CPU로 학습합니다.')
    print(f'   코어 {cores}개 · 연산 스레드 {compute_threads} · 데이터 워커 {args.workers}')
    print(f'   ─ 예상 시간 (MobileNetV3 기준, 실측은 첫 epoch 후 확인) ─')
    n_train_est = sum(1 for _ in open(DATA / 'train.tsv', encoding='utf-8'))
    for ips in (25, 40):
        hrs = n_train_est / ips * args.epochs / 3600
        print(f'     초당 {ips}장이면  {args.epochs} epoch에 약 {hrs:.1f}시간')
    print('   느리면 --epochs 를 줄이거나, 2_prepare.py에서')
    print('   --max-per-class 를 낮춰 이미지 수를 줄이세요.')
    print('   중간에 끊겨도 best.pt는 매 epoch 저장되므로 잃지 않습니다.')

# ── 데이터셋 ────────────────────────────────────────────────
class FoodSet(Dataset):
    def __init__(self, tsv, tf):
        self.rows = []
        for line in Path(tsv).read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            path, idx = line.rsplit('\t', 1)
            self.rows.append((path, int(idx)))
        self.tf = tf

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        path, y = self.rows[i]
        try:
            img = Image.open(path).convert('RGB')
        except Exception:
            # 깨진 이미지가 섞여 있어도 학습이 멈추면 안 된다
            img = Image.new('RGB', (args.img_size, args.img_size), (0, 0, 0))
        return self.tf(img), y

# ImageNet 통계. 사전학습 가중치를 쓰므로 같은 값으로 정규화해야 한다.
MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]

# 증강: 밥상 사진은 각도·조명·확대가 제각각이라 회전·색조 변화를 넣는다.
train_tf = T.Compose([
    T.RandomResizedCrop(args.img_size, scale=(0.6, 1.0)),
    T.RandomHorizontalFlip(),
    T.RandomRotation(15),
    T.ColorJitter(brightness=0.25, contrast=0.25, saturation=0.25, hue=0.03),
    T.ToTensor(), T.Normalize(MEAN, STD),
    T.RandomErasing(p=0.2)          # 반찬에 가려진 상황 흉내
])
val_tf = T.Compose([
    T.Resize(int(args.img_size * 1.14)), T.CenterCrop(args.img_size),
    T.ToTensor(), T.Normalize(MEAN, STD)
])

# ── 모델 ────────────────────────────────────────────────────
def build(arch, n):
    if arch == 'mobilenetv3':
        m = models.mobilenet_v3_large(weights='DEFAULT')
        m.classifier[3] = nn.Linear(m.classifier[3].in_features, n)
        head = m.classifier
    elif arch == 'efficientnet_b0':
        m = models.efficientnet_b0(weights='DEFAULT')
        m.classifier[1] = nn.Linear(m.classifier[1].in_features, n)
        head = m.classifier
    else:
        m = models.resnet50(weights='DEFAULT')
        m.fc = nn.Linear(m.fc.in_features, n)
        head = m.fc
    return m, head

# Windows는 DataLoader 워커를 spawn으로 띄우면서 이 모듈을 다시 임포트한다.
# 아래 실행부가 최상위에 있으면 워커마다 학습이 처음부터 재실행되므로 반드시 가드한다.
if __name__ == '__main__':
    train_ds = FoodSet(DATA / 'train.tsv', train_tf)
    val_ds = FoodSet(DATA / 'val.tsv', val_tf)

    # 클래스 불균형 보정 — 적은 클래스를 자주 뽑는다
    counts = [0] * n_cls
    for _, y in train_ds.rows:
        counts[y] += 1
    weights = [1.0 / max(1, counts[y]) for _, y in train_ds.rows]
    sampler = WeightedRandomSampler(weights, len(weights), replacement=True)

    train_ld = DataLoader(train_ds, batch_size=args.batch, sampler=sampler,
                          num_workers=args.workers, pin_memory=(dev == 'cuda'))
    val_ld = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                        num_workers=args.workers, pin_memory=(dev == 'cuda'))
    print(f'학습 {len(train_ds):,}장 · 검증 {len(val_ds):,}장')

    model, head = build(args.arch, n_cls)
    model.to(dev)

    # label smoothing: 비슷하게 생긴 음식이 많아 과신을 줄이는 편이 낫다
    crit = nn.CrossEntropyLoss(label_smoothing=0.1)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    def set_frozen(frozen):
        for p_ in model.parameters():
            p_.requires_grad = not frozen
        for p_ in head.parameters():
            p_.requires_grad = True

    @torch.no_grad()
    def evaluate():
        model.eval()
        top1 = top3 = total = 0
        for x, y in val_ld:
            x, y = x.to(dev), y.to(dev)
            out = model(x)
            _, pred = out.topk(3, dim=1)
            eq = pred.eq(y.view(-1, 1))
            top1 += eq[:, 0].sum().item()
            top3 += eq.any(dim=1).sum().item()
            total += y.size(0)
        return top1 / total, top3 / total

    # ── 학습 루프 ───────────────────────────────────────────
    best = 0.0
    for ep in range(1, args.epochs + 1):
        frozen = ep <= args.freeze_epochs
        set_frozen(frozen)
        model.train()
        t0, run, seen = time.time(), 0.0, 0

        for i, (x, y) in enumerate(train_ld, 1):
            x, y = x.to(dev), y.to(dev)
            opt.zero_grad()
            loss = crit(model(x), y)
            loss.backward()
            opt.step()
            run += loss.item() * y.size(0)
            seen += y.size(0)
            if i % 50 == 0:
                print(f'\r  ep{ep} {i}/{len(train_ld)}  loss {run/seen:.3f}', end='')

        sched.step()
        a1, a3 = evaluate()
        mark = ''
        if a1 > best:
            best = a1
            torch.save({'state_dict': model.state_dict(), 'arch': args.arch,
                        'classes': classes, 'food_ids': meta['food_ids'],
                        'img_size': args.img_size, 'mean': MEAN, 'std': STD,
                        'top1': a1, 'top3': a3},
                       OUT / 'best.pt')
            mark = '  ← 저장'
        print(f'\r  ep{ep}{" (백본 동결)" if frozen else ""}  '
              f'loss {run/seen:.3f}  top1 {a1*100:.1f}%  top3 {a3*100:.1f}%  '
              f'{time.time()-t0:.0f}초{mark}')

    print(f"""
{'=' * 66}
최고 top-1 정확도: {best*100:.1f}%
가중치: {OUT}/best.pt
{'=' * 66}

읽는 법
  · top-1 = 1등이 정답인 비율. 앱이 자동으로 담는 값의 정확도.
  · top-3 = 정답이 상위 3개 안에 있는 비율.
    앱은 후보를 보여 주므로 top-3가 실사용 체감에 더 가깝다.
  · 60%대여도 CLIP보다 훨씬 나을 수 있다. 4_evaluate.py로 비교하세요.

다음: python train/4_evaluate.py
""")
