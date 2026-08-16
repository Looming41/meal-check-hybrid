#!/bin/bash
# Core Ultra(우분투)에서 OpenVINO 벤치마크 한 번에 돌리기
#   cd openvino && ./setup_and_run.sh
set -e
cd "$(dirname "$0")"

echo "── 1. 가상환경 준비 ──"
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate

echo "── 2. 의존성 설치 ──"
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo "── 3. 기존 결과(Xeon 것) 보존 ──"
if [ -f benchmark_result.json ] && [ ! -f benchmark_result_xeon.json ]; then
  cp benchmark_result.json benchmark_result_xeon.json
  echo "  기존 benchmark_result.json → benchmark_result_xeon.json 으로 백업했습니다."
fi

echo "── 4. 실행 ──"
python export_and_benchmark.py

echo "── 5. 이 기기(NPU 있는 쪽) 결과 따로 저장 ──"
cp benchmark_result.json benchmark_result_coreultra.json
echo "  benchmark_result_coreultra.json 에도 저장했습니다."
echo ""
echo "완료. benchmark_result_coreultra.json 내용을 복사해서 알려주세요."
