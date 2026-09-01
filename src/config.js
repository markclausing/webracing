/**
 * The one thing you have to fill in yourself.
 *
 * Both online play and the shared lap record board need a server: four browsers
 * cannot find each other on their own, and a board that lives in one browser is
 * not a board anybody else can see. Everything else in this game runs off static
 * files, and this is the single line that changes that.
 *
 * It can point at the same relay as websoccer or webtennis - the relay does not
 * know or care which game is talking to it - but it should not, because the
 * board does not survive the trip: a lap record and a football scoreline are not
 * the same shape, and they share one Durable Object. A Worker of this game's own
 * is two commands. See worker/README.md.
 *
 * Leave it empty and the game still plays: on your own, four round one keyboard
 * and a couple of gamepads, and your own lap records. Only the shared parts go
 * quiet.
 *
 *   export const DEFAULT_RELAY = 'wss://webracing.your-name.workers.dev';
 */
export const DEFAULT_RELAY = 'wss://webracing.vibecoach.workers.dev';

/**
 * Which relay this page should talk to. A `?relay=` in the address always wins,
 * so you can point a tab at a different one without editing anything. On
 * localhost the page assumes the server that served it, because that is what
 * `npm start` gives you.
 */
export function relayFor(location) {
  const override = new URLSearchParams(location.search || '').get('relay');
  if (override) return override;
  if (!isLocal(location) && DEFAULT_RELAY) return DEFAULT_RELAY;
  return `${location.protocol === 'https:' ? 'wss://' : 'ws://'}${location.host}`;
}

/**
 * Are we being served by something on this machine? Read from the host rather
 * than only from hostname: they should agree, and quietly deciding a page is
 * remote because one field was missing would send a local test to the internet.
 */
function isLocal(location) {
  const name = location.hostname || String(location.host || '').split(':')[0];
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(name);
}

/**
 * The board lives on the same server as the relay, over plain HTTP. Returns
 * null when there is nowhere to ask, which is the signal to stay local.
 */
export function boardFor(location) {
  const relay = relayFor(location);
  if (!relay) return null;
  const url = relay.replace(/^ws/, 'http').replace(/\/+$/, '');
  // On a static host with nothing configured, the page's own origin has no
  // board behind it and asking would only produce a console full of 404s.
  if (!isLocal(location) && !DEFAULT_RELAY
      && !new URLSearchParams(location.search || '').get('relay')) {
    return null;
  }
  return `${url}/highscores`;
}
