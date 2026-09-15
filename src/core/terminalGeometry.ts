/** Cross-runtime v2 allocation limit; keep aligned with protocol.rs. */
export const MAX_TERMINAL_CELLS = 1_048_576;

export function parseGrid(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows)
      || cols <= 0 || rows <= 0 || cols > 65535 || rows > 65535 || cols * rows > MAX_TERMINAL_CELLS) {
    throw new Error('Invalid terminal reconstruction dimensions');
  }
  return { cols, rows };
}
