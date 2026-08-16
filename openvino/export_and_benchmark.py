#!/usr/bin/env python3
"""
OpenVINO 변환 + 벤치마크 — 인텔 하드웨어에서의 추론 성능을 실측한다.
    python openvino/export_and_benchmark.py

왜 별도 폴더인가
────────────────
실제 배포된 앱(브라우저)은 onnxruntime-web(WASM/WebGPU)을 쓴다. 어떤 기기든
브라우저만 있으면 돌아가야 하므로 이 경로는 안 건드린다(models/의 ONNX가 원본,
이미 int8 양자화됨).

이 스크립트는 그걸 건드리지 않고 "별도로" OpenVINO IR을 만들어 인텔 CPU/NPU에서
실측치를 남기는 용도다. 브라우저 배포 경로와는 별개의 참고용 벤치마크다.

⚠️ 공정 비교 주의
──────────────────
models/food-classifier.onnx는 이미 onnxruntime으로 int8 양자화된 파일이라
그걸 그대로 OpenVINO로 변환하면 양자화가 안 살아남는다(OpenVINO는 onnxruntime의
QOperator 양자화 포맷을 온전히 못 읽는다 — 실제로 변환해보니 4.6MB가 아니라
17.5MB로 나왔다, 즉 FP32로 풀려버림). 그래서:
  1. FP32 원본을 새로 내보내(openvino/onnx_fp32/) 공정한 FP32 vs FP32 비교를 하고
  2. OpenVINO 자체 양자화 도구(NNCF)로 따로 압축해 "OpenVINO 최적화판" 성능도 잰다.

출력
────
  openvino/model/food-classifier-fp32.xml/.bin   OpenVINO IR (FP32)
  openvino/model/food-classifier-int8.xml/.bin   OpenVINO IR + NNCF INT8
  openvino/benchmark_result.json                 실측 결과
"""
import json, time, sys, subprocess
from pathlib import Path

import numpy as np
import openvino as ov

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
FP32_ONNX = HERE / 'onnx_fp32' / 'food-classifier.onnx'
META_PATH = HERE / 'onnx_fp32' / 'food-classes.json'
DEPLOYED_ONNX = ROOT / 'models' / 'food-classifier.onnx'   # 참고: 실제 배포판(양자화됨)
OUT_DIR = HERE / 'model'
OUT_DIR.mkdir(parents=True, exist_ok=True)

if not FP32_ONNX.exists():
    print(f'✗ {FP32_ONNX}가 없습니다.')
    print('  먼저: python train/5_export.py --out openvino/onnx_fp32  (--quantize 없이)')
    sys.exit(1)

meta = json.loads(META_PATH.read_text(encoding='utf-8'))
size = meta['img_size']
n_classes = len(meta['classes'])

print('=' * 66)
print(f'OpenVINO 변환 + 벤치마크  ·  입력 {size}x{size}  ·  클래스 {n_classes}개')
print('=' * 66)

# ── 1. FP32 ONNX → OpenVINO IR ──────────────────────────────
t0 = time.time()
fp32_model = ov.convert_model(str(FP32_ONNX))
fp32_xml = OUT_DIR / 'food-classifier-fp32.xml'
ov.save_model(fp32_model, str(fp32_xml))
print(f'\n[1] FP32 → OpenVINO IR 변환 ({time.time()-t0:.1f}초)')
print(f'    {fp32_xml.with_suffix(".bin").stat().st_size/1e6:.1f}MB')

# ── 2. NNCF로 OpenVINO 자체 INT8 압축 ───────────────────────
print('\n[2] NNCF(인텔 양자화 도구)로 가중치 INT8 압축 중...')
import nncf
t0 = time.time()
int8_model = nncf.compress_weights(fp32_model, mode=nncf.CompressWeightsMode.INT8_ASYM)
int8_xml = OUT_DIR / 'food-classifier-int8.xml'
ov.save_model(int8_model, str(int8_xml))
print(f'    완료 ({time.time()-t0:.1f}초)  ·  {int8_xml.with_suffix(".bin").stat().st_size/1e6:.1f}MB')

