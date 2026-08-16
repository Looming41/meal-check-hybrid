#!/bin/bash
# 우분투 학습 환경 준비
#   bash train/setup-ubuntu.sh
#
# 하는 일
#   · 필요한 시스템 패키지 설치 (python3-venv, unzip, curl)
#   · 가상환경 생성 — 요즘 우분투는 시스템 파이썬에 pip 설치를 막는다(PEP 668)
#   · GPU 유무를 확인해 맞는 PyTorch를 설치
#   · aihubshell 설치
#   · 전부 잘 됐는지 검증
#
# 여러 번 실행해도 안전합니다.

set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

B=$'\033[1m'; OK=$'\033[32m'; WARN=$'\033[33m'; ERR=$'\033[31m'; DIM=$'\033[2m'; N=$'\033[0m'
line() { printf '%.0s─' {1..64}; echo; }
say()  { echo "  $*"; }

echo
echo "${B}우분투 학습 환경 준비${N}   ${DIM}$ROOT${N}"
line

# ── 1. 시스템 패키지 ────────────────────────────────────────
echo
echo "${B}[1] 시스템 패키지${N}"
NEED=()
for pkg in python3 python3-venv python3-pip unzip curl; do
  case "$pkg" in
    python3) command -v python3 >/dev/null || NEED+=("$pkg") ;;
    python3-venv) python3 -c 'import venv' 2>/dev/null || NEED+=("$pkg") ;;
    python3-pip) command -v pip3 >/dev/null || NEED+=("$pkg") ;;
    *) command -v "$pkg" >/dev/null || NEED+=("$pkg") ;;
  esac
done

