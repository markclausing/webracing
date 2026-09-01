/**
 * Every dimension, speed and rule in one place - the same arrangement as
 * websoccer and webtennis, and for the same reason: tuning a game means changing
 * numbers, and hunting them through the code is how a game stops being tuneable.
 *
 * The world is a tabletop seen from directly above. There is no camera in here:
 * how much of the table you can see depends on the size of the window, and the
 * window is not the same size on two machines. Anything the simulation decides
 * has to be decided in world units, or two players would disagree about who fell
 * off the back - see DROP_GAP.
 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const FRAME_TIME = 1000 / TICK_RATE;

/** Four cars, and no more: the relay hands out four seats and the pack is four. */
export const MAX_CARS = 4;

// --- The car -----------------------------------------------------------------
//
// Small and light, because these are toys on a table rather than cars on a road.
// The whole feel of the game is in three numbers - how fast the nose comes
// round, how much sideways the tyres will take before they let go, and how long
// it takes to get the speed back afterwards - and all three are below.

export const CAR_L = 30; // nose to tail, for drawing and for hitting things
export const CAR_W = 16;
export const CAR_R = 11; // what it collides with, as a circle

export const TOP_SPEED = 340; // px/s on a clean surface
export const ACCEL = 430; // px/s^2 with your foot down
export const BRAKE = 620;
export const REVERSE_SPEED = 120;
export const REVERSE_ACCEL = 240;
export const ROLL_DRAG = 0.55; // engine braking when you lift off

/**
 * How fast the nose comes round, and why it is not one number.
 *
 * A car that turns as sharply at 20 px/s as at 340 spins on the spot, which is
 * how a shopping trolley drives. So the rate falls away with speed - fast enough
 * to be flickable at the bottom of the range, calm enough at the top that a
 * straight is a straight. TURN_MIN is what is left at full speed.
 */
export const TURN_RATE = 4.4; // radians per second at the sharpest
export const TURN_MIN = 0.42; // the share of it left at top speed
export const TURN_FADE = 0.55; // how quickly it fades in over the first of the range
/** Below this you are parked, and a parked car does not steer. */
export const TURN_STALL = 26;

/**
 * Grip: how much sideways the tyres will take.
 *
 * The car has a velocity and it has a direction it is pointing, and they are not
 * the same thing - that difference is the drift, and it is the whole reason a
 * corner is interesting. Every tick the sideways part of the velocity is pulled
 * back towards zero by GRIP; whatever survives is the slide.
 *
 * BRAKE_GRIP is what is left of it while you are on the brake, which is what
 * turns the brake into a handbrake at speed: stab it going into a hairpin and
 * the back steps out. That is the one trick this game asks you to learn.
 */
export const GRIP = 7.4; // per second, exponential
export const BRAKE_GRIP = 0.28; // the share of grip left while braking
export const SLIDE_DRAG = 1.9; // a slide scrubs speed off, which is its price
/** Sideways speed above which the tyres are audibly and visibly letting go. */
export const SLIDE_MARK = 42;

/** Bumping. Cars are round for this, and they bounce off each other, hard. */
export const BUMP_PUSH = 1.35; // how much of the closing speed comes back
export const BUMP_MIN = 30; // a shove even at a standstill, so nobody can wedge

/**
 * The tow.
 *
 * Sit close behind somebody and the air they are pushing out of the way is air
 * you do not have to. Small on purpose - seven per cent, and only right in the
 * middle of it - because the point is not to make following easy, it is to stop
 * a quick driver disappearing over the horizon on lap one and racing nobody for
 * the next two minutes.
 *
 * It works for the CPU too. A tow that only the player got would be a handout;
 * one everybody gets is a reason for the field to stay together, which is the
 * whole idea.
 */
// About ten car lengths. Measured at 155 - half a second of racing - the tow
// vanished the moment a corner opened the smallest gap, so it held a pack that
// was already nose to tail together and did nothing whatever about a leader who
// had gone. A following distance you can actually hold is the point.
export const SLIP_RANGE = 280; // how far back it reaches
export const SLIP_WIDTH = 32; // and how far off their line you can sit
export const SLIP_MAX = 0.07; // the share of extra speed, dead centre
export const SLIP_MIN_SPEED = 150; // no tow at a crawl: there is no air to punch

/**
 * The turbo, and the one rule that makes it worth having.
 *
 * It is dropped a little way up the road from the *last* car on the track, and
 * only when the leader is far enough ahead not to be near it. Then it fades in
 * about four seconds. So if you are at the back you keep finding them, and if
 * you are running away at the front you never see one - not because the game
 * refuses you, but because by the time it appears you are already past.
 *
 * Anybody who is actually there can pick one up, including the leader if the
 * field has closed right up. That is the honest version: it is a thing lying on
 * the road, not a rule about who deserves what.
 */
export const BOOST_EVERY = 190; // ticks between drops
export const BOOST_MAX = 3; // on the table at once
export const BOOST_AHEAD = 190; // dropped this far up the road from whoever it is for
// ...and only if the leader is already this far past that spot. Between them the
// two numbers say the field has to have spread out by about 310 pixels, which is
// a second of racing, before anybody is offered any help. Nose to tail there is
// simply nowhere to put one that is ahead of the last car and behind the leader,
// and that is the right answer: a field that is together does not need catching
// up. Set at 300 and 460 it wanted a spread of 760 and four evenly matched cars
// never once triggered it in a whole race.
export const BOOST_MIN_GAP = 120;
export const BOOST_LIFE = 250; // gone in about four seconds
export const BOOST_R = 28; // how close you have to be to take it
export const BOOST_TICKS = 85; // how long it lasts once you have
export const BOOST_POWER = 0.28; // and how much more speed it is worth

