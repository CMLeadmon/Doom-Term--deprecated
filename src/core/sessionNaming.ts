import { SessionKind } from '../types/sessionTree';

const LABEL: Record<SessionKind, string> = {
  terminal: 'Terminal',
  agent: 'Agent',
  tui: 'Terminal',
  scratchpad: 'Notes',
  artifact: 'Artifact',
};

/**
 * The next auto-generated title for `kind`.
 *
 * Only titles this function could itself have produced are counted. Scanning
 * every title for a trailing number meant renaming a tab `deploy-2026` made
 * the next one `Terminal 2027`.
 */
export function nextSessionTitle(kind: SessionKind, existingTitles: string[]): string {
  const label = LABEL[kind];
  const auto = new RegExp(`^${label} (\\d+)$`);

  const highest = existingTitles.reduce((max, title) => {
    const match = title.match(auto);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);

  return `${label} ${highest + 1}`;
}

/**
 * Hard cap on a derived title.
 *
 * The plate's waiting rows are the only place a session's name appears, and a
 * pasted paragraph must not become a title. 24 is what a row holds on an
 * ordinary window before truncation starts eating it.
 */
const SLUG_MAX = 24;

/** The plate's small font has A-Z, 0-9 and a short symbol set. Nothing else. */
function slug(text: string, maxWords: number): string {
  const words = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords);
  return words.join('-').slice(0, SLUG_MAX).replace(/-+$/, '');
}

/**
 * The name a session opens with: its folder, and its branch if it has one.
 *
 * There is never a moment with no name. In this direction the plate's waiting
 * list is the only place a session's identity appears, so a nameless session
 * is an invisible one — which is why the empty case returns SESSION rather
 * than an empty string.
 */
export function derivedSessionTitle(cwd: string, branch: string): string {
  const leaf = cwd.split('/').filter(Boolean).pop() ?? '';
  const folder = slug(leaf, 4);
  if (!folder) return 'SESSION';
  const tail = slug(branch, 4);
  return tail ? `${folder}/${tail}` : folder;
}

/**
 * The name a session takes once its agent has been told what to do.
 *
 * What you hold in your head is the task, not the directory, so this replaces
 * the derived title as soon as there is an instruction to derive it from.
 * Returns empty when there is nothing nameable, and the caller keeps what it
 * had rather than blanking a session out of the waiting list.
 */
export function titleFromInstruction(text: string): string {
  return slug(text, 4);
}
