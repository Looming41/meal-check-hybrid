#!/bin/bash
# 밥상 판정 — 더블클릭하면 웹서버를 띄우고 브라우저를 엽니다.
#
# file://로 직접 열면 사진 인식(기기에서 인식)이 브라우저에 막힙니다.
# 이 스크립트는 로컬 웹서버를 띄워 그 제약을 없앱니다.
#
# 처음 실행할 때 macOS가 "확인되지 않은 개발자" 경고를 띄우면
# 파일을 우클릭 → 열기 를 한 번 해 주세요.

cd "$(dirname "$0")" || exit 1

PORT=8000
# 포트가 이미 쓰이고 있으면 비어 있는 포트를 찾는다
while lsof -i :$PORT >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if [ $PORT -gt 8020 ]; then
    echo "빈 포트를 찾지 못했습니다. 실행 중인 서버를 끄고 다시 시도하세요."
    read -r -p "엔터를 누르면 닫힙니다..."
    exit 1
  fi
done

# 빌드 산출물이 없으면 만든다
if [ ! -f dist/index.html ]; then
  echo "빌드 파일이 없어 새로 만듭니다..."
  if command -v node >/dev/null 2>&1; then
    node build.mjs || { echo "빌드 실패"; read -r -p "엔터..."; exit 1; }
  else
    echo "Node.js가 없어 빌드할 수 없습니다."
    echo "개발용 폴더를 그대로 띄웁니다 (사진 인식 가능)."
  fi
fi

# dist가 있으면 그걸, 없으면 소스 폴더를 띄운다
if [ -f dist/index.html ]; then
  ROOT="dist"
else
  ROOT="."
fi

URL="http://localhost:$PORT/"

# 같은 와이파이의 폰에서 접속할 수 있게 이 컴퓨터의 LAN 주소를 찾는다.
# 모바일 레이아웃은 실제 폰에서만 확인할 수 있으므로 이 주소가 필요하다.
LAN_IP=""
if command -v ipconfig >/dev/null 2>&1; then            # macOS
  for IF in en0 en1 en2; do
    IP=$(ipconfig getifaddr "$IF" 2>/dev/null)
    [ -n "$IP" ] && { LAN_IP="$IP"; break; }
  done
fi
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then   # 리눅스 등
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

echo "──────────────────────────────────────────"
echo "  밥상 판정 실행 중"
echo ""
echo "  이 컴퓨터:  $URL"
if [ -n "$LAN_IP" ]; then
  echo "  폰·태블릿:  http://$LAN_IP:$PORT/"
  echo ""
  echo "  ※ 폰이 같은 와이파이에 있어야 합니다."
  echo "    폰 브라우저 주소창에 위 주소를 직접 입력하세요."
  echo "    모바일 레이아웃은 이렇게만 확인할 수 있습니다."
else
  echo "  (LAN 주소를 찾지 못했습니다. 폰 접속은 어려울 수 있습니다)"
fi
echo ""
echo "  ※ 이 창을 닫으면 서버가 꺼집니다. 끄려면 Control+C."
echo "──────────────────────────────────────────"
echo ""

# 서버가 뜰 시간을 잠깐 준 뒤 브라우저를 연다
( sleep 1; open "$URL" 2>/dev/null ) &

# 0.0.0.0으로 바인딩해야 폰에서도 접속된다 (기본값은 로컬 전용)
cd "$ROOT" && python3 -m http.server "$PORT" --bind 0.0.0.0
