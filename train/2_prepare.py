#!/usr/bin/env python3
"""
2단계 — 학습용 목록 만들기 + 앱 음식 id에 매핑
    python train/2_prepare.py <데이터폴더> [옵션]

하는 일
───────
  · 이미지를 훑어 클래스별로 모은다
  · 클래스 이름을 앱의 음식 id(data/foods-ko.json)에 매핑한다
  · train/val로 나눈 목록(manifest)을 만든다
  · **매핑되지 않은 클래스를 빠짐없이 보고한다**

왜 매핑이 중요한가
──────────────────
분류기가 "김치찌개"라고 맞혀도 앱의 영양 테이블에 연결되지 않으면
판정을 못 한다. 즉 이 단계가 틀리면 학습을 아무리 잘해도 쓸모가 없다.

매핑 안 된 클래스는 두 가지로 처리한다.
  (a) 앱 테이블에 그 음식을 추가한다  ← 권장. 음식 수가 늘어난다
  (b) 학습에서 제외한다              ← --drop-unmapped
조용히 버리지 않는 이유는, 버린 음식을 사용자가 찍으면
엉뚱한 것으로 분류돼 잘못된 판정이 나가기 때문이다.
"""
import argparse, json, os, random, re, sys, unicodedata
from pathlib import Path
from collections import defaultdict, Counter

p = argparse.ArgumentParser()
p.add_argument('root', help='내려받은 데이터 폴더')
p.add_argument('--out', default='train/data', help='출력 폴더')
p.add_argument('--class-depth', type=int, default=-1,
               help='경로에서 클래스명 위치. -1이면 이미지의 직속 부모 폴더 (기본)')
p.add_argument('--min-images', type=int, default=50,
               help='이 장수 미만인 클래스는 제외 (학습이 잘 안 됨)')
p.add_argument('--max-per-class', type=int, default=1200,
               help='클래스당 최대 장수. 데이터 불균형과 학습 시간을 줄인다')
p.add_argument('--val-ratio', type=float, default=0.15)
p.add_argument('--drop-unmapped', action='store_true',
               help='앱 테이블에 없는 클래스를 학습에서 제외')
p.add_argument('--seed', type=int, default=42)
args = p.parse_args()

random.seed(args.seed)
ROOT = Path(args.root).expanduser()
OUT = Path(args.out)
OUT.mkdir(parents=True, exist_ok=True)
IMG_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

# ── 앱의 음식 테이블 읽기 ───────────────────────────────────
FOODS_PATH = Path(__file__).resolve().parent.parent / 'data' / 'foods-ko.json'
foods = json.loads(FOODS_PATH.read_text(encoding='utf-8'))['foods']

def norm(s: str) -> str:
    """비교용 정규화 — 공백·기호 제거, 유니코드 정규화(한글 자모 분리 방지)"""
    s = unicodedata.normalize('NFC', str(s))
    return re.sub(r'[\s_\-·()（）\[\]]+', '', s).lower()

# 한국어 이름과 별칭 모두를 검색 키로 만든다
name_to_id = {}
for f in foods:
    for nm in [f['ko']] + list(f.get('aliases', [])):
        name_to_id.setdefault(norm(nm), f['id'])

print('=' * 66)
print('2단계 — 학습 목록 만들기')
print('=' * 66)
print(f'  앱 음식 테이블: {len(foods)}종')

# ── 이미지 수집 ─────────────────────────────────────────────
print('\n[1] 이미지 수집 중…')
by_class = defaultdict(list)
for dirpath, _, filenames in os.walk(ROOT):
    for fn in filenames:
        if Path(fn).suffix.lower() not in IMG_EXT:
            continue
        path = Path(dirpath) / fn
        parts = path.relative_to(ROOT).parts
        if args.class_depth == -1:
            cls = path.parent.name
        else:
            if len(parts) <= args.class_depth:
                continue
            cls = parts[args.class_depth]
        by_class[cls].append(path)

print(f'    클래스 {len(by_class)}개 · 이미지 {sum(len(v) for v in by_class.values()):,}장')

# ── 장수 부족 클래스 제외 ───────────────────────────────────
too_few = {c: len(v) for c, v in by_class.items() if len(v) < args.min_images}
for c in too_few:
    del by_class[c]
if too_few:
    print(f'    · {args.min_images}장 미만이라 제외: {len(too_few)}개 클래스')

