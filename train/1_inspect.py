#!/usr/bin/env python3
"""
1단계 — 내려받은 데이터 구조 파악
    python train/1_inspect.py <데이터폴더>

왜 이게 먼저인가
────────────────
AI Hub 데이터셋은 배포 시점·데이터셋마다 폴더 구조가 다르다.
어떤 것은 `클래스명/이미지.jpg`, 어떤 것은 라벨이 JSON에 따로 있다.
구조를 모른 채 학습 스크립트를 쓰면 경로만 맞추다 하루가 간다.

이 스크립트는 아무것도 바꾸지 않고 읽기만 한다.
출력된 내용을 보고 다음 단계(2_prepare.py)의 설정을 정한다.
"""
import sys, json, os
from pathlib import Path
from collections import Counter

if len(sys.argv) < 2:
    print("사용법: python train/1_inspect.py <데이터폴더>")
    print("  예:  python train/1_inspect.py ~/Downloads/kfood")
    sys.exit(1)

ROOT = Path(sys.argv[1]).expanduser()
if not ROOT.exists():
    print(f"✗ 폴더가 없습니다: {ROOT}")
    sys.exit(1)

IMG_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

print("=" * 66)
print(f"데이터 점검: {ROOT}")
print("=" * 66)

# ── 1. 상위 구조 ────────────────────────────────────────────
print("\n[1] 상위 폴더 구조 (깊이 3까지)")
def tree(p: Path, depth=0, max_depth=3, max_items=8):
    if depth > max_depth:
        return
    try:
        entries = sorted(p.iterdir())
    except (PermissionError, OSError):
        return
    dirs = [e for e in entries if e.is_dir()]
    files = [e for e in entries if e.is_file()]
    for d in dirs[:max_items]:
        print("    " * depth + f"  📁 {d.name}/")
        tree(d, depth + 1, max_depth, max_items)
    if len(dirs) > max_items:
        print("    " * depth + f"  … 폴더 {len(dirs) - max_items}개 더")
    if files:
        ext = Counter(f.suffix.lower() for f in files)
        summary = ", ".join(f"{k or '(확장자없음)'} {v}개" for k, v in ext.most_common(4))
        print("    " * depth + f"  📄 {summary}")

tree(ROOT)

# ── 2. 이미지 전수 조사 ─────────────────────────────────────
print("\n[2] 이미지 파일 집계 (시간이 좀 걸립니다)")
images = []
for dirpath, _, filenames in os.walk(ROOT):
    for fn in filenames:
        if Path(fn).suffix.lower() in IMG_EXT:
            images.append(Path(dirpath) / fn)

print(f"    이미지 총 {len(images):,}장")
if not images:
    print("    ✗ 이미지를 찾지 못했습니다. 압축을 푼 폴더가 맞는지 확인하세요.")
    sys.exit(1)

# ── 3. 클래스 추정 ──────────────────────────────────────────
# 대개 이미지의 부모 폴더 이름이 클래스다. 어느 깊이가 클래스인지 후보를 보여 준다.
print("\n[3] 클래스 후보 (이미지 경로의 각 깊이별 고유값 수)")
rels = [img.relative_to(ROOT).parts for img in images]
max_depth = max(len(r) for r in rels)
for d in range(max_depth - 1):          # 마지막은 파일명이므로 제외
    vals = Counter(r[d] for r in rels if len(r) > d + 1)
    print(f"    깊이 {d}: 고유값 {len(vals):>5}개   예: {', '.join(list(vals)[:4])}")

# 가장 그럴듯한 깊이 = 이미지의 직속 부모
parent_counts = Counter(img.parent.name for img in images)
print(f"\n    직속 부모 폴더 기준 클래스 수: {len(parent_counts)}개")
print("    장수 상위 10개:")
for name, n in parent_counts.most_common(10):
    print(f"      {name:<28} {n:>7,}장")
print("    장수 하위 10개:")
for name, n in parent_counts.most_common()[-10:]:
    print(f"      {name:<28} {n:>7,}장")

few = [n for n in parent_counts.values() if n < 50]
if few:
    print(f"\n    ⚠️ 50장 미만인 클래스가 {len(few)}개 있습니다.")
    print("       이런 클래스는 학습이 잘 안 됩니다. 2_prepare.py에서 제외하거나 합치세요.")

# ── 4. 라벨 파일 확인 ───────────────────────────────────────
print("\n[4] 라벨/메타데이터 파일")
labels = []
for dirpath, _, filenames in os.walk(ROOT):
    for fn in filenames:
        if Path(fn).suffix.lower() in {'.json', '.csv', '.xml', '.txt'}:
            labels.append(Path(dirpath) / fn)
print(f"    라벨로 보이는 파일 {len(labels):,}개")

if labels:
    sample = labels[0]
    print(f"    예시: {sample.relative_to(ROOT)}")
    try:
        if sample.suffix.lower() == '.json':
            with open(sample, encoding='utf-8') as f:
                obj = json.load(f)
            txt = json.dumps(obj, ensure_ascii=False, indent=2)
            print("    내용 앞부분:")
            for line in txt.splitlines()[:20]:
                print("      " + line)
        else:
            with open(sample, encoding='utf-8', errors='replace') as f:
                for i, line in enumerate(f):
                    if i >= 5: break
                    print("      " + line.rstrip())
    except Exception as e:
        print(f"    (읽지 못함: {e})")

# ── 5. 이미지 샘플 정보 ─────────────────────────────────────
print("\n[5] 이미지 샘플")
try:
    from PIL import Image
    for img in images[:3]:
        with Image.open(img) as im:
            print(f"    {img.name:<32} {im.size[0]}x{im.size[1]}  {im.mode}  "
                  f"{img.stat().st_size // 1024}KB")
except ImportError:
    print("    (Pillow 미설치 — pip install pillow 하면 해상도도 봅니다)")

# ── 6. 다음 단계 안내 ───────────────────────────────────────
print("\n" + "=" * 66)
print("다음 할 일")
print("=" * 66)
print(f"""
  1. 위 [3]에서 **어느 깊이가 음식 이름인지** 확인하세요.
     보통 직속 부모 폴더({len(parent_counts)}개 클래스)가 맞습니다.

  2. 클래스 이름이 한글인지 코드(예: 'A01_001')인지 보세요.
     코드라면 [4]의 라벨 파일에 한글 이름 대응표가 있을 겁니다.

  3. 확인한 내용으로 2_prepare.py를 실행합니다:
       python train/2_prepare.py {ROOT} --class-depth -1

  ※ 이 스크립트는 아무 파일도 바꾸지 않았습니다.
""")
