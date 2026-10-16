#!/usr/bin/env python3
"""A complete QUARRY agent in one file. Standard library only.

Two ways to use it:

  # open a fresh room, seat three bots and play the whole match
  python3 agent_bot.py --url https://your-quarry-host --create --difficulty medium

  # take a seat in somebody else's room
  python3 agent_bot.py --url https://your-quarry-host --code AB12C --name "Agent One"

The bot reads the position, scores every legal move it is offered, and posts the best one
until the match is over. It prints each move it plays and the final standings.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

QUARRIES = ("ruby", "amber", "jade", "azure")
SEAL_BONUS = 2
USER_AGENT = "QUARRY-sample-bot/1.0 (agent player)"


def call(url: str, payload: dict | None = None, timeout: float = 20.0) -> dict:
    """GET when payload is None, POST otherwise. Raises on a failed request."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    request.add_header("User-Agent", USER_AGENT)  # identify the client; anonymous defaults are often throttled
    if data:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("message", detail)
        except ValueError:
            pass
        raise RuntimeError(f"{error.code} {detail}") from error
    if isinstance(body, dict) and body.get("ok") is False:
        raise RuntimeError(body.get("message") or body.get("error") or "request failed")
    return body


# --------------------------------------------------------------------------- planning

def snapshot(state: dict) -> dict:
    """The mutable part of a position, small enough to copy for look-ahead."""
    return {
        "left": {q["id"]: q["left"] for q in state["quarries"]},
        "total": {q["id"]: q["total"] for q in state["quarries"]},
        "holdings": [dict(h) for h in state["holdings"]],
        "seals": [list(s) for s in state["seals"]],
        "shift_used": list(state["shiftUsed"]),
        "seats": len(state["seats"]),
    }


def play(snap: dict, seat: int, move: dict) -> dict:
    """Apply a move to a snapshot and return a new snapshot."""
    out = {
        "left": dict(snap["left"]),
        "total": snap["total"],
        "holdings": [dict(h) for h in snap["holdings"]],
        "seals": [list(s) for s in snap["seals"]],
        "shift_used": list(snap["shift_used"]),
        "seats": snap["seats"],
    }
    parts = move.get("from") or [{"quarry": move.get("quarry"), "count": move.get("count")}]
    for part in parts:
        quarry, count = part["quarry"], part["count"]
        out["left"][quarry] -= count
        out["holdings"][seat][quarry] = out["holdings"][seat].get(quarry, 0) + count
        if out["left"][quarry] == 0 and quarry not in out["seals"][seat]:
            out["seals"][seat].append(quarry)
    if move.get("action") == "shift":
        out["shift_used"][seat] = True
    return out


def standings(snap: dict) -> list[float]:
    """Points per seat as the position stands, counting only what is already banked."""
    totals = [0.0] * snap["seats"]
    for quarry, total in snap["total"].items():
        held = [snap["holdings"][seat].get(quarry, 0) for seat in range(snap["seats"])]
        best = max(held)
        leaders = [seat for seat, value in enumerate(held) if value == best and best > 0]
        if len(leaders) == 1:
            others = [value for seat, value in enumerate(held) if seat != leaders[0]]
            totals[leaders[0]] += best - max(others) if others else best
    for seat in range(snap["seats"]):
        totals[seat] += len(snap["seals"][seat]) * SEAL_BONUS
    return totals


def value(snap: dict, seat: int) -> float:
    """How good this position looks for one seat."""
    score = 0.0
    for quarry, total in snap["total"].items():
        held = [snap["holdings"][s].get(quarry, 0) for s in range(snap["seats"])]
        mine = held[seat]
        rivals = [stones for index, stones in enumerate(held) if index != seat]
        best_rival = max(rivals) if rivals else 0
        if mine > 0 and mine > best_rival:
            score += mine - best_rival
        taken = total - snap["left"][quarry]
        if taken > 0 and snap["left"][quarry] > 0:
            score += (mine / taken) * snap["left"][quarry] * 0.55
        if quarry in snap["seals"][seat]:
            score += SEAL_BONUS * 0.8
    return score


