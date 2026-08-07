import { describe, expect, it } from 'vitest';
import {
  createGameState,
  dropIndex,
  findWinner,
  normalizeGameState,
  resolveMove,
  specFor,
} from '../src/lib/gameTable';

/** Builds a board from rows of 'X'/'O'/'.' so cases read as the position they describe. */
function board(...rows: string[]): (string | null)[] {
  return rows.flatMap((row) => [...row.replace(/\s/g, '')].map((c) => (c === '.' ? null : c)));
}

const c4 = specFor('connect4');
const ttt = specFor('tictactoe');

describe('4-to-Win', () => {
  it('drops a disc to the bottom of an empty column', () => {
    const state = createGameState('connect4');
    // Bottom row of a 7x6 board starts at index 35.
    expect(dropIndex(state.board, c4, 0)).toBe(35);
    expect(dropIndex(state.board, c4, 6)).toBe(41);
  });

  it('stacks discs on top of each other', () => {
    const state = createGameState('connect4');
    state.board[35] = 'X';
    expect(dropIndex(state.board, c4, 0)).toBe(28);
  });

  it('refuses a full column', () => {
    const state = createGameState('connect4');
    for (let row = 0; row < c4.rows; row++) state.board[row * c4.cols] = 'X';
    expect(dropIndex(state.board, c4, 0)).toBeNull();
  });

  it('resolves a click on any cell of a column to that column landing spot', () => {
    // Clicking the top of column 3 must play the bottom of column 3, not the clicked cell -
    // this is what stops a crafted payload floating a disc in mid-air.
    const state = createGameState('connect4');
    expect(resolveMove(state, 3)).toBe(38);
  });

  it('detects horizontal, vertical and both diagonals', () => {
    const horizontal = board(
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      'XXXX...'
    );
    expect(findWinner(horizontal, c4)).toBe('X');

    const vertical = board(
      '.......',
      '.......',
      '..O....',
      '..O....',
      '..O....',
      '..O....'
    );
    expect(findWinner(vertical, c4)).toBe('O');

    const diagonalDown = board(
      '.......',
      '.......',
      'X......',
      '.X.....',
      '..X....',
      '...X...'
    );
    expect(findWinner(diagonalDown, c4)).toBe('X');

    const diagonalUp = board(
      '.......',
      '.......',
      '...O...',
      '..O....',
      '.O.....',
      'O......'
    );
    expect(findWinner(diagonalUp, c4)).toBe('O');
  });

  it('does not call three in a row a win', () => {
    const three = board(
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      'XXX....'
    );
    expect(findWinner(three, c4)).toBeNull();
  });

  it('does not join a run that wraps across the row edge', () => {
    // Indices 34..37 are contiguous in the flat array but span two rows; treating the board
    // as a flat list rather than a grid would score this as a win.
    const wrap = board(
      '.......',
      '.......',
      '.......',
      '.......',
      '.....XX',
      'XX.....'
    );
    expect(findWinner(wrap, c4)).toBeNull();
  });

  it('reports a draw only once the board is full', () => {
    // Colour pairs of columns and flip every row. Horizontal runs cap at 2 (the column
    // pair), vertical at 1 (every row flips), and both diagonals alternate in pairs - so a
    // full board with no line anywhere, which is what a draw actually looks like.
    const full = Array(c4.cols * c4.rows)
      .fill(null)
      .map((_, i) => {
        const row = Math.floor(i / c4.cols);
        const col = i % c4.cols;
        return (Math.floor(col / 2) + row) % 2 === 0 ? 'X' : 'O';
      });

    expect(full.every((cell) => cell !== null)).toBe(true);
    expect(findWinner(full, c4)).toBe('Draw');
  });

  it('does not report a draw while a cell is still free', () => {
    const nearlyFull = Array(c4.cols * c4.rows)
      .fill(null)
      .map((_, i) => {
        const row = Math.floor(i / c4.cols);
        const col = i % c4.cols;
        return (Math.floor(col / 2) + row) % 2 === 0 ? 'X' : 'O';
      });
    nearlyFull[0] = null;
    expect(findWinner(nearlyFull, c4)).toBeNull();
  });
});

describe('tic-tac-toe still works through the shared rules', () => {
  it('detects a row, a column and a diagonal', () => {
    expect(findWinner(board('XXX', '...', '...'), ttt)).toBe('X');
    expect(findWinner(board('O..', 'O..', 'O..'), ttt)).toBe('O');
    expect(findWinner(board('X..', '.X.', '..X'), ttt)).toBe('X');
    expect(findWinner(board('..X', '.X.', 'X..'), ttt)).toBe('X');
  });

  it('plays into the clicked cell, with no gravity', () => {
    const state = createGameState('tictactoe');
    expect(resolveMove(state, 4)).toBe(4);
    state.board[4] = 'X';
    expect(resolveMove(state, 4)).toBeNull();
  });

  it('calls a full board with no line a draw', () => {
    expect(findWinner(board('XOX', 'XOO', 'OXX'), ttt)).toBe('Draw');
  });
});

describe('stored state migration', () => {
  it('reads a pre-existing 9-cell table as tic-tac-toe', () => {
    // Maps are persisted to disk, so tables saved before 4-to-Win existed have no `game`.
    const legacy = { board: Array(9).fill(null), turn: 'X', winner: null, players: {} } as any;
    expect(normalizeGameState(legacy).game).toBe('tictactoe');
  });

  it('rebuilds a board whose size does not match its game', () => {
    const broken = { game: 'connect4', board: Array(9).fill(null), turn: 'X', winner: null, players: {} } as any;
    const fixed = normalizeGameState(broken);
    expect(fixed.board).toHaveLength(c4.cols * c4.rows);
  });

  it('survives missing or malformed state', () => {
    expect(normalizeGameState(undefined).board.length).toBeGreaterThan(0);
    expect(normalizeGameState({ board: 'nope' } as any).board.length).toBeGreaterThan(0);
  });
});

describe('move legality', () => {
  it('refuses any move once the game is won', () => {
    const state = createGameState('connect4');
    state.winner = 'X';
    expect(resolveMove(state, 0)).toBeNull();
  });

  it('refuses an out-of-range index', () => {
    const state = createGameState('connect4');
    expect(resolveMove(state, -1)).toBeNull();
    expect(resolveMove(state, 999)).toBeNull();
  });
});
