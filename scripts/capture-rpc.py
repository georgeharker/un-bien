#!/usr/bin/env python3
"""Drive `pi --mode rpc` through a scenario and capture the raw frame stream.

Reusable fixture generator for the rpc-envelope conformance harness. Sends a
list of commands, auto-responds to blocking extension_ui dialogs (so an ask
round-trip is captured, not hung), waits for the turn to settle, then sends any
post-settle commands (e.g. get_entries) and records every frame as JSONL.

NOTE: plan + live subagents are in-process BUS events (the fork's {evt} plane),
NOT rpc stdout frames — they will NOT appear here. This captures the rpc plane:
messages, streaming deltas, tool_execution, extension_ui, entry_appended.

Usage:
  scripts/capture-rpc.py --out fixture.jsonl [--cwd DIR] [--prompt TEXT]
                         [--idle 6] [--max 120] [--session]
Zero LLM cost for the non-prompt scenario; a --prompt triggers one real turn.
"""

import argparse
import contextlib
import json
import os
import queue
import subprocess
import threading
import time
from collections import Counter


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--prompt", default=None, help="if set, send one prompt turn")
    ap.add_argument(
        "--idle",
        type=float,
        default=6.0,
        help="exit after this many idle seconds post-settle",
    )
    ap.add_argument("--max", type=float, default=120.0, help="hard cap seconds")
    ap.add_argument(
        "--session",
        action="store_true",
        help="allow session persistence (default --no-session)",
    )
    ap.add_argument(
        "--no-extensions",
        action="store_true",
        help="disable extension discovery; only --ext paths load",
    )
    ap.add_argument(
        "--ext",
        action="append",
        default=[],
        help="load only this extension path (repeatable) for a controlled capture",
    )
    args = ap.parse_args()

    pre = [{"type": "get_state", "id": "s1"}]
    if args.prompt is not None:
        pre.append({"type": "prompt", "message": args.prompt, "id": "p1"})
    post = [{"type": "get_entries", "id": "e1"}, {"type": "get_state", "id": "s2"}]
    needs_settle = args.prompt is not None

    cmd = ["pi", "--mode", "rpc"] + ([] if args.session else ["--no-session"])
    if args.no_extensions:
        cmd.append("--no-extensions")
    for ext in args.ext:
        cmd += ["-e", ext]
    proc = subprocess.Popen(
        cmd,
        cwd=args.cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    frames: list = []
    q: queue.Queue = queue.Queue()

    def reader() -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line.endswith("\r"):
                line = line[:-1]
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            frames.append(o)
            q.put(o)

    threading.Thread(target=reader, daemon=True).start()

    def send(c: dict) -> None:
        if proc.stdin is None:
            return
        proc.stdin.write(json.dumps(c) + "\n")
        proc.stdin.flush()

    for c in pre:
        send(c)
        time.sleep(0.1)

    settled = not needs_settle
    post_sent = False
    last = time.time()
    start = time.time()
    while True:
        try:
            o = q.get(timeout=0.5)
            last = time.time()
            if o.get("type") == "extension_ui_request" and o.get("method") in (
                "select",
                "confirm",
                "input",
                "editor",
            ):
                resp = {"type": "extension_ui_response", "id": o["id"]}
                m = o["method"]
                if m == "confirm":
                    resp["confirmed"] = True
                elif m == "select":
                    resp["value"] = (o.get("options") or ["ok"])[0]
                else:
                    resp["value"] = "fixture-response"
                send(resp)
            if o.get("type") == "agent_settled":
                settled = True
        except queue.Empty:
            pass
        if settled and not post_sent:
            for c in post:
                send(c)
                time.sleep(0.1)
            post_sent = True
            last = time.time()
        if post_sent and (time.time() - last) > args.idle:
            break
        if (time.time() - start) > args.max:
            break

    with contextlib.suppress(BrokenPipeError, ValueError, OSError):
        if proc.stdin is not None:
            proc.stdin.close()
    proc.terminate()

    try:
        with open(args.out, "w") as f:
            for o in frames:
                f.write(json.dumps(o, separators=(",", ":")) + "\n")
    except OSError as exc:
        print(f"failed to write {args.out}: {exc}")
        raise

    print(f"captured {len(frames)} frames -> {args.out}")
    counts = Counter(
        (o.get("type"), o.get("command") or o.get("method") or "") for o in frames
    )
    for (t, sub), n in counts.most_common():
        print(f"  {n:3d}  {t} {sub}")


if __name__ == "__main__":
    main()
