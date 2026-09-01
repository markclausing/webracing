/**
 * The same relay, as a Cloudflare Worker.
 *
 * One deployment does both jobs the game cannot do from static files: it puts
 * two to four browsers in the same room, and it keeps the shared lap record
 * board. It speaks exactly the protocol server/relay.js speaks, so the browser
 * cannot tell the difference and neither can the tests.
 *
 * Everything lives in a single Durable Object. A Worker on its own is stateless
 * and cannot hold four sockets together, and one object for the whole game is
 * plenty: this is a racing game for friends, not a service.
 *
 * See README.md next door for the two commands that put it live.
 */

import { merge, since, without } from '../src/highscores.js';
import { announcement, newRows } from './announce.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const MAX_BODY = 64 * 1024;
const SEATS = 4;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-key',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
});

export class Arena {
  constructor(state, env = {}) {
    this.state = state;
    // Cloudflare hands the object its bindings here, not to fetch(), which is
    // the only place the admin key can come from.
    this.env = env;
    /** @type {Map<string, {seats: Array<object|null>}>} */
    this.rooms = new Map();
    this.board = null;
    this.clearedAt = 0;
    // Rows taken off by hand. Kept, because deleting a row does not delete it
    // from the browser that set it, and that browser will post it back.
    this.removed = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/highscores/reset') return this.reset(request);
    if (url.pathname === '/highscores/remove') return this.remove(request);
    if (url.pathname === '/highscores') return this.scores(request);
    if (request.headers.get('Upgrade') === 'websocket') return this.open();
    return new Response('WebRacing relay. Point the game at this address.', {
      headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
    });
  }

  // --- Putting players in a room --------------------------------------------

  open() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const conn = { socket: server, room: null, seat: -1 };
    server.addEventListener('message', (ev) => {
      this.receive(conn, typeof ev.data === 'string' ? ev.data : '');
    });
    server.addEventListener('close', () => this.leave(conn));
    server.addEventListener('error', () => this.leave(conn));

