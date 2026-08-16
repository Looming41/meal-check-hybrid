# OpenVINO 벤치마크 (인텔 대회용 별도 트랙)

## ▶ 지금 우분투(Core Ultra)에서 바로 실행하기

USB에서 이 폴더를 통째로 복사한 뒤, 터미널에서:

```bash
cd openvino                       # 이 README가 있는 폴더로 이동
chmod +x setup_and_run.sh
./setup_and_run.sh
```

한 번에 (가상환경 생성 → 의존성 설치 → 실행)까지 됩니다. 끝나면
`[3] 이 기기의 OpenVINO 장치` 줄에 `NPU`가 뜨는지부터 확인하세요.
안 뜨면 인텔 NPU 드라이버(OpenVINO NPU 플러그인)가 없는 것이니 알려주세요.

실행 다 되면 `benchmark_result.json`을 열어서 내용을 그대로 복사해 붙여주시면 됩니다.

수동으로 하고 싶으면 아래 "직접 실행" 절 참고.

---

**주의**: 이 폴더는 실제 배포된 앱과 무관하다. 브라우저에 나가는 모델은 여전히
`models/food-classifier.onnx`(onnxruntime-web으로 실행)이고, 이 폴더는 그걸
건드리지 않는다. 여기 있는 건 "인텔 하드웨어에서 이 모델이 얼마나 빠른가"를
실측해서 별도로 남겨두는 참고 자료다.

## 지금까지 한 것 (2026-08-13, Xeon E3-1230 v5 · GPU 없이 CPU만)

```
onnxruntime FP32 (기준):          12.41ms/장
OpenVINO FP32:                    15.88ms/장  (0.78배 — 이 CPU에선 더 느림)
OpenVINO INT8, NNCF 압축:         16.29ms/장  (0.76배 — 역시 더 느림, 크기만 줄어듦 8.8MB→4.5MB)
```

**정직하게 말하면**: 이 CPU(2015년산 Xeon)는 OpenVINO 가속 커널이 쓰는
AVX-512/VNNI 명령어셋이 없어서 OpenVINO를 써도 별 이득이 없다. 크기만 줄고
속도는 오히려 밀린다. 자세한 원인·해석은 `benchmark_result.json`과 대화 기록 참조.

## NPU 결과 — 아직 없음 (측정 대기)

Intel Core Ultra 5 125H(우분투 기기)엔 NPU가 있어서 여기와 다른 결과가 나올
가능성이 높다(NPU가 CPU보다 3~5배 빠르다는 게 인텔 자료 기준). **그 기기가 지금
부팅이 안 돼서 아직 못 쟀다.** 숫자를 지어내지 않았으니, 기기 살아나면 아래대로
돌려서 채워 넣을 것.

## 직접 실행 (setup_and_run.sh 없이 수동으로)

```bash
cd openvino
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python export_and_benchmark.py
```

## 결과 저장 — 덮어쓰지 말 것

`benchmark_result.json`은 이미 Xeon 결과가 들어있는 파일이다. 우분투에서 돌리면
같은 이름으로 새로 생기므로, 실행 전에 미리 백업하거나 실행 후 바로
`mv benchmark_result.json benchmark_result_coreultra.json`으로 이름을 바꿔서
Xeon 결과 옆에 나란히 남겨둘 것 — "Xeon에선 이득 없었는데 NPU에선 이렇게
빨라졌다"는 대비 자체가 자료로서 가치가 있다.
