#!/usr/bin/env bash
# Production launcher for Qwen3-Coder-Next 80B (Q8_0) on Chunkito ROCm 7.2.4 container.
# 6 slots, 262,144 (262k) native context per slot (total -c 1572864), q8_0 KV.
# Total VRAM footprint: ~105 GiB (model 79 GiB + KV ~19.2 GiB), leaving ~17 GiB headroom on 128GB Strix Halo.
# Chat template: Unsloth/Qwen verified XML function calling format (/models/qwen3-coder-next/template.jinja).
# Sampling guards: --temp 0.7 --top-p 0.8 --top-k 20 --repeat-penalty 1.05 --presence-penalty 0.1 --min-p 0.05.
# IMPORTANT: ROCBLAS_USE_HIPBLASLT is omitted to prevent hipBLASLt NaN generation on hybrid DeltaNet layers.
set -euo pipefail

MODE="${1:-6slot}"
docker rm -f llama-coder-next >/dev/null 2>&1 || true
docker rm -f llama-coder-30b >/dev/null 2>&1 || true
docker stop llama-moe-rocm72 >/dev/null 2>&1 || true
mkdir -p /tmp/slots

if [[ "$MODE" == "single" ]]; then
    echo "Launching Qwen3-Coder-Next 80B (Q8_0) in single-slot configuration (-c 262144 -np 1)..."
    CTX_FLAGS="-c 262144 -np 1"
else
    echo "Launching Qwen3-Coder-Next 80B (Q8_0) in production 6-slot configuration (-c 1572864 -np 6)..."
    CTX_FLAGS="-c 1572864 -np 6"
fi

docker run -d --name llama-coder-next \
  --restart always \
  --network host \
  --ipc host \
  --device /dev/kfd --device /dev/dri \
  -v /home/jagosan/models:/models \
  -v /home/jagosan/llama.cpp:/llama.cpp \
  -v /tmp/slots:/tmp/slots \
  rocm-7.2-builder \
  /llama.cpp/build-rocm-7.2/bin/llama-server \
    -m /models/qwen3-coder-next/Q8_0/Qwen3-Coder-Next-Q8_0-00001-of-00003.gguf \
    --host 0.0.0.0 --port 11434 \
    --jinja \
    --chat-template-file /models/qwen3-coder-next/template.jinja \
    $CTX_FLAGS \
    -ctk q8_0 -ctv q8_0 \
    -ngl 999 -fa on -b 2048 -ub 512 \
    --load-mode none \
    --reasoning off \
    --reasoning-format none \
    --temp 0.7 \
    --top-p 0.8 \
    --top-k 20 \
    --repeat-penalty 1.05 \
    --presence-penalty 0.1 \
    --min-p 0.05 \
    --slot-save-path /tmp/slots \
    --alias qwen3-coder-next:262k,qwen3-coder-next,tigger,qwen3-coder-30b:262k,qwen3-coder-30b:128k,qwen3-coder-30b,qwen3.8-27b

echo "Started llama-coder-next container ($MODE)."