    return new Response(null, { status: 101, webSocket: client });
  }

  code() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  static send(conn, obj) {
    try {
      conn.socket.send(JSON.stringify(obj));
    } catch { /* the socket has gone; the close handler will tidy up */ }
  }

  static roster(room) {
    return room.seats.map((c) => !!c);
  }

  others(conn) {
    const room = conn.room && this.rooms.get(conn.room);
    if (!room) return [];
    return room.seats.filter((c) => c && c !== conn);
  }

  leave(conn) {
    if (!conn.room) return;
    const room = this.rooms.get(conn.room);
    if (!room) return;
    const seat = conn.seat;
    if (seat >= 0 && room.seats[seat] === conn) room.seats[seat] = null;

    const left = room.seats.filter(Boolean);
    if (left.length) {
      for (const other of left) {
        Arena.send(other, { t: 'peerleft', seat, seats: Arena.roster(room) });
      }
    } else {
      this.rooms.delete(conn.room);
    }
    conn.room = null;
    conn.seat = -1;
  }

  receive(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create': {
        this.leave(conn);
        const code = this.code();
        const room = { seats: new Array(SEATS).fill(null) };
        room.seats[0] = conn;
        this.rooms.set(code, room);
        conn.room = code;
        conn.seat = 0;
        Arena.send(conn, {
          t: 'room', code, role: 'host', seat: 0, seats: Arena.roster(room),
        });
        break;
      }

      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) {
          Arena.send(conn, { t: 'error', msg: `Room ${code} does not exist` });
          return;
        }
        const seat = room.seats.indexOf(null);
        if (seat < 0) {
          Arena.send(conn, { t: 'error', msg: `Room ${code} is full` });
          return;
        }
        this.leave(conn);
        room.seats[seat] = conn;
        conn.room = code;
        conn.seat = seat;
        Arena.send(conn, {
          t: 'room', code, role: 'guest', seat, seats: Arena.roster(room),
        });
        for (const other of room.seats.filter(Boolean)) {
          Arena.send(other, { t: 'peer', seats: Arena.roster(room), seat });
        }
        break;
      }

      default: {
        // Input, start, hashes, pings: passed on untouched, except for the seat
        // they came from, which is stamped here rather than trusted. A client
        // that could name its own seat could drive somebody else's car.
        for (const other of this.others(conn)) Arena.send(other, { ...msg, seat: conn.seat });
        break;
      }
    }
  }

  /**
   * Wipes the board.
   *
   * A public list with no accounts on it will eventually collect something you
   * do not want on it - a joke name, an impossible lap, or a test suite that got
   * pointed at the wrong server. This is the broom. It only works if you have
   * set a key:
   *
   *   npx wrangler secret put ADMIN_KEY
   *   curl -X POST -H "x-admin-key: ..." https://your-worker/highscores/reset
   *
   * With no key set the door is simply not there, which is the safe default for
   * anyone who deploys this and never reads about it.
   */
  async reset(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST to reset' }, 405);
    const key = this.env?.ADMIN_KEY;
    if (!key) return json({ error: 'no ADMIN_KEY set on this Worker' }, 404);
    if (request.headers.get('x-admin-key') !== key) return json({ error: 'wrong key' }, 403);

    this.board = merge({}, {});
    // Remembered, or every browser still holding the old rows would post them
    // straight back and the board would refill itself.
    this.clearedAt = Date.now();
    await this.state.storage.put('board', this.board);
    await this.state.storage.put('clearedAt', this.clearedAt);
    return json({ board: this.board, cleared: true, clearedAt: this.clearedAt });
  }

  /**
   * Tells Discord about it, if a webhook has been set.
   *
   * Deliberately not awaited: Discord being slow, rate limiting us or simply
   * down must not make posting a lap fail. The board is the product here; the
   * announcement is a nicety.
   */
  shout(rows) {
    const url = this.env?.DISCORD_WEBHOOK;
    if (!url || !rows.length) return;
    const post = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(announcement(rows, this.env?.GAME_URL)),
    }).catch(() => { /* the record is safe; the message was not */ });
    // Keeps the object alive long enough to finish the request after the
    // player's browser already has its answer.
    this.state?.waitUntil?.(post);
  }

  /**
   * Takes named rows off the board and keeps them off.
   *
   * The blunt version of this is reset(), which is no use when the board also
   * holds laps people actually drove. The ids are remembered, because a row
   * deleted here still exists in the browser that set it, and that browser will
   * post it back at the next sync.
   */
  async remove(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST to remove' }, 405);
    const key = this.env?.ADMIN_KEY;
    if (!key) return json({ error: 'no ADMIN_KEY set on this Worker' }, 404);
    if (request.headers.get('x-admin-key') !== key) return json({ error: 'wrong key' }, 403);

    let ids;
    try {
      ids = JSON.parse(await request.text())?.ids;
    } catch {
      return json({ error: 'not JSON' }, 400);
    }
    if (!Array.isArray(ids) || !ids.length) return json({ error: 'send { ids: [...] }' }, 400);

    await this.load();
    this.board = without(this.board, ids);
    // Capped: this is a list of mistakes, not a database.
    this.removed = [...new Set([...this.removed, ...ids.map(String)])].slice(-200);
    await this.state.storage.put('board', this.board);
    await this.state.storage.put('removed', this.removed);
    return json({ board: this.board, removed: ids.length });
  }

  // --- The shared board ------------------------------------------------------

  async load() {
    if (!this.board) {
      this.board = merge({}, (await this.state.storage.get('board')) || {});
      this.clearedAt = (await this.state.storage.get('clearedAt')) || 0;
      this.removed = (await this.state.storage.get('removed')) || [];
    }
    return this.board;
  }

  async scores(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET') return json({ board: await this.load() });
    if (request.method !== 'POST') {
      return json({ error: 'GET to read the board, POST to add to it' }, 405);
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'that is not a lap record table' }, 413);

    let sent;
    try {
      sent = JSON.parse(text);
    } catch {
      return json({ error: 'not JSON' }, 400);
    }

    // The same merge the browser runs, so the two cannot disagree about what a
    // board is: rows that are not a plausible lap do not survive it.
    const before = await this.load();
    // Anything set before the board was last emptied is not allowed back in.
    const arriving = without(since(sent?.board || {}, this.clearedAt), this.removed);
    const after = merge(before, arriving);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      this.board = after;
      await this.state.storage.put('board', after);
      // Anything that actually landed gets announced. Worked out from the board
      // rather than from what was sent, so a lap that did not make the top ten
      // stays quiet and a lap arriving for the second time is not news.
      this.shout(newRows(before, after));
    }
    return json({ board: after });
  }
}

export default {
  fetch(request, env) {
    // Everything goes to the one object. Rooms have to share it to find each
    // other, and forty rows of lap records are not worth sharding.
    const id = env.ARENA.idFromName('global');
    return env.ARENA.get(id).fetch(request);
  },
};
