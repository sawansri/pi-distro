"""Sums assistant usage in a pi --mode json event stream: python3 -I tokens.py <events.jsonl>."""
import json, sys

inp = out = 0
for line in open(sys.argv[1], errors="replace"):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    message = event.get("message") or {}
    if event.get("type") == "message_end" and message.get("role") == "assistant":
        usage = message.get("usage") or {}
        inp += usage.get("input", 0) + usage.get("cacheRead", 0)
        out += usage.get("output", 0)
print(f"in={inp}\tout={out}")
