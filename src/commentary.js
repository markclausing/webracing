/**
 * What the man with the microphone knows.
 *
 * The synthesiser in speech.js is shared with websoccer and webtennis and knows
 * nothing about any sport; this is the racing half. A race has fewer fixed
 * phrases than a tennis match and more numbers, so most of what is here is a
 * vocabulary rather than a script - the lines get built as they are needed, out
 * of a colour, a place and a lap.
 *
 * He says very little on purpose. The engine is the sound of this game, and a
 * voice over the top of every corner is a voice you turn off.
 */

export const WORDS = {
  // The lights. Only "go": the countdown itself is three pips and a longer one,
  // and a voice counting over the top of them says nothing the pips did not.
  go: ['G', 'OW'],

  // The cars.
  red: ['R', 'EH', 'D'],
  blue: ['B', 'L', 'UW'],
  green: ['G', 'R', 'IY', 'N'],
  yellow: ['Y', 'EH', 'L', 'OW'],

  // Places.
  first: ['F', 'ER', 'S', 'T'],
  second: ['S', 'EH', 'K', 'AH', 'N', 'D'],
  third: ['TH', 'ER', 'D'],
  fourth: ['F', 'AO', 'R', 'TH'],
  wins: ['W', 'IH', 'N', 'Z'],

  // The race.
  lap: ['L', 'AE', 'P'],
  final: ['F', 'AY', 'N', 'AH', 'L'],
  last: ['L', 'AE', 'S', 'T'],
  fastest: ['F', 'AE', 'S', 'T', 'AH', 'S', 'T'],
  record: ['R', 'EH', 'K', 'ER', 'D'],
  new: ['N', 'UW'],
  table: ['T', 'EY', 'B', 'AH', 'L'],
  off: ['AO', 'F'],
  out: ['AW', 'T'],
  the: ['DH', 'AH'],
  is: ['IH', 'Z'],
  he: ['HH', 'IY'],
  gone: ['G', 'AO', 'N'],
};

/** Lines with nothing variable in them. Everything else is built as it is needed. */
export const LINES = {
  go: ['go'],
  final: ['final lap', 'last lap'],
  fall: ['off the table', 'he is gone', 'out'],
  record: ['new record', 'fastest lap'],
};

const CARS = ['red', 'blue', 'green', 'yellow'];
const PLACES = ['first', 'second', 'third', 'fourth'];

/** The name of a car, as the commentator would say it. */
export function carWord(i) {
  return CARS[i] || 'red';
}

/** "red wins". Said once, at the flag, and never about anybody but the winner. */
export function winCall(seat) {
  return `${carWord(seat)} wins`;
}

/** "fastest lap blue". */
export function lapCall(seat) {
  return `fastest lap ${carWord(seat)}`;
}

/** "green is second". Used on the results card, one line at a time. */
export function placeCall(seat, place) {
  return `${carWord(seat)} is ${PLACES[place - 1] || 'fourth'}`;
}

