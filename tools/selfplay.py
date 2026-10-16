#!/usr/bin/env python3
"""Play a whole QUARRY match through the public API and report the result.

This is the end-to-end smoke test for a running server: it drives N seats over HTTP,
lets any remaining seats be filled by server bots, and plays the match to completion.

  python3 tools/selfplay.py --url http://127.0.0.1:8770 --seats 2 --bots 2 --difficulty hard
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sample-bot"))
from agent_bot import call, choose_move, name_of  # noqa: E402  (same repository)


def main() -> int:
    parser = argparse.ArgumentParser(description="Drive every seat of a QUARRY match over HTTP.")
    parser.add_argument("--url", default="http://127.0.0.1:8770")
    parser.add_argument("--seats", type=int, default=2, help="agent-driven seats (1-4)")
    parser.add_argument("--bots", type=int, default=2, help="server bots to seat as well")
    parser.add_argument("--difficulty", default="hard", choices=("easy", "medium", "hard", "brutal"))
    parser.add_argument("--max-seconds", type=float, default=180.0)
    args = parser.parse_args()

    base = args.url.rstrip("/")
    seats = max(1, min(4, args.seats))
    bots = max(0, min(4 - seats, args.bots))

    health = call(f"{base}/api/health")
    print(f"server healthy, {health.get('rooms', 0)} room(s) in memory")

    first = call(f"{base}/api/rooms", {"name": "Agent 1", "difficulty": args.difficulty})
    code, tokens, seat_ids = first["code"], {first["seat"]: first["token"]}, [first["seat"]]
    print(f"room {code} created on seat 1")
    for index in range(2, seats + 1):
        joined = call(f"{base}/api/rooms/{code}/join", {"name": f"Agent {index}"})
        tokens[joined["seat"]] = joined["token"]
        seat_ids.append(joined["seat"])
        print(f"seat {joined['seat'] + 1} joined as Agent {index}")
    for _ in range(bots):
        call(f"{base}/api/rooms/{code}/bot", {"difficulty": args.difficulty})
        print("seated one server bot")
    call(f"{base}/api/rooms/{code}/start", {"token": first["token"]})

    deadline = time.time() + args.max_seconds
    moves_seen = 0
    while time.time() < deadline:
        state = call(f"{base}/api/rooms/{code}/state")["state"]
        if state["phase"] == "finished":
            record = call(f"{base}/api/rooms/{code}/log")["record"]
            result = record["result"]
            print(f"\nfinished after {result['turns']} moves in {result['durationSeconds']}s "
                  f"({len(record['moves'])} logged, {moves_seen} played by this script)")
            for index, entry in enumerate(record["seats"]):
                kind = "agent" if index in tokens else "bot  "
                print(f"  seat {index + 1} [{kind}] {entry['name']:<10} "
                      f"points {result['scores'][index]:>3}  stones {result['stones'][index]:>3} "
                      f"seals {result['seals'][index]}")
            winner = result["winner"]
            print("  result: " + ("draw (" + result["tieBreak"] + ")" if winner is None
                                  else f"seat {winner + 1} {name_of(state, winner)} wins, {result['tieBreak']}"))
            if result["turns"] != len(record["moves"]):
                print("FAIL: move log length does not match the reported turn count", file=sys.stderr)
                return 2
            return 0

        turn = state["turn"]["seat"]
        if turn in tokens:
            mine = call(f"{base}/api/rooms/{code}/state?token={tokens[turn]}")["state"]
            move = choose_move(mine, turn)
            if move is None:
                time.sleep(0.2)
                continue
            call(f"{base}/api/rooms/{code}/move", {"token": tokens[turn], "id": move["id"]})
            moves_seen += 1
        else:
            time.sleep(0.25)

    print("FAIL: match did not finish within the budget", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