def choose_move(state: dict, seat: int) -> dict | None:
    """Rank the legal moves the server offered: my gain minus my strongest rival's gain."""
    moves = (state.get("you") or {}).get("legalMoves") or []
    if not moves:
        return None
    snap = snapshot(state)
    ranked = []
    for move in moves:
        after = play(snap, seat, move)
        mine = value(after, seat)
        rivals = max(
            (value(after, other) for other in range(snap["seats"]) if other != seat),
            default=0.0,
        )
        ranked.append((mine - 0.9 * rivals, mine, move))
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return ranked[0][2]


# ----------------------------------------------------------------------------- driving

def seat_bots(base: str, code: str, count: int, difficulty: str) -> None:
    for _ in range(count):
        call(f"{base}/api/rooms/{code}/bot", {"difficulty": difficulty})


def name_of(state: dict, seat: int) -> str:
    for entry in state["seats"]:
        if entry["seat"] == seat:
            return entry["name"] if entry["type"] == "human" else f"{entry['name']} (bot)"
    return f"seat {seat}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Play QUARRY through the JSON API.")
    parser.add_argument("--url", required=True, help="base URL of the game, e.g. https://quarry.example.com")
    parser.add_argument("--code", help="room code to join (omit with --create)")
    parser.add_argument("--create", action="store_true", help="create a fresh room and seat bots")
    parser.add_argument("--bots", type=int, default=3, help="bots to seat when creating (default 3)")
    parser.add_argument("--difficulty", default="medium", choices=("easy", "medium", "hard", "brutal"))
    parser.add_argument("--name", default="Agent One", help="seat name")
    parser.add_argument("--poll", type=float, default=1.0, help="seconds between state reads")
    parser.add_argument("--max-minutes", type=float, default=15.0, help="give up after this long")
    args = parser.parse_args()

    base = args.url.rstrip("/")
    if args.create or not args.code:
        created = call(f"{base}/api/rooms", {"name": args.name, "difficulty": args.difficulty})
        code, token, seat = created["code"], created["token"], created["seat"]
        if args.bots:
            seat_bots(base, code, args.bots, args.difficulty)
        call(f"{base}/api/rooms/{code}/start", {"token": token})
        print(f"Opened room {code} as seat {seat + 1} against {args.bots} bot(s).")
    else:
        code = args.code.upper()
        joined = call(f"{base}/api/rooms/{code}/join", {"name": args.name})
        token, seat = joined["token"], joined["seat"]
        print(f"Joined room {code} as seat {seat + 1}.")

    deadline = time.time() + args.max_minutes * 60
    played = 0
    while time.time() < deadline:
        payload = call(f"{base}/api/rooms/{code}/state?token={token}")
        state = payload["state"]
        if state["phase"] == "finished":
            record = call(f"{base}/api/rooms/{code}/log")["record"]
            result = record["result"]
            print(f"\nMatch over after {result['turns']} moves in {result['durationSeconds']}s.")
            for index, entry in enumerate(record["seats"]):
                print(
                    f"  seat {index + 1} {entry['name']:<14} "
                    f"points {result['scores'][index]:>3}  stones {result['stones'][index]:>3}  seals {result['seals'][index]}"
                )
            if result["winner"] is None:
                print(f"  result: {result['tieBreak']}")
            else:
                print(f"  result: {name_of(state, result['winner'])} wins ({result['tieBreak']})")
            return 0

        mine = state.get("you")
        if mine and mine.get("isYourTurn"):
            move = choose_move(state, seat)
            if move is None:
                time.sleep(args.poll)
                continue
            call(f"{base}/api/rooms/{code}/move", {"token": token, "id": move["id"]})
            played += 1
            print(f"  move {played:>2} (turn {len(state['moves']) + 1:>2}): {move['description']}")
        else:
            time.sleep(args.poll)
            continue
        time.sleep(args.poll)

    print("Gave up: the match did not finish in time.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
