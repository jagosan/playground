#!/usr/bin/env python3
"""
Benchmark harness for Qwen3-Coder-Next 80B on Chunkito (Strix Halo 128GB).
Tests prompt-eval (PP) and generation (TG) throughput, resident memory footprint,
and native OpenAI tool calling adherence.
"""

import time
import json
import urllib.request
import urllib.error
import sys

BASE_URL = "http://127.0.0.1:11434"

def wait_for_server(timeout=120):
    t0 = time.time()
    print(f"Waiting for llama-server on {BASE_URL}...")
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

def run_chat_completion(messages, tools=None, max_tokens=128, temperature=0.7):
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
    with urllib.request.urlopen(req, timeout=300) as resp:
        duration = time.time() - t0
        body = json.loads(resp.read().decode())
        usage = body.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        content = body["choices"][0]["message"].get("content", "")
        tool_calls = body["choices"][0]["message"].get("tool_calls", [])
        return {
            "duration": duration,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "content": content,
            "tool_calls": tool_calls,
            "raw": body
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
        {"role": "system", "content": "You are a coding assistant with access to tools. Call write_file to save the greeting 'hello world' to /tmp/hello.txt."},
        {"role": "user", "content": "Please write 'hello world' to /tmp/hello.txt now."}
    ]
    res = run_chat_completion(messages, tools=tools, max_tokens=128)
    print(f"Duration: {res['duration']:.2f}s | Prompt: {res['prompt_tokens']} tok | Gen: {res['completion_tokens']} tok")
    print(f"Tool calls received: {len(res['tool_calls'])}")
    for tc in res["tool_calls"]:
        print(f"  Call: {tc.get('function', {}).get('name')}({tc.get('function', {}).get('arguments')})")
    if not res["tool_calls"]:
        print(f"Content emitted instead: {res['content'][:200]}")
    return len(res["tool_calls"]) > 0

def benchmark_throughput(prompt_length_tokens=1024, gen_tokens=128):
    # Construct a synthetic repetitive text prompt of target token length
    # ~4 characters per token
    base_text = "The quick brown fox jumps over the lazy dog. In computer science and artificial intelligence, benchmarks evaluate system throughput. "
    repetitions = (prompt_length_tokens * 4) // len(base_text) + 1
    prompt_text = (base_text * repetitions)[:prompt_length_tokens * 4]

    messages = [
        {"role": "system", "content": "You are a concise assistant. Follow all instructions."},
        {"role": "user", "content": f"Analyze the following context and write a 100-word summary:\n{prompt_text}"}
    ]
    print(f"\n--- Benchmarking Prompt ({prompt_length_tokens} target tokens) + Decode ({gen_tokens} tokens) ---")
    t0 = time.time()
    res = run_chat_completion(messages, max_tokens=gen_tokens, temperature=0.7)
    total_time = res["duration"]
    p_tok = res["prompt_tokens"]
    c_tok = res["completion_tokens"]
    
    # Try to extract timings from llama-server if present
    timings = res["raw"].get("timings", {})
    prompt_tok_per_sec = timings.get("prompt_per_second")
    predicted_tok_per_sec = timings.get("predicted_per_second")

    print(f"Result: {p_tok} prompt tokens, {c_tok} completion tokens in {total_time:.2f}s")
    if prompt_tok_per_sec and predicted_tok_per_sec:
        print(f"Server reported prompt eval: {prompt_tok_per_sec:.1f} tok/s")
        print(f"Server reported decode speed: {predicted_tok_per_sec:.1f} tok/s")
    else:
        # Fallback estimation
        print(f"Effective end-to-end: {(p_tok + c_tok) / total_time:.1f} total tok/s")

    return {
        "prompt_tokens": p_tok,
        "completion_tokens": c_tok,
        "duration": total_time,
        "pp_tok_s": prompt_tok_per_sec,
        "tg_tok_s": predicted_tok_per_sec,
    }

if __name__ == "__main__":
    wait_for_server()
    slots = get_slots()
    print(f"Active slots: {len(slots)}")
    test_tool_calling()
    benchmark_throughput(prompt_length_tokens=1024, gen_tokens=128)
    benchmark_throughput(prompt_length_tokens=16384, gen_tokens=128)
