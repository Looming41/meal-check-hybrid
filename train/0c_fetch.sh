#!/bin/bash
# 조각씩 받아서 즉시 줄이고 원본을 지우는 반복 다운로드
#   bash train/0c_fetch.sh <API키> <datasetkey> <filekey> [filekey ...]
#
# 왜 이렇게 받나
# ──────────────
# AI Hub 음식 데이터(74번)는 1.6TB다. 통째로 받으려면 디스크가 1.6TB 있어야 한다.
# 그런데 학습에 실제로 필요한 건 512px로 줄인 이미지 약 16GB뿐이다.
#
# 그래서 한 조각씩 받아서 → 압축 풀고 → 512px로 줄이고 → 원본을 지운다.
# 이러면 **디스크가 조각 하나 크기 이상 차지 않는다.**
#
# 먼저 파일 목록을 봐야 filekey를 알 수 있다:
#   aihubshell -mode l -datasetkey 74
# 출력이 [파일명 | 용량 | filekey] 형식이다. 원하는 것의 filekey를 골라 쓴다.

set -u
cd "$(dirname "$0")/.." || exit 1

BOLD=$'\033[1m'; DIM=$'\033[2m'; OK=$'\033[32m'; ERR=$'\033[31m'; OFF=$'\033[0m'

if [ $# -lt 3 ]; then
  cat <<USAGE
${BOLD}사용법${OFF}
  bash train/0c_fetch.sh <API키> <datasetkey> <filekey> [filekey ...]

${BOLD}먼저 파일 목록 보기${OFF}
  aihubshell -mode l -datasetkey 74

  출력이 [파일명 | 용량 | filekey] 형식입니다.
  Validation 쪽이 보통 훨씬 작으니 그것부터 받아 보세요.

${BOLD}예시${OFF}
  # 조각 하나만
  bash train/0c_fetch.sh \$KEY 74 51937

  # 여러 개 (순서대로 받고 줄이고 지웁니다)
  bash train/0c_fetch.sh \$KEY 74 51937 51938 51939

${BOLD}결과${OFF}
  train/dataset/ 에 512px로 줄인 이미지가 폴더 구조 그대로 쌓입니다.
  다 받은 뒤: python train/1_inspect.py train/dataset
USAGE
  exit 1
fi

APIKEY="$1"; DATASETKEY="$2"; shift 2
FILEKEYS=("$@")

WORK="train/_work"        # 압축 푸는 임시 공간. 조각마다 비운다.
DEST="train/dataset"      # 줄인 이미지가 최종적으로 쌓이는 곳
SIZE=512

AIHUB="$(command -v aihubshell || echo ./train/aihubshell)"
if [ ! -x "$AIHUB" ] && ! command -v aihubshell >/dev/null 2>&1; then
  echo "${ERR}✗${OFF} aihubshell이 없습니다. 먼저 bash train/0_download.sh 를 실행하세요."
  exit 1
fi

mkdir -p "$DEST"
echo
echo "${BOLD}조각 ${#FILEKEYS[@]}개 받기${OFF}  ·  datasetkey=$DATASETKEY  ·  ${SIZE}px로 축소"
printf '%.0s─' {1..64}; echo

for i in "${!FILEKEYS[@]}"; do
  FK="${FILEKEYS[$i]}"
  echo
  echo "${BOLD}[$((i+1))/${#FILEKEYS[@]}] filekey=$FK${OFF}"

  rm -rf "$WORK"; mkdir -p "$WORK"

  # 1) 받기
  echo "  받는 중…"
  if ! (cd "$WORK" && "$AIHUB" -aihubapikey "$APIKEY" \
        -mode d -datasetkey "$DATASETKEY" -filekey "$FK"); then
    echo "  ${ERR}✗${OFF} 다운로드 실패 (승인 여부와 filekey를 확인하세요). 건너뜁니다."
    continue
  fi

  # 2) 압축 풀기 — zip/tar가 섞여 오고, 여러 겹인 경우도 있다
  echo "  압축 푸는 중…"
  for pass in 1 2; do
    find "$WORK" -type f \( -name '*.zip' -o -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' \) |
    while read -r arch; do
      case "$arch" in
        *.zip)             unzip -qq -o "$arch" -d "$(dirname "$arch")" 2>/dev/null ;;
        *.tar)             tar -xf "$arch" -C "$(dirname "$arch")" 2>/dev/null ;;
        *.tar.gz|*.tgz)    tar -xzf "$arch" -C "$(dirname "$arch")" 2>/dev/null ;;
      esac
      rm -f "$arch"
    done
  done

  # 3) 줄이고 원본 삭제 — 여기서 용량이 100분의 1이 된다
  echo "  줄이는 중…"
  python3 train/0b_shrink.py "$WORK" "$DEST" --size "$SIZE" --delete

  # 4) 임시 공간 완전히 비우기
  rm -rf "$WORK"

  USED=$(du -sh "$DEST" 2>/dev/null | cut -f1)
  echo "  ${OK}✓${OFF} 누적 ${USED}"
done

rm -rf "$WORK"
echo
printf '%.0s─' {1..64}; echo
echo "${BOLD}완료${OFF}  ·  $DEST  ·  $(du -sh "$DEST" 2>/dev/null | cut -f1)"
echo "  이미지 $(find "$DEST" -type f -name '*.jpg' | wc -l | tr -d ' ')장"
echo
echo "다음: python train/1_inspect.py $DEST"
echo
