#!/usr/bin/env python3
"""
kfood.zip(대분류.zip 27개가 들어있는 이중 압축)을 train/dataset/으로 풀어준다.
AI Hub aihubshell 없이 수동으로 받은 케이스 전용 — 0c_fetch.sh를 안 거쳤을 때 씀.

  python train/extract_kfood.py <kfood.zip 경로> [출력폴더]
"""
import sys, zipfile, tempfile, os, time
from pathlib import Path

if len(sys.argv) < 2:
    print("사용법: python train/extract_kfood.py <kfood.zip 경로> [출력폴더]")
    sys.exit(1)

SRC = Path(sys.argv[1]).expanduser()
DEST = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent / "dataset"
DEST.mkdir(parents=True, exist_ok=True)

if not SRC.exists():
    print(f"✗ 없음: {SRC}")
    sys.exit(1)

t0 = time.time()
with zipfile.ZipFile(SRC) as outer:
    inner_zips = [e for e in outer.infolist() if e.filename.lower().endswith('.zip')]
    print(f"대분류 zip {len(inner_zips)}개 발견")
    for i, entry in enumerate(inner_zips, 1):
        cat = entry.filename
        print(f"[{i}/{len(inner_zips)}] {cat} 여는 중 ({entry.file_size/1e6:.0f}MB)…", flush=True)
        with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
            tmp_path = Path(tmp.name)
            with outer.open(entry) as src:
                while True:
                    chunk = src.read(1024 * 1024 * 8)
                    if not chunk:
                        break
                    tmp.write(chunk)
        try:
            with zipfile.ZipFile(tmp_path) as inner:
                names = inner.namelist()
                inner.extractall(DEST)
            n_img = sum(1 for n in names if n.lower().endswith(('.jpg', '.jpeg', '.png')))
            print(f"    -> {n_img:,}장 압축 해제 완료  (누적 {time.time()-t0:.0f}초)", flush=True)
        finally:
            tmp_path.unlink(missing_ok=True)

total_imgs = sum(1 for _ in DEST.rglob('*.jpg')) + sum(1 for _ in DEST.rglob('*.jpeg')) + sum(1 for _ in DEST.rglob('*.png'))
print(f"\n완료. {DEST} 에 이미지 총 {total_imgs:,}장  ({time.time()-t0:.0f}초 소요)")