# ── 앱 음식 id에 매핑 ───────────────────────────────────────
print('\n[2] 앱 음식 id에 매핑')
mapped, unmapped = {}, []
for cls in by_class:
    key = norm(cls)
    fid = name_to_id.get(key)
    if not fid:
        # 부분 일치 시도 — "김치찌개(돼지고기)" 같은 표기 흡수
        cands = [v for k, v in name_to_id.items() if k and (k in key or key in k)]
        fid = cands[0] if len(set(cands)) == 1 else None
    if fid:
        mapped[cls] = fid
    else:
        unmapped.append(cls)

print(f'    매핑됨   {len(mapped)}개 클래스')
print(f'    매핑안됨 {len(unmapped)}개 클래스')

if unmapped:
    print('\n    ⚠️ 앱 테이블에 없는 음식 (앞 30개):')
    for c in sorted(unmapped, key=lambda x: -len(by_class[x]))[:30]:
        print(f'       {c:<30} {len(by_class[c]):>6,}장')
    unmapped_path = OUT / 'unmapped_classes.txt'
    unmapped_path.write_text(
        '\n'.join(f'{c}\t{len(by_class[c])}' for c in
                  sorted(unmapped, key=lambda x: -len(by_class[x]))),
        encoding='utf-8')
    print(f'\n    전체 목록: {unmapped_path}')
    print('    → 이 음식들을 data/foods-ko.json에 추가하면 인식 범위가 넓어집니다.')
    print('      추가하지 않고 학습만 하려면 --drop-unmapped 를 주세요.')

if args.drop_unmapped:
    for c in unmapped:
        del by_class[c]
    print(f'\n    --drop-unmapped: {len(unmapped)}개 클래스를 학습에서 제외했습니다.')
else:
    # 매핑 안 된 것도 학습은 한다. id는 임시로 만들어 두고 나중에 테이블에 추가.
    for c in unmapped:
        mapped[c] = f'new:{norm(c)}'

# ── 클래스당 장수 상한 ──────────────────────────────────────
for c, v in by_class.items():
    if len(v) > args.max_per_class:
        by_class[c] = random.sample(v, args.max_per_class)

# ── train / val 분할 ────────────────────────────────────────
print('\n[3] train / val 분할')
classes = sorted(by_class)
cls_index = {c: i for i, c in enumerate(classes)}
train_rows, val_rows = [], []

for c in classes:
    paths = by_class[c][:]
    random.shuffle(paths)
    n_val = max(1, int(len(paths) * args.val_ratio))
    for pth in paths[:n_val]:
        val_rows.append((str(pth), cls_index[c]))
    for pth in paths[n_val:]:
        train_rows.append((str(pth), cls_index[c]))

random.shuffle(train_rows)
print(f'    클래스 {len(classes)}개')
print(f'    학습용 {len(train_rows):,}장 · 검증용 {len(val_rows):,}장')

# ── 저장 ────────────────────────────────────────────────────
def write_manifest(path, rows):
    with open(path, 'w', encoding='utf-8') as f:
        for pth, idx in rows:
            f.write(f'{pth}\t{idx}\n')

write_manifest(OUT / 'train.tsv', train_rows)
write_manifest(OUT / 'val.tsv', val_rows)

meta = {
    'classes': classes,                                  # 학습 클래스 이름(순서 = 라벨 인덱스)
    'food_ids': [mapped[c] for c in classes],            # 앱 음식 id (판정에 연결되는 값)
    'counts': {c: len(by_class[c]) for c in classes},
    'unmapped': unmapped,
    'source': str(ROOT),
    'val_ratio': args.val_ratio,
    'seed': args.seed
}
(OUT / 'classes.json').write_text(
    json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')

# 불균형 확인 — 한쪽으로 쏠리면 모델이 많은 클래스만 맞힌다
counts = [len(by_class[c]) for c in classes]
print(f'    클래스당 장수: 최소 {min(counts):,} · 중앙 {sorted(counts)[len(counts)//2]:,} · 최대 {max(counts):,}')
if max(counts) > min(counts) * 10:
    print('    ⚠️ 클래스 간 장수 차이가 10배 이상입니다.')
    print('       3_train.py가 가중 샘플링으로 완화하지만, 적은 클래스는 여전히 약합니다.')

print(f"""
{'=' * 66}
저장 완료 → {OUT}/
  train.tsv        학습 목록
  val.tsv          검증 목록
  classes.json     클래스 ↔ 앱 음식 id 대응표
{'=' * 66}

다음: python train/3_train.py
""")
