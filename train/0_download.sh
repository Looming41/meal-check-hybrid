#!/bin/bash
# 0단계 — AI Hub 데이터 받기 도우미
#   bash train/0_download.sh
#
# AI Hub는 브라우저로 내려받지 않습니다. 승인을 받은 뒤 전용 CLI(aihubshell)로 받습니다.
# 이 스크립트는 CLI 설치와 사용법 안내까지 해 줍니다.
# 회원가입·활용신청·승인은 사람이 해야 하므로 그 부분은 안내만 합니다.

set -u
cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'; DIM=$'\033[2m'; OK=$'\033[32m'; WARN=$'\033[33m'; OFF=$'\033[0m'
line() { printf '%.0s─' {1..64}; echo; }

echo
echo "${BOLD}AI Hub 데이터 받기${OFF}"
line

# ── 1. 사람이 해야 하는 부분 ────────────────────────────────
cat <<'GUIDE'

  [사람이 먼저 해야 할 일]

  1) 회원가입          https://aihub.or.kr
     · 개인/학생으로 가입하면 됩니다. 무료입니다.

  2) 데이터셋 활용신청
     아래 중 하나를 골라 페이지에서 "데이터 다운로드" 버튼을 누릅니다.
     활용 목적을 적으라고 하면 "개인 학습용 / 음식 이미지 분류 모델 연구" 정도면 됩니다.

     ★ 음식 이미지 및 영양정보 텍스트  (400종 · 84만장 · 영양정보 포함 — 1순위)
       https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=74

       한국 이미지(음식)  (150종 · 종당 1000장 — 가볍게 시작할 때)
       https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=79

       건강관리를 위한 음식 이미지  (약 500종)
       https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=242

     ⚠️ 승인까지 시간이 걸립니다(보통 하루 이내, 길면 며칠).
        승인 전에는 이 스크립트로도 받을 수 없습니다.

  3) API Key 발급
     마이페이지에서 "API Key 발급"을 누르면 등록한 이메일로 키가 옵니다.

GUIDE

line
read -r -p "위 1~3을 마치셨나요? (y/N) " done_steps
case "$done_steps" in
  [yY]*) ;;
  *) echo; echo "  먼저 위 세 가지를 마치고 다시 실행하세요."; exit 0 ;;
esac

# ── 2. aihubshell 설치 ──────────────────────────────────────
echo
echo "${BOLD}[1] aihubshell 설치${OFF}"

if command -v aihubshell >/dev/null 2>&1; then
  echo "  ${OK}✓${OFF} 이미 설치돼 있습니다: $(command -v aihubshell)"
else
  echo "  내려받는 중…"
  if ! curl -fsSL -o aihubshell "https://api.aihub.or.kr/api/aihubshell.do"; then
    echo "  ✗ 내려받기 실패. 인터넷 연결을 확인하세요."
    exit 1
  fi
  chmod +x aihubshell
  echo "  ${OK}✓${OFF} train/aihubshell 에 받았습니다."
  echo "  ${DIM}전역으로 쓰려면: sudo mv aihubshell /usr/local/bin/${OFF}"
fi

AIHUB="$(command -v aihubshell || echo ./aihubshell)"

# ── 3. 사용법 확인 ──────────────────────────────────────────
echo
echo "${BOLD}[2] 사용법${OFF}"
echo "  ${DIM}aihubshell의 옵션은 버전에 따라 다릅니다. 실제 도움말을 띄웁니다.${OFF}"
line
"$AIHUB" -help 2>&1 | head -40
line

# ── 4. 다음 단계 안내 ───────────────────────────────────────
cat <<GUIDE

${BOLD}[3] 실제 다운로드${OFF}

  위 도움말에 나온 형식대로 실행합니다. 보통 이런 모양입니다.

    ${AIHUB} -mode l                       ${DIM}# 받을 수 있는 데이터셋 목록${OFF}
    ${AIHUB} -aihubapikey <발급받은키> \\
             -mode d -datasetkey 74        ${DIM}# 74번 데이터셋 받기${OFF}

  ${WARN}주의${OFF}
   · 84만 장짜리는 수십 GB입니다. 디스크 여유와 시간을 확보하세요.
   · 먼저 작은 것(79번, 150종)으로 파이프라인을 한 바퀴 돌려 보고
     잘 되면 큰 것을 받는 편이 안전합니다.
   · 받은 뒤 압축을 풀어야 합니다. 보통 여러 개의 zip/tar로 쪼개져 옵니다.

${BOLD}[4] 받은 다음${OFF}

    python train/1_inspect.py <압축푼폴더>

  구조를 읽어 클래스가 어디 있는지 알려 줍니다.
  그 결과를 보고 2_prepare.py 설정을 정합니다.

GUIDE
