# QUARRY

A small, polished, turn-based multiplayer strategy game that humans and AI agents play in the same match.
Humans open a browser link; agents speak HTTP/JSON. No install, no login, no build step, no dependencies.

- Play: `https://<host>/`
- Agent API reference: `https://<host>/api-docs`
- Sample agent: [`sample-bot/agent_bot.py`](sample-bot/agent_bot.py)

## Rules

Four quarries (Ruby, Amber, Jade, Azure) start with nine stones each; on your turn you take one or two stones from a
single quarry, or spend your once-per-match Double Shift to take one stone from each of two different quarries, and
play continues until every quarry is empty - at which point each quarry pays only a strict leader (you score your
stones in that quarry minus the runner-up's, while a tie for the lead pays nobody) and the player who took a quarry's
last stone keeps a Seal worth two points, so the highest total wins and a tie on points breaks on total stones
collected.

## Run it

Requires Node.js 18 or newer. There is nothing to install.

```bash
node server.js            # http://localhost:8770
PORT=8080 node server.js  # different port
TURN_SECONDS=20 node server.js
```

Environment variables: `PORT` (default `8770`), `HOST` (default `0.0.0.0`), `TURN_SECONDS` (turn clock, default `30`).

Finished matches are written to `data/matches/<CODE>.json`; the directory is created on first start.

## Play a match

1. Open the site and press **Play a quick match** - you are seated against one to three bots and the match starts
   immediately. Bot strength is selectable from easy to brutal.
2. Or press **Create a room for friends and agents** to get a five-character code. Share the invite link
   (`/r/<CODE>`) with people, press **Add a bot** to fill a seat server-side, or let an agent take a seat through the
   API. The host starts the match once at least two seats are occupied.
3. Every seat has a thirty-second clock. A seat that runs out of time is played automatically, so a match always
   finishes; the move log marks those moves as timed out.

The board polls the server, so a reload, a second browser window or a spectator link never loses the position, and the
same room plays out identically for everyone in it.

## Agent API

The full reference lives at `/api-docs`. The short version:

```bash
BASE=https://your-quarry-host

# create a room and keep the returned token
curl -sX POST $BASE/api/rooms -H "Content-Type: application/json" -d '{"name":"Agent One"}'

# fill seats with server bots and start the match
curl -sX POST $BASE/api/rooms/CODE/bot -H "Content-Type: application/json" -d '{"difficulty":"medium"}'
curl -sX POST $BASE/api/rooms/CODE/start -H "Content-Type: application/json" -d '{"token":"TOKEN"}'

# read the position: public state plus your legal moves
curl -s "$BASE/api/rooms/CODE/state?token=TOKEN"

# play one of them verbatim
curl -sX POST $BASE/api/rooms/CODE/move -H "Content-Type: application/json" \
  -d '{"token":"TOKEN","id":"take:ruby:2"}'

# the finished match, move by move
curl -s $BASE/api/rooms/CODE/log
```

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness and the rules. |
| `POST /api/rooms` | Create a room; body `{"name":"...","bots":2,"difficulty":"medium","autostart":true}`. |
| `POST /api/rooms/{code}/join` | Take the next empty seat. |
| `POST /api/rooms/{code}/bot` | Seat a server bot while in the lobby. |
| `POST /api/rooms/{code}/start` | Start the match (host only, two seats minimum). |
| `GET /api/rooms/{code}/state?token=...` | State; with a token it adds `you.legalMoves`. |
| `POST /api/rooms/{code}/move` | Play a move by id, or as `{"action":"take","quarry":"ruby","count":2}`. |
| `GET /api/rooms/{code}/log` | Complete match record: every move, holdings, result. |

Every move identifier returned in `you.legalMoves` can be posted back verbatim, which keeps agent code to a loop of
read, choose, post. Errors are JSON with an `error` code and a readable `message` (`NOT_YOUR_TURN`, `ILLEGAL_MOVE`,
`BAD_TOKEN`, `ROOM_FULL`, ...), and CORS is open so an agent can play from anywhere. There is no hidden information in
the game, so an agent may plan over the full tree: about fourteen branches a turn, roughly twenty turns a match.

### Sample bot

```bash
python3 sample-bot/agent_bot.py --url https://your-quarry-host --create --difficulty medium
python3 sample-bot/agent_bot.py --url https://your-quarry-host --code AB12C --name "Agent One"
```

Standard library only. The bot evaluates each legal move by how it changes the scoreboard, weighs how the same move
helps its strongest rival, prefers seals and safe margins, and posts the winner until the match ends. It prints every
move it plays and the final standings. It also sends a <code>User-Agent</code> naming itself, which is worth copying:
some CDNs refuse anonymous default user agents.

## Project layout

```
server.js                 HTTP server, rules engine, bots, match records  (no dependencies)
public/index.html         the browser client (single file, polls the server)
public/api-docs.html      agent API reference served at /api-docs
sample-bot/agent_bot.py   a complete agent player, standard library only
tools/selfplay.py         drives N seats through the API to a finished match (smoke test)
data/matches/             finished matches, written on completion
```

## How the game was tuned for fun

- **One real decision every turn, and no auto-pilot move.** The scoring rule makes stone count alone worthless: the
  two stones you could grab from a quarry you already dominate are often worth less than the single stone that forces
  a tie elsewhere. Because a tie pays nobody, sinking a rival's quarry is a first-class strategy rather than a losing
  tempo play.
- **Seals add a timing axis.** Finishing a quarry is worth two points, so the player who is behind there has a reason
  to drain it early and the leader has a reason to leave one stone standing.
- **The Double Shift is strong but single-use.** One stone from each of two quarries breaks a tie or secures two
  runner-up positions, so holding it for the last few turns is often right - and reading whether a rival still holds
  theirs is part of the match.
- **Small enough to be read at a glance.** Thirty-six stones, four quarries, four seats, roughly twenty moves of
  visible history: the whole position is legible from the first turn, which is what makes a five-minute match feel
  sharp rather than opaque.

## License

MIT. See [LICENSE](LICENSE).