// --- The table ---------------------------------------------------------------

/**
 * How far behind the leader you can be before you are out of the picture.
 *
 * Measured along the track rather than across the screen, on purpose. Falling
 * off the back is a rule of the game, and rules cannot depend on how big
 * somebody's window is: two players with different screens would disagree about
 * who had dropped and the whole race would come apart. The camera in the
 * renderer is clamped to the same distance, so what you see still matches.
 */
export const DROP_GAP = 1180;
/** How far behind the last car still running you are put back on. */
export const REJOIN_BACK = 300;
/** How long you sit there before you are back in it. */
export const DROP_TICKS = 45;
export const FALL_TICKS = 80;
/** How long the fall itself takes, which is the bit you watch. */
export const FALL_ANIM = 26;

/**
 * How much of the table you can see, in world units across the window.
 *
 * VIEW_MIN is how far in the camera will go once the pack is nose to tail; below
 * it the cars are enormous and you cannot see the corner. VIEW_MAX is how far
 * out it will go before it gives up and leaves somebody off the screen with an
 * arrow pointing at them - and it is deliberately close to DROP_GAP, so the
 * moment a car goes out of the picture is very nearly the moment the game calls
 * it dropped.
 */
export const VIEW_MIN = 950; // when the pack is together
export const VIEW_MAX = 1500; // and when it is not

/** Counted down at the start of every race. */
export const COUNTDOWN_TICKS = 3 * TICK_RATE;
/** How long the results stay up before the race is over for good. */
export const FINISH_TICKS = 4 * TICK_RATE;
/** Laps, unless the menu says otherwise. */
export const LAPS = 3;

/**
 * What you are driving on.
 *
 * `grip` and `top` scale the two numbers above; `drag` is a straight retarding
 * force in px/s^2, which is what makes carpet feel like carpet - it does not
 * make the car slide, it just eats it.
 *
 * Every drag here has to stay well under ACCEL, and that is not a style note.
 * Drag is applied whatever the speed, so a surface that pulls harder than the
 * engine pushes is not slow, it is flypaper: mud at 520 stopped all four cars
 * dead on the first lap and they sat in it for the rest of the race.
 *
 * `off` is not a surface. It is the edge of the table.
 */
export const SURFACES = {
  road: { key: 'road', grip: 1, drag: 0, top: 1 },
  rough: { key: 'rough', grip: 0.62, drag: 190, top: 0.58 },
  slick: { key: 'slick', grip: 0.2, drag: 0, top: 1.04 },
  sticky: { key: 'sticky', grip: 1.15, drag: 280, top: 0.5 },
};

export const BTN = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16, SWITCH: 32 };

/**
 * The four cars.
 *
 * Colours and nothing else. They all handle identically, which they have to: the
 * board at the end is a list of lap times, and a lap time means nothing if the
 * red car was quicker than the blue one before anybody turned a wheel. What
 * varies between races is the table, not the car - see `tracks.js`, where each
 * one carries its own handling.
 */
export const CAR_PRESETS = [
  { name: 'RED', body: '#e0453c', trim: '#7d1a16', glass: '#2a1210' },
  { name: 'BLUE', body: '#3d7fe0', trim: '#16386f', glass: '#101f2e' },
  { name: 'GREEN', body: '#4fbb46', trim: '#1c5a1c', glass: '#0f2410' },
  { name: 'YELLOW', body: '#f2c437', trim: '#8a6208', glass: '#2b210a' },
];

/**
 * The three settings, and what actually separates them.
 *
 * `look` is how far up the road the CPU is reading, in pixels, which is most of
 * what makes a driver look quick or clumsy: read far enough ahead and you are
 * already turning in when the corner arrives. `wobble` is how far off the
 * racing line it wanders, and it is allowed to wander off the road - a car that
 * cannot make a mistake is not an opponent, it is a metronome. `slip` is how
 * late it gets off the throttle for a corner it has seen.
 *
 * `nudge` is how much of somebody else's line it is prepared to take. At zero it
 * drives round you; wound up, it leans on whoever is alongside and squeezes them
 * towards the outside of the corner. It is not aimed at the player - the
 * simulation knows which cars are people and deliberately does not look, because
 * a CPU that only ever elbows the human is a CPU you can feel cheating.
 */
export const AI_LEVELS = {
  easy: {
    key: 'easy', label: 'EASY', look: 105, wobble: 34, speed: 0.8, slip: 0.72, react: 8, nudge: 0,
  },
  normal: {
    key: 'normal', label: 'NORMAL', look: 150, wobble: 17, speed: 0.92, slip: 0.86, react: 4, nudge: 0.3,
  },
  hard: {
    key: 'hard', label: 'HARD', look: 195, wobble: 7, speed: 1, slip: 0.97, react: 1, nudge: 0.7,
  },
};

/** How close somebody has to be before a CPU driver starts leaning on them. */
export const NUDGE_RANGE = 120;
