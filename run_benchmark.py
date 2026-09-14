#!/usr/bin/env python3
"""
Automated benchmark and verification suite for Qwen3-Coder-Next 80B on Chunkito.
Measures:
1. Resident memory footprint (Weights + KV + Buffers)
2. Prompt Evaluation (PP) tok/s at 1k, 16k, and 64k context
3. Text Generation (TG) decode tok/s
4. Native OpenAI tool-calling adherence (verifying tool_calls structure without backticks)
5. Multi-slot concurrent throughput under 6 parallel streams
"""

import os
import sys
import time
import json
import urllib.request
import urllib.error
import concurrent.futures
import subprocess

BASE_URL = "http://127.0.0.1:11434"

def get_sys_memory():
    out = subprocess.check_output(["free", "-m"]).decode("utf-8")
    lines = out.strip().split("\n")
    # Mem: total used free shared buff/cache available
    parts = lines[1].split()
    return {
        "total_mb": int(parts[1]),
        "used_mb": int(parts[2]),
        "free_mb": int(parts[3]),
        "available_mb": int(parts[6]),
    }

def wait_for_server(timeout=180):
    t0 = time.time()
    print(f"Waiting for llama-server on {BASE_URL} (timeout={timeout}s)...")
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/health", timeout=2) as resp:
                if resp.status == 200:
                    print(f"Server healthy in {time.time() - t0:.1f}s")
                    return True
        except Exception:
            time.sleep(2)
    raise TimeoutError("Server did not become healthy within timeout")

def get_slots():
    req = urllib.request.Request(f"{BASE_URL}/slots")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode())

def get_props():
    req = urllib.request.Request(f"{BASE_URL}/props")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode())

def post_chat(messages, tools=None, max_tokens=128, temperature=0.7):
    payload = {
        "model": "default",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/v1/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as resp:
        duration = time.time() - t0
        body = json.loads(resp.read().decode())
        usage = body.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        content = body["choices"][0]["message"].get("content", "")
        tool_calls = body["choices"][0]["message"].get("tool_calls", [])
        timings = body.get("timings", {})
        return {
            "duration": duration,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "content": content,
            "tool_calls": tool_calls,
            "timings": timings,
            "finish_reason": body["choices"][0].get("finish_reason", "")
        }

def test_tool_calling():
    print("\n--- Testing Native Tool Calling ---")
    tools = [
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file on disk",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Destination file path"},
                        "content": {"type": "string", "description": "Text content"}
                    },
                    "required": ["path", "content"]
                }
            }
        }
    ]
    messages = [
        {"role": "system", "content": "You are a helpful coding agent. When requested to write a file, use the write_file tool directly."},
        {"role": "user", "content": "Please write 'hello world' to /tmp/test.txt"}
    ]
    res = post_chat(messages, tools=tools, max_tokens=128)
    tc = res["tool_calls"]
    has_tc = len(tc) > 0
    fn_name = tc[0].get("function", {}).get("name") if has_tc else None
    fn_args = tc[0].get("function", {}).get("arguments") if has_tc else None
    print(f"Tool calling result: valid={has_tc}, function={fn_name}, args={fn_args}")
    if not has_tc:
        print(f"Content emitted instead:\n{res['content']}")
    return {
        "success": has_tc,
        "function": fn_name,
        "args": fn_args,
        "finish_reason": res["finish_reason"],
        "duration": res["duration"]
    }

def benchmark_single_stream(prompt_tokens_target, gen_tokens=128):
    base_text = "The quick brown fox jumps over the lazy dog. In computer science and artificial intelligence, benchmarks evaluate system throughput. "
    repetitions = (prompt_tokens_target * 4) // len(base_text) + 1
    prompt_text = (base_text * repetitions)[:prompt_tokens_target * 4]

    messages = [
        {"role": "system", "content": "You are a concise assistant. Provide a two sentence summary."},
        {"role": "user", "content": f"Context data:\n{prompt_text}\n\nSummarize key points:"}
    ]
    print(f"\nEvaluating stream: prompt target ~{prompt_tokens_target} tokens, decode {gen_tokens} tokens...")
    res = post_chat(messages, max_tokens=gen_tokens, temperature=0.7)
    timings = res.get("timings", {})
    pp_speed = timings.get("prompt_per_second", 0.0)
    tg_speed = timings.get("predicted_per_second", 0.0)

    print(f"  Prompt tokens: {res['prompt_tokens']} ({pp_speed:.1f} tok/s)")
    print(f"  Decode tokens: {res['completion_tokens']} ({tg_speed:.1f} tok/s)")
    print(f"  Total duration: {res['duration']:.2f}s")
    return {
        "target_prompt_tokens": prompt_tokens_target,
        "actual_prompt_tokens": res["prompt_tokens"],
        "actual_completion_tokens": res["completion_tokens"],
        "pp_tok_s": pp_speed,
        "tg_tok_s": tg_speed,
        "duration_s": res["duration"],
        "finish_reason": res["finish_reason"]
    }

