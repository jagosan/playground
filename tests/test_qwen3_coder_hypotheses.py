import json
import time
import urllib.request

ENDPOINT = "http://100.71.183.123:11434/v1/chat/completions"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file, completely replacing existing content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to write"},
                    "content": {"type": "string", "description": "Complete content to write to the file"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file with line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to read"}
                },
                "required": ["path"]
            }
        }
    }
]

def query_model(messages, tools=None, max_tokens=1000, temperature=0.2):
    payload = {
        "model": "qwen3-coder-30b-a3b",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(ENDPOINT, data=data, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as resp:
        res = json.loads(resp.read().decode('utf-8'))
    t1 = time.perf_counter()
    duration = t1 - t0
    usage = res.get("usage", {})
    choice = res["choices"][0]
    return choice, usage, duration

print("=== STARTING EMPIRICAL VALIDATION SUITE ===")

# -------------------------------------------------------------
# TEST 1: Native tool calling with tool schema (Atomic Prompt)
# -------------------------------------------------------------
print("\n--- TEST 1: Native Tool Calling (Atomic Prompt) ---")
messages_t1 = [
    {"role": "system", "content": "You are a coding assistant. Use the provided tools to perform actions."},
    {"role": "user", "content": "Please write a test file at 'tests/sample.ts' with the content 'export const a = 42;' using write_file."}
]
choice, usage, dur = query_model(messages_t1, tools=TOOLS)
tool_calls = choice["message"].get("tool_calls")
content = choice["message"].get("content")
print(f"Duration: {dur:.2f}s | Prompt tokens: {usage.get('prompt_tokens')} | Completion tokens: {usage.get('completion_tokens')} | Speed: {usage.get('completion_tokens', 0)/max(0.001, dur):.1f} tok/s")
if tool_calls:
    print(f"SUCCESS: Emitted {len(tool_calls)} native tool call(s):")
    for tc in tool_calls:
        print(f"  Tool: {tc['function']['name']}, Args: {tc['function']['arguments'][:80]}...")
else:
    print(f"FAIL: No tool calls emitted. Output was text:\n{content[:200]}")

# -------------------------------------------------------------
# TEST 2: Code Block in Prompt Context (Checking Markdown Bias)
# -------------------------------------------------------------
print("\n--- TEST 2: Prompt Context with Embedded Code Block ---")
messages_t2 = [
    {"role": "system", "content": "You are a coding assistant. Use the provided tools to perform actions."},
    {"role": "user", "content": """Here is an existing implementation:
```typescript
export interface Rover {
  id: string;
  speed: number;
}
export function getSpeed(r: Rover): number {
  return r.speed;
}
```
Now please create 'src/rover-helper.ts' with an updated implementation that adds a clamp method, using write_file."""}
]
choice, usage, dur = query_model(messages_t2, tools=TOOLS)
tool_calls = choice["message"].get("tool_calls")
content = choice["message"].get("content")
print(f"Duration: {dur:.2f}s | Prompt tokens: {usage.get('prompt_tokens')} | Completion tokens: {usage.get('completion_tokens')} | Speed: {usage.get('completion_tokens', 0)/max(0.001, dur):.1f} tok/s")
if tool_calls:
    print(f"SUCCESS: Emitted native tool call despite embedded code block:")
    for tc in tool_calls:
        print(f"  Tool: {tc['function']['name']}, Args: {tc['function']['arguments'][:80]}...")
else:
    print(f"FAIL / TEXT: Output was:\n{content[:300]}")

# -------------------------------------------------------------
# TEST 3: Broad Architectural Prompt (Testing Refusal vs Execution)
# -------------------------------------------------------------
print("\n--- TEST 3: Broad Architectural Prompt ---")
messages_t3 = [
    {"role": "system", "content": "You are a software engineering assistant."},
    {"role": "user", "content": """We need to implement a full lunar rover competition subsystem with rival NPC AI, realistic rover-to-rover inelastic impulse collision physics, faction bases, and a wave management system per the architectural specifications. Please explain your architectural approach and design the core interfaces."""}
]
choice, usage, dur = query_model(messages_t3, tools=None, max_tokens=600)
content = choice["message"].get("content")
print(f"Duration: {dur:.2f}s | Prompt tokens: {usage.get('prompt_tokens')} | Completion tokens: {usage.get('completion_tokens')} | Speed: {usage.get('completion_tokens', 0)/max(0.001, dur):.1f} tok/s")
is_refusal = "beyond my" in content.lower() or "cannot fulfill" in content.lower() or "not capable" in content.lower()
print(f"Refusal detected: {is_refusal}")
print(f"Sample response:\n{content[:300]}...")

# -------------------------------------------------------------
# TEST 4: Context Scaling (4k, 16k, 32k, 64k, 128k)
# -------------------------------------------------------------
print("\n--- TEST 4: Context Window Scaling & Speed Benchmark ---")
filler_sentence = "The Apollo Lunar Roving Vehicle was an electric vehicle designed to operate in the low-gravity vacuum of the Moon. "
# ~20 tokens per repeat

test_ctx_targets = [1000, 8000, 24000, 60000, 110000]

for target_tok in test_ctx_targets:
    num_repeats = target_tok // 20
    large_context = (filler_sentence * num_repeats) + "\n\nKey Secret Code: LUNAR-ALPHA-7749.\n"
    messages_t4 = [
        {"role": "system", "content": "You are an analytical assistant."},
        {"role": "user", "content": f"Document data:\n{large_context}\nQuestion: What is the Key Secret Code mentioned in the document? Respond with only the code and tool call write_file to save it to 'output.txt'."}
    ]
    try:
        t_start = time.perf_counter()
        choice, usage, dur = query_model(messages_t4, tools=TOOLS, max_tokens=150)
        t_end = time.perf_counter()
        prompt_tokens = usage.get('prompt_tokens', 0)
        comp_tokens = usage.get('completion_tokens', 0)
        tool_calls = choice["message"].get("tool_calls")
        content = choice["message"].get("content") or ""
        tc_name = tool_calls[0]['function']['name'] if tool_calls else "none"
        tc_args = tool_calls[0]['function']['arguments'] if tool_calls else ""
        print(f"Target: ~{target_tok} tokens -> Actual Prompt: {prompt_tokens} tokens | Comp: {comp_tokens} tokens | Latency: {dur:.2f}s | Prompt Eval: {prompt_tokens/max(0.001, dur):.1f} tok/s | TC: {tc_name} | Found: {'LUNAR-ALPHA-7749' in (content + tc_args)}")
    except Exception as e:
        print(f"Target: ~{target_tok} tokens -> ERROR: {e}")

print("\n=== VALIDATION SUITE COMPLETE ===")
