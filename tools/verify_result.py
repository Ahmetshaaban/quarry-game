"""Independent re-derivation of a QUARRY match result from its move log.

Usage: python tools/verify_result.py <base-url> <CODE>
"""
import json
import sys
import urllib.request

SEAL_BONUS = 2
USER_AGENT = "QUARRY-verifier/1.0 (agent client)"


def fetch_json(url):
    request = urllib.request.Request(url)
    request.add_header("User-Agent", USER_AGENT)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode())


def main():
    base = sys.argv[1].rstrip("/")
    code = sys.argv[2].upper()
    record = fetch_json(f"{base}/api/rooms/{code}/log")["record"]

    seats = len(record["seats"])
    left = {q["id"]: q["total"] for q in record["quarries"]}
    total = {q["id"]: q["total"] for q in record["quarries"]}
    held = [{q["id"]: 0 for q in record["quarries"]} for _ in range(seats)]
    seals = [[] for _ in range(seats)]

    for move in record["moves"]:
        for part in move["taken"]:
            q, n = part["quarry"], part["count"]
            held[move["seat"]][q] += n
            left[q] -= n
            if left[q] == 0 and q not in seals[move["seat"]]:
                seals[move["seat"]].append(q)

    print("quarries left:", left, " -> empty:", all(v == 0 for v in left.values()))
    scores = [0] * seats
    for q in total:
        column = [held[s][q] for s in range(seats)]
        best = max(column)
        leaders = [s for s in range(seats) if column[s] == best and best > 0]
        points = 0
        leader = None
        if len(leaders) == 1:
            leader = leaders[0]
            others = [c for i, c in enumerate(column) if i != leader]
            points = best - (max(others) if others else 0)
            scores[leader] += points
        print(f"  {q:<6} holdings={column} leader={leader} points={points}")
    for s in range(seats):
        scores[s] += len(seals[s]) * SEAL_BONUS
    stones = [sum(held[s].values()) for s in range(seats)]
    print("  seals:", seals)
    print("re-derived points:", scores, "stones:", stones)
    print("server result    :", record["result"]["scores"], "stones:", record["result"]["stones"],
          "seals:", record["result"]["seals"])
    print("match:", "MATCH" if scores == record["result"]["scores"] and stones == record["result"]["stones"] else "MISMATCH")
    print("phase:", record["phase"], "moves:", len(record["moves"]), "winner:", record["result"]["winner"],
          "|", record["result"]["tieBreak"])


if __name__ == "__main__":
    main()
