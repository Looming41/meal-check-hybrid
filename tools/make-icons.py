#!/usr/bin/env python3
"""
앱 아이콘 생성 — python3 tools/make-icons.py

PNG를 빌드마다 다시 만들지 않고 assets/에 한 번 생성해 두고 build.mjs가 복사한다.
빌드가 Python·이미지 라이브러리에 의존하지 않게 하기 위해서다.
아이콘 디자인을 바꿀 때만 이 스크립트를 다시 돌린다.

도안: 초록 배경 위에 밥그릇, 그릇 안에 체크 표시.
"""
from PIL import Image, ImageDraw
from pathlib import Path

GREEN = (47, 107, 79)      # --green
CREAM = (241, 243, 238)    # --bg
OUT = Path(__file__).resolve().parent.parent / "assets"
OUT.mkdir(exist_ok=True)

S = 1024  # 고해상도로 그린 뒤 축소해 계단현상을 줄인다


def draw(maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 배경: 일반 아이콘은 둥근 모서리, maskable은 꽉 채운다
    # (maskable은 런처가 알아서 잘라내므로 여백을 남기면 두 번 잘린다)
    if maskable:
        d.rectangle([0, 0, S, S], fill=GREEN)
        pad = int(S * 0.20)   # 안전 영역 확보
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.1875), fill=GREEN)
        pad = int(S * 0.10)

    def u(v):
        """1024 기준 좌표를 안전 영역 안으로 매핑"""
        inner = S - 2 * pad
        return pad + v / 1024 * inner

    # 그릇 테두리 (가로 막대)
    d.rounded_rectangle([u(120), u(400), u(904), u(462)],
                        radius=(u(462) - u(400)) / 2, fill=CREAM)

    # 그릇 몸통 — 타원의 아래 절반.
    # bbox 중심 y가 462이므로 그릇은 y 462~794를 차지한다.
    d.pieslice([u(180), u(130), u(844), u(794)], start=0, end=180, fill=CREAM)

    # 체크 표시 — 반드시 그릇 안(y 470~780)에 들어와야 한다.
    w = u(64) - u(0)
    pts = [(392, 592), (472, 672), (648, 496)]
    d.line([(u(x), u(y)) for x, y in pts], fill=GREEN, width=int(w), joint="curve")
    for x, y in pts:                      # 선 끝을 둥글게
        cx, cy, r = u(x), u(y), w / 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)

    # 받침
    d.rounded_rectangle([u(330), u(830), u(694), u(882)],
                        radius=(u(882) - u(830)) / 2, fill=CREAM)
    return img


for name, size, maskable in [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable.png", 512, True),
]:
    img = draw(maskable).resize((size, size), Image.LANCZOS)
    # maskable과 apple-touch-icon은 투명 배경을 싫어한다
    flat = Image.new("RGB", (size, size), GREEN)
    flat.paste(img, (0, 0), img)
    flat.save(OUT / name, "PNG", optimize=True)
    print(f"  {name}  {size}x{size}  {(OUT / name).stat().st_size // 1024}KB")

print(f"\n{OUT} 에 생성 완료")