# ── 3. 사용 가능한 장치 ──────────────────────────────────────
core = ov.Core()
devices = core.available_devices
print(f'\n[3] 이 기기의 OpenVINO 장치: {devices}')
targets = [d for d in devices if d in ('CPU', 'NPU')]
if 'NPU' not in devices:
    print('    · NPU 없음 (Intel Core Ultra 계열 전용) — 이 기기(Xeon)엔 없다. CPU만 벤치마크한다.')

# ── 4. 벤치마크 ──────────────────────────────────────────────
rng = np.random.default_rng(42)
dummy = rng.standard_normal((1, 3, size, size), dtype=np.float32)
N = 50

def bench_ov(model, device, label):
    compiled = core.compile_model(model, device)
    infer = compiled.create_infer_request()
    for _ in range(5):
        infer.infer({0: dummy})
    t0 = time.time()
    for _ in range(N):
        infer.infer({0: dummy})
    ms = (time.time() - t0) / N * 1000
    print(f'    · {label}: 평균 {ms:.2f}ms/장  ·  초당 {1000/ms:.1f}장')
    return ms

def bench_ort(onnx_path, label):
    import onnxruntime as rt
    sess = rt.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    in_name = sess.get_inputs()[0].name
    for _ in range(5):
        sess.run(None, {in_name: dummy})
    t0 = time.time()
    for _ in range(N):
        sess.run(None, {in_name: dummy})
    ms = (time.time() - t0) / N * 1000
    print(f'    · {label}: 평균 {ms:.2f}ms/장  ·  초당 {1000/ms:.1f}장')
    return ms

print(f'\n[4] 추론 벤치마크 (더미 입력, {N}회 반복 평균, 워밍업 5회 제외)')
results = {}
print('  CPU 위:')
results['onnxruntime_fp32_cpu'] = bench_ort(FP32_ONNX, 'onnxruntime FP32 (OpenVINO 없이, 기준선)')
for device in targets:
    name = core.get_property(device, 'FULL_DEVICE_NAME')
    results[f'openvino_fp32_{device}'] = bench_ov(fp32_model, device, f'OpenVINO FP32 on {device} ({name})')
    results[f'openvino_int8_{device}'] = bench_ov(int8_model, device, f'OpenVINO INT8(NNCF) on {device} ({name})')

if DEPLOYED_ONNX.exists():
    print('\n  참고 — 실제 배포판(onnxruntime 자체 int8 양자화, 브라우저에서 쓰는 그 파일):')
    results['deployed_onnxruntime_int8_cpu'] = bench_ort(DEPLOYED_ONNX, '배포판 (models/food-classifier.onnx)')

# ── 5. 요약 ──────────────────────────────────────────────────
print('\n[5] 요약')
base = results.get('onnxruntime_fp32_cpu')
for k, v in results.items():
    if k == 'onnxruntime_fp32_cpu':
        continue
    ratio = base / v if base else None
    tag = f'{ratio:.2f}배 {"빠름" if ratio and ratio > 1 else "느림"}' if ratio else ''
    print(f'    {k}: {v:.2f}ms  (기준 대비 {tag})')

# ── 6. 저장 ──────────────────────────────────────────────────
result_path = HERE / 'benchmark_result.json'
result_path.write_text(json.dumps({
    'cpu_name': core.get_property('CPU', 'FULL_DEVICE_NAME'),
    'available_devices': devices,
    'ms_per_inference': results,
    'input_size': size,
    'note': '더미 입력·50회 평균. 실제 사진은 전처리(리사이즈·정규화) 시간이 추가로 든다. '
            '이 기기(Xeon E3-1230 v5)는 Core Ultra가 아니라 NPU가 없다.'
}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n결과 저장: {result_path}')
print('=' * 66)
