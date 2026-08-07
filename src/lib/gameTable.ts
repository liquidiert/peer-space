import type { GameTableState } from '../types';

/**
 * Rules for the arcade table, shared by the server (which is the authority) and the modal
 * (which needs to lay out the board and grey out illegal moves).
 *
 * Both games are the same thing with different numbers - an n-in-a-row on a grid - so they
 * run through one board model and one win scan rather than a second hand-written rule set.
 * The only real difference is gravity: in 4-to-Win you pick a column and the disc falls.
 */

export type GameTableGame = 'tictactoe' | 'connect4';

export interface GameSpec {
  cols: number;
  rows: number;
  /** How many in a row wins. */
  connect: number;
  /** Whether a move picks a column and drops to the lowest free cell. */
  gravity: boolean;
  label: string;
}

export const GAME_SPECS: Record<GameTableGame, GameSpec> = {
  tictactoe: { cols: 3, rows: 3, connect: 3, gravity: false, label: 'Tic-Tac-Toe' },
  connect4: { cols: 7, rows: 6, connect: 4, gravity: true, label: '4 to Win' },
};

export const DEFAULT_GAME: GameTableGame = 'connect4';

export function specFor(game: GameTableGame): GameSpec {
  return GAME_SPECS[game] || GAME_SPECS[DEFAULT_GAME];
}

export function createGameState(game: GameTableGame = DEFAULT_GAME): GameTableState {
  const spec = specFor(game);
  return {
    game,
    board: Array(spec.cols * spec.rows).fill(null),
    turn: 'X',
    winner: null,
    players: {},
  };
}

/**
 * Maps a stored game state onto the current rules.
 *
 * Tables persisted before 4-to-Win existed have no `game` field and a 9-cell board, and maps
 * are saved to disk - so without this every pre-existing arcade table would render as a
 * malformed 4-to-Win grid. A board whose size does not match its game is rebuilt rather than
 * trusted, since a half-length board would make every index calculation wrong.
 */
export function normalizeGameState(state: GameTableState | undefined | null): GameTableState {
  if (!state || typeof state !== 'object' || !Array.isArray(state.board)) {
    return createGameState();
  }

  const game: GameTableGame =
    state.game && GAME_SPECS[state.game] ? state.game : state.board.length === 9 ? 'tictactoe' : DEFAULT_GAME;
  const spec = specFor(game);

  if (state.board.length !== spec.cols * spec.rows) {
    return createGameState(game);
  }

  return {
    game,
    board: state.board,
    turn: state.turn === 'O' ? 'O' : 'X',
    winner: state.winner ?? null,
    players: state.players || {},
  };
}

/**
 * The cell a disc dropped into `col` would land in, or null when that column is full.
 * Returns a board index, not a row, because that is what callers actually place into.
 */
export function dropIndex(board: (string | null)[], spec: GameSpec, col: number): number | null {
  if (col < 0 || col >= spec.cols) return null;
  for (let row = spec.rows - 1; row >= 0; row--) {
    const index = row * spec.cols + col;
    if (board[index] === null) return index;
  }
  return null;
}

/**
 * Resolves a click on any cell into the move it actually represents: the cell itself for
 * Tic-Tac-Toe, the landing cell of that column for 4-to-Win. Returns null for illegal moves.
 */
export function resolveMove(state: GameTableState, clickedIndex: number): number | null {
  const spec = specFor(state.game);
  if (state.winner) return null;
  if (clickedIndex < 0 || clickedIndex >= spec.cols * spec.rows) return null;

  if (spec.gravity) return dropIndex(state.board, spec, clickedIndex % spec.cols);
  return state.board[clickedIndex] === null ? clickedIndex : null;
}

/**
 * 'X' | 'O' when someone has `connect` in a row, 'Draw' on a full board, else null.
 * Scans right, down and both diagonals from every cell - the four directions are enough
 * because every line gets found from its top-left-most end.
 */
export function findWinner(board: (string | null)[], spec: GameSpec): string | null {
  const at = (col: number, row: number) => board[row * spec.cols + col] ?? null;
  const directions: Array<[number, number]> = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < spec.rows; row++) {
    for (let col = 0; col < spec.cols; col++) {
      const start = at(col, row);
      if (!start) continue;

      for (const [dc, dr] of directions) {
        let run = 1;
        while (run < spec.connect) {
          const c = col + dc * run;
          const r = row + dr * run;
          if (c < 0 || c >= spec.cols || r < 0 || r >= spec.rows) break;
          if (at(c, r) !== start) break;
          run++;
        }
        if (run === spec.connect) return start;
      }
    }
  }

  return board.every((cell) => cell !== null) ? 'Draw' : null;
}
