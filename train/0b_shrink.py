#!/usr/bin/env python3
"""
받은 이미지를 학습용 크기로 줄이고 원본을 지운다
    python train/0b_shrink.py <원본폴더> <출력폴더> [--size 512] [--delete]

왜 필요한가
───────────
AI Hub 음식 데이터가 1.6TB인 이유는 원본이 5메가픽셀 이상이기 때문이다.
그런데 **학습은 224×224로 한다.** 픽셀의 99%를 버리려고 1.6TB를 받는 셈이다.

512px로 줄이면 장당 약 50KB가 된다. 32만 장이면 16GB.
1.6TB가 16GB가 된다. 100배 차이다.

512로 줄이는 이유(224가 아니라):
  · 학습 시 RandomResizedCrop으로 확대·이동 증강을 하는데 여유가 필요하다
  · 나중에 384나 448로 실험할 여지를 남긴다
  · 이미 충분히 작다

--delete를 주면 처리한 원본을 지운다. 받자마자 줄이고 지우면
디스크가 한 번에 수십 GB 이상 차지 않는다. 0c_fetch.sh가 이 방식으로 돈다.
"""
import argparse, os, shutil, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

try:
    from PIL import Image
except ImportError:
    print('✗ Pillow가 필요합니다: pip install pillow')
    sys.exit(1)

ap = argparse.ArgumentParser()
ap.add_argument('src', help='원본 폴더 (압축 푼 곳)')
ap.add_argument('dst', help='줄인 이미지를 모을 폴더')
ap.add_argument('--size', type=int, default=512, help='긴 변 최대 픽셀 (기본 512)')
ap.add_argument('--quality', type=int, default=85)
ap.add_argument('--delete', action='store_true', help='처리한 원본 삭제 (디스크 절약)')
ap.add_argument('--workers', type=int, default=8)
args = ap.parse_args()

SRC, DST = Path(args.src).expanduser(), Path(args.dst).expanduser()
IMG_EXT = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}

if not SRC.exists():
    print(f'✗ 원본 폴더가 없습니다: {SRC}')
    sys.exit(1)

images = [Path(dp) / fn
          for dp, _, fns in os.walk(SRC)
          for fn in fns if Path(fn).suffix.lower() in IMG_EXT]

if not images:
    print(f'· 이미지가 없습니다: {SRC}')
    sys.exit(0)

print(f'  이미지 {len(images):,}장 → {args.size}px로 축소')

done = skipped = failed = 0
bytes_in = bytes_out = 0

def process(src_path: Path):
    global done, skipped, failed, bytes_in, bytes_out
    # 폴더 구조를 그대로 유지한다. 클래스가 폴더명이므로 무너뜨리면 안 된다.
    rel = src_path.relative_to(SRC)
    out = (DST / rel).with_suffix('.jpg')
    if out.exists():
        return 'skip', 0, 0
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        size_in = src_path.stat().st_size
        with Image.open(src_path) as im:
            im = im.convert('RGB')
            w, h = im.size
            if max(w, h) > args.size:
                r = args.size / max(w, h)
                im = im.resize((max(1, round(w * r)), max(1, round(h * r))),
                               Image.LANCZOS)
            im.save(out, 'JPEG', quality=args.quality, optimize=True)
        size_out = out.stat().st_size
        if args.delete:
            src_path.unlink()
        return 'ok', size_in, size_out
    except Exception:
        return 'fail', 0, 0

with ThreadPoolExecutor(max_workers=args.workers) as ex:
    for i, (status, bi, bo) in enumerate(ex.map(process, images), 1):
        if status == 'ok':
            done += 1; bytes_in += bi; bytes_out += bo
        elif status == 'skip':
            skipped += 1
        else:
            failed += 1
        if i % 500 == 0:
            print(f'\r    {i:,}/{len(images):,}', end='')

gb = lambda b: b / 1e9
print(f'\r    완료 {done:,}장' + (f' · 건너뜀 {skipped:,}' if skipped else '')
      + (f' · 실패 {failed:,}' if failed else ''))
if bytes_in:
    print(f'    {gb(bytes_in):.1f}GB → {gb(bytes_out):.1f}GB '
          f'({bytes_out/bytes_in*100:.1f}%)')

if args.delete:
    # 빈 폴더 정리
    for dp, dns, fns in os.walk(SRC, topdown=False):
        p = Path(dp)
        if not any(p.iterdir()):
            try: p.rmdir()
            except OSError: pass
