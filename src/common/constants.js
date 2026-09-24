// Shared constants: the board-encoding values, which must match the training harness's encoder
// exactly or the model sees a different game than it was trained on; the cross-context message
// protocol; and the SAN pattern both scrapers use.

export const NUM_PLANES = 18;

// Directions N, NE, E, SE, S, SW, W, NW as [dfile, drank]; must match the Python encoder.
export const DIRECTIONS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
export const KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
export const UNDERPROMOTIONS = ['n', 'b', 'r'];

export const TARGET = { SW: 'sw', OFFSCREEN: 'offscreen', CONTENT: 'content' };
// INFER payload: { target, type, fen, history, ep, sims } — sims 0 = raw policy argmax, >0 = MCTS
// simulations; history = game FENs since the last capture or pawn move, for repetition detection;
// ep = en passant square after any double push, as training encodes it (absent: the FEN's field).
export const MSG = { INFER: 'INFER', GET_STATE: 'GET_STATE' };
export const STORAGE_KEYS = { ENABLED: 'enabled', SIMS: 'sims' };
export const DEFAULT_SIMS = 128;

// Both scrapers use this to validate move text, and lichess also uses it structurally, to find
// the move list by looking for the element with the most SAN-shaped children. Tightening it for
// one site's quirks can therefore stop the other finding its move list at all.
export const SAN_RE = /^(?:O-O(?:-O)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h](?:x[a-h])?[1-8](?:=[QRBN])?)[+#]?$/;