def benchmark_concurrent_streams(num_slots=6, prompt_tokens=2048, gen_tokens=128):
    print(f"\n--- Concurrent Benchmark ({num_slots} parallel streams) ---")
    base_text = "Benchmarking multi-slot concurrency on Strix Halo unified memory architecture. Evaluating KV cache contention and throughput scaling. "
    repetitions = (prompt_tokens * 4) // len(base_text) + 1
    prompt_text = (base_text * repetitions)[:prompt_tokens * 4]

    def send_one(slot_idx):
        messages = [
            {"role": "system", "content": f"You are worker #{slot_idx}. Respond with a brief summary."},
            {"role": "user", "content": f"Task {slot_idx} context:\n{prompt_text}\nSummarize:"}
        ]
        return post_chat(messages, max_tokens=gen_tokens, temperature=0.7)

    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=num_slots) as ex:
        futures = [ex.submit(send_one, i) for i in range(num_slots)]
        results = [f.result() for f in futures]
    wall_clock = time.time() - t0

    total_prompt = sum(r["prompt_tokens"] for r in results)
    total_gen = sum(r["completion_tokens"] for r in results)
    agg_pp = [r["timings"].get("prompt_per_second", 0) for r in results]
    agg_tg = [r["timings"].get("predicted_per_second", 0) for r in results]

    print(f"Concurrent {num_slots} streams completed in {wall_clock:.2f}s")
    print(f"Total prompt tokens: {total_prompt} | Total generated tokens: {total_gen}")
    print(f"Aggregate Generation Throughput: {total_gen / wall_clock:.1f} tok/s (wall clock)")
    print(f"Per-stream decode speeds: {', '.join(f'{x:.1f}' for x in agg_tg)} tok/s")

    return {
        "num_slots": num_slots,
        "wall_clock_s": wall_clock,
        "total_prompt_tokens": total_prompt,
        "total_gen_tokens": total_gen,
        "agg_gen_tok_s": total_gen / wall_clock,
        "per_stream_tg_tok_s": agg_tg,
        "per_stream_pp_tok_s": agg_pp
    }

def run_suite(config_name):
    print(f"==================================================")
    print(f"Starting Benchmark Suite for Config: {config_name}")
    print(f"==================================================")
    wait_for_server()
    mem = get_sys_memory()
    print(f"Host Memory: Used {mem['used_mb'] / 1024:.2f} GB / Total {mem['total_mb'] / 1024:.2f} GB (Avail {mem['available_mb'] / 1024:.2f} GB)")

    slots = get_slots()
    num_slots = len(slots)
    slot_ctx = slots[0].get("n_ctx", 0) if slots else 0
    print(f"Configured Slots: {num_slots} slots @ {slot_ctx} context tokens per slot")

    results = {
        "config_name": config_name,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "slots_count": num_slots,
        "slot_context": slot_ctx,
        "memory_profile": mem,
        "tool_calling": test_tool_calling(),
        "single_stream_benchmarks": []
    }

    # Test prompt eval & decode across context tiers
    for p_len in [1024, 16384, 65536]:
        # Only run 64k if slot context allows
        if slot_ctx >= 65536:
            res = benchmark_single_stream(p_len, gen_tokens=128)
            results["single_stream_benchmarks"].append(res)
        elif p_len <= slot_ctx:
            res = benchmark_single_stream(p_len, gen_tokens=128)
            results["single_stream_benchmarks"].append(res)

    if num_slots > 1:
        results["concurrent_benchmark"] = benchmark_concurrent_streams(num_slots=num_slots, prompt_tokens=2048, gen_tokens=128)

    out_file = f"/home/jagosan/models/qwen3-coder-next/results_{config_name}.json"
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved suite results to {out_file}")
    return results

if __name__ == "__main__":
    cfg = sys.argv[1] if len(sys.argv) > 1 else "default"
    run_suite(cfg)
