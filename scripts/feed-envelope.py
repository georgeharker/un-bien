#!/usr/bin/env python3
"""Merge a captured rpc stream + a bus-evt log into one {rpc|evt} envelope stream.

Feeds both planes of the rpc-envelope (see docs/rpc-envelope.md) from real
captures, so the app-end reader can be exercised offline before the fork drives
it live over the relay.

  --rpc   capture-rpc.py output (one pi rpc frame per line)  -> {"rpc": frame}
  --evt   bus-logger.ts output  ({"ch","t","data"} per line) -> {"evt": {channel, data}}

Interleave is deterministic (evt distributed proportionally across the rpc
frames); the reducer's final state is interleave-independent (transcript reduces
from rpc order, panels from evt order), so this only needs to be stable.
"""

import argparse
import json


def read_jsonl(path: str) -> list:
    rows = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    print(f"skip bad line in {path}: {exc}")
    except OSError as exc:
        print(f"failed to read {path}: {exc}")
        raise
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", help="rpc capture jsonl (one frame per line)")
    ap.add_argument("--evt", help="bus-logger jsonl ({ch,t,data} per line)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    rpc_frames = read_jsonl(args.rpc) if args.rpc else []
    evt_rows = read_jsonl(args.evt) if args.evt else []

    # Proportional interleave: place evt event i before rpc frame at
    # round(i * N / K). Stable and plausible without per-rpc timestamps.
    n = len(rpc_frames)
    k = len(evt_rows)
    insert_at: dict = {}
    for i, ev in enumerate(evt_rows):
        pos = round(i * n / k) if k else 0
        insert_at.setdefault(pos, []).append(ev)

    out: list = []

    def emit_evt(ev: dict) -> None:
        out.append({"evt": {"channel": ev.get("ch"), "data": ev.get("data")}})

    for idx, frame in enumerate(rpc_frames):
        for ev in insert_at.get(idx, []):
            emit_evt(ev)
        out.append({"rpc": frame})
    for ev in insert_at.get(n, []):  # any trailing evt
        emit_evt(ev)

    try:
        with open(args.out, "w") as f:
            for msg in out:
                f.write(json.dumps(msg, separators=(",", ":")) + "\n")
    except OSError as exc:
        print(f"failed to write {args.out}: {exc}")
        raise

    rpc_n = sum(1 for m in out if "rpc" in m)
    evt_n = sum(1 for m in out if "evt" in m)
    print(
        f"wrote {len(out)} envelope messages ({rpc_n} rpc, {evt_n} evt) -> {args.out}"
    )


if __name__ == "__main__":
    main()
