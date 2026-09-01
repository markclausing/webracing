# The relay, as a Cloudflare Worker

Two things in this game cannot be done from static files: putting four browsers
in the same room, and keeping a lap record board that everybody can see. This is
both of them, in one deployment, on Cloudflare's free tier.

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

It prints an address. Put it in `../src/config.js` as `DEFAULT_RELAY`, with
`wss://` rather than `https://`:

```js
export const DEFAULT_RELAY = 'wss://webracing.your-name.workers.dev';
```

That is the whole setup. The game already works without it — on your own, four
round one keyboard, and your own records in your own browser — and this is what
turns the online mode on and makes the board shared.

## Deploy a Worker of this game's own

Not websoccer's, and not webtennis's, even though all three speak the same
protocol and one Worker would technically serve all of them.

The board lives in a single Durable Object under one key. A football scoreline is
"4 - 1, and more is better"; a lap record is "13.25 seconds, and less is better,
round a particular table". They do not merge into one another, and sharing an
object would mean one of them quietly eating the other. Three Workers, three
boards.

They can still post into the same Discord channel, because that is only a webhook
address and it does not care which game is talking.

## Optional extras

```bash
npx wrangler secret put DISCORD_WEBHOOK   # announce new records
npx wrangler secret put GAME_URL          # ...with a link to the game
npx wrangler secret put ADMIN_KEY         # lets you clean the board
```

**DISCORD_WEBHOOK** posts a line whenever somebody gets onto the board:

> **MJC** went round the pool table in **0:12.94**

Worked out from the board rather than from what was posted, so a lap that did not
make the top ten stays quiet, and a lap arriving for the second time from a
second device is not announced twice. Never awaited, either: Discord being down
must not make setting a record fail.

**ADMIN_KEY** is the broom. A public list with no accounts on it will eventually
collect something you would rather it did not — a joke name, an impossible lap, a
test suite pointed at the wrong server:

```bash
# everything
curl -X POST -H "x-admin-key: ..." https://your-worker/highscores/reset

# or just the rows you actually object to
curl -X POST -H "x-admin-key: ..." -H "content-type: application/json" \
     -d '{"ids":["k3f2p1-x9a"]}' https://your-worker/highscores/remove
```

Both remember what they threw away. Deleting a row here does not delete it from
the browser that set it, and that browser will post it straight back at the next
sync — which is exactly what happened the first time one of these boards was
tidied up.

With no `ADMIN_KEY` set, neither door exists at all. That is the safe default for
anybody who deploys this and never reads this file.

## What it does not do

No accounts, no rate limiting, no sharding. Rooms have to share one object to
find each other, and forty rows of lap times are not worth a database. If this
ever gets enough players for that to matter, something has gone gloriously
wrong.

## Running it yourself instead

`npm start` in the directory above runs `server/relay.js`, which does exactly the
same three jobs — serves the page, passes inputs between four players, keeps the
board in `highscores.json` next to it. That is the one to use while you are
developing, and it is enough for a LAN party. The Worker is for when the four of
you are not in the same room.