if [ ${#NEED[@]} -eq 0 ]; then
  say "${OK}✓${N} 필요한 패키지가 모두 있습니다"
else
  say "설치 필요: ${NEED[*]}"
  say "${DIM}sudo 비밀번호를 물어볼 수 있습니다${N}"
  sudo apt-get update -qq && sudo apt-get install -y "${NEED[@]}" \
    && say "${OK}✓${N} 설치 완료" \
    || { say "${ERR}✗${N} 설치 실패. 수동으로: sudo apt install ${NEED[*]}"; exit 1; }
fi

# ── 2. 디스크 확인 ──────────────────────────────────────────
echo
echo "${B}[2] 디스크${N}"
AVAIL_GB=$(df -BG --output=avail . | tail -1 | tr -dc '0-9')
TOTAL_GB=$(df -BG --output=size . | tail -1 | tr -dc '0-9')
say "여유 ${AVAIL_GB}GB / 전체 ${TOTAL_GB}GB"
say "${DIM}0c_fetch.sh가 조각마다 받고→줄이고→원본삭제 하므로,${N}"
say "${DIM}최종 데이터는 150종 약 6GB · 400종 약 16GB입니다.${N}"

if [ "$AVAIL_GB" -lt 30 ]; then
  say "${ERR}✗${N} 30GB 미만입니다. 이대로는 어렵습니다."
  say "   공간을 비우거나, 150종(79번)만 받으세요."
elif [ "$AVAIL_GB" -lt 80 ]; then
  say "${WARN}⚠${N} 여유가 넉넉하진 않습니다."
  say "   150종(79번)은 문제없습니다. 400종(74번)은 조각을 하나씩만"
  say "   받고 그때그때 확인하세요. 조각 하나가 수십 GB일 수 있습니다."
else
  say "${OK}✓${N} 충분합니다"
fi

# ── 3. GPU 확인 ─────────────────────────────────────────────
echo
echo "${B}[3] GPU${N}"
HAS_GPU=0
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1)
  if [ -n "${GPU_NAME:-}" ]; then
    HAS_GPU=1
    say "${OK}✓${N} $GPU_NAME  ($GPU_MEM)"
  fi
fi
if [ "$HAS_GPU" -eq 0 ]; then
  CORES=$(nproc 2>/dev/null || echo 4)
  CPU_NAME=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
  say "${WARN}⚠${N} NVIDIA GPU 없음 — CPU로 학습합니다"
  [ -n "${CPU_NAME:-}" ] && say "   $CPU_NAME"
  say "   코어 $CORES개"

  # Intel Arc 내장 GPU가 있으면 알려는 준다. 다만 PyTorch에서 쓰려면
  # IPEX 설정이 따로 필요하고 환경을 타므로 기본 경로로 삼지 않는다.
  if command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qi 'VGA.*Intel'; then
    say "   ${DIM}Intel 내장 GPU 감지 — IPEX(XPU)로 가속할 수는 있으나${N}"
    say "   ${DIM}설정이 까다롭고 환경을 탑니다. 우선 CPU로 진행하세요.${N}"
  fi

  say ""
  say "   ${B}현실적인 계획${N}"
  say "   · 150종(79번): 8 epoch에 약 7~11시간 → ${OK}하룻밤이면 됩니다${N}"
  say "   · 400종(74번): 8 epoch에 약 18~28시간 → 하루 이상 켜 둬야 합니다"
  say "   · 중간에 끊겨도 best.pt는 매 epoch 저장되니 잃지 않습니다"
  say "   · 더 빠르게: Colab 무료 GPU가 10배 이상 빠릅니다"
fi

# ── 4. 가상환경 ─────────────────────────────────────────────
echo
echo "${B}[4] 파이썬 가상환경${N}"
VENV="$ROOT/train/.venv"
if [ -d "$VENV" ]; then
  say "${OK}✓${N} 이미 있습니다: train/.venv"
else
  python3 -m venv "$VENV" && say "${OK}✓${N} 만들었습니다: train/.venv" \
    || { say "${ERR}✗${N} 가상환경 생성 실패"; exit 1; }
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install -q --upgrade pip

# ── 5. PyTorch ──────────────────────────────────────────────
echo
echo "${B}[5] PyTorch${N}"
if python -c 'import torch' 2>/dev/null; then
  TV=$(python -c 'import torch; print(torch.__version__)')
  CUDA_OK=$(python -c 'import torch; print(torch.cuda.is_available())')
  say "${OK}✓${N} 이미 설치됨 (torch $TV · CUDA 사용가능=$CUDA_OK)"
else
  if [ "$HAS_GPU" -eq 1 ]; then
    say "CUDA 버전 설치 중… ${DIM}(몇 분 걸립니다)${N}"
    pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cu124 \
      || pip install -q torch torchvision
  else
    say "CPU 버전 설치 중… ${DIM}(몇 분 걸립니다)${N}"
    pip install -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
  fi
  python -c 'import torch' 2>/dev/null \
    && say "${OK}✓${N} 설치 완료" \
    || { say "${ERR}✗${N} PyTorch 설치 실패"; exit 1; }
fi

# ── 6. 나머지 의존성 ────────────────────────────────────────
echo
echo "${B}[6] 나머지 패키지${N}"
pip install -q pillow onnx onnxruntime \
  && say "${OK}✓${N} pillow · onnx · onnxruntime" \
  || say "${WARN}⚠${N} 일부 설치 실패 (5_export.py에서 문제될 수 있음)"

# ── 7. aihubshell ───────────────────────────────────────────
echo
echo "${B}[7] aihubshell${N}"
if command -v aihubshell >/dev/null 2>&1; then
  say "${OK}✓${N} 이미 설치됨: $(command -v aihubshell)"
elif [ -x "$ROOT/train/aihubshell" ]; then
  say "${OK}✓${N} train/aihubshell 에 있습니다"
else
  if curl -fsSL -o "$ROOT/train/aihubshell" "https://api.aihub.or.kr/api/aihubshell.do"; then
    chmod +x "$ROOT/train/aihubshell"
    say "${OK}✓${N} train/aihubshell 에 받았습니다"
    say "${DIM}전역 설치: sudo cp train/aihubshell /usr/local/bin/${N}"
  else
    say "${WARN}⚠${N} 받지 못했습니다. bash train/0_download.sh 로 다시 시도하세요."
  fi
fi

# ── 8. 검증 ─────────────────────────────────────────────────
echo
line
echo "${B}검증${N}"
python - <<'PY'
import sys
ok = True
def chk(name, fn):
    global ok
    try:
        v = fn()
        print(f"  ✓ {name:<22} {v}")
    except Exception as e:
        ok = False
        print(f"  ✗ {name:<22} {e}")

chk("python",      lambda: sys.version.split()[0])
chk("torch",       lambda: __import__('torch').__version__)
chk("torchvision", lambda: __import__('torchvision').__version__)
chk("pillow",      lambda: __import__('PIL').__version__)

import torch
dev = "cuda" if torch.cuda.is_available() else "cpu"
print(f"  · 학습 장치            {dev}")
if dev == "cuda":
    print(f"  · GPU                  {torch.cuda.get_device_name(0)}")

# 앱 음식 테이블이 제자리에 있는지 — 2_prepare.py가 이걸 읽는다
from pathlib import Path
p = Path("data/foods-ko.json")
if p.exists():
    import json
    n = len(json.loads(p.read_text(encoding="utf-8"))["foods"])
    print(f"  ✓ {'음식 테이블':<22} {n}종")
else:
    ok = False
    print("  ✗ data/foods-ko.json 이 없습니다 — 폴더를 통째로 옮겨야 합니다")

sys.exit(0 if ok else 1)
PY
VERIFY=$?

line
if [ $VERIFY -eq 0 ]; then
  cat <<NEXT

${OK}준비 완료${N}

  ${B}앞으로 매번 이걸 먼저 실행하세요${N}
    source train/.venv/bin/activate

  ${B}다음 단계${N}
    1) AI Hub 승인·API키 발급이 아직이면:   bash train/0_download.sh
    2) 파일 목록 확인:                      aihubshell -mode l -datasetkey 74
    3) 조각 받기(받는 즉시 축소·원본삭제):   bash train/0c_fetch.sh <API키> 74 <filekey>
    4) 구조 파악:                           python train/1_inspect.py train/dataset

NEXT
else
  echo
  echo "${ERR}일부 항목이 준비되지 않았습니다.${N} 위 ✗ 표시를 확인하세요."
fi
