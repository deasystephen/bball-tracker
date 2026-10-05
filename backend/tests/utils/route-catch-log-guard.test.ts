/**
 * Guard for #656: a route `try/catch` that answers an error itself logs a 4xx
 * outcome at `warn`, never at `error`.
 *
 * The rule (docs/architecture/backend-services.md#logging): expected client
 * outcomes (4xx) are `warn`, `error` is for 5xx and failed external calls.
 * Route catches log through `utils/log-route-error.ts#logRouteError`, which
 * reads the status the client actually got. The old shape, `logger.error(...)`
 * first and the `instanceof NotFoundError | …` branching after it, wrote every
 * 403/404 to the on-call error stream.
 *
 * In every `try { … } catch { … }` block under `src/api/`:
 * - a `logger.error(` must not sit inside a 4xx branch (an `if` on an
 *   `instanceof <AppError class>` or on `statusCode < 500`), nor after such a
 *   branch that falls through; an `else` of that branch is the 5xx path and
 *   is fine;
 * - a `logRouteError(` must come after the last response write, so it reads
 *   the status that was sent, unless it sits in an `if (res.headersSent)` guard.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { sourceFiles } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const API = path.join(BACKEND, 'src/api');

/** Every router file. Each must hold at least one scanned try/catch block. */
const ROUTERS = [
  'admin/routes.ts',
  'announcements/routes.ts',
  'auth/routes.ts',
  'games/routes.ts',
  'invitations/public-routes.ts',
  'invitations/routes.ts',
  'leagues/routes.ts',
  'players/routes.ts',
  'seasons/routes.ts',
  'stats/routes.ts',
  'teams/calendar.ts',
  'teams/routes.ts',
  'uploads/routes.ts',
];

/**
 * Deliberate `error`-level 4xx outcomes, by file and log message. Each needs a
 * reason that makes it never a routine client outcome.
 */
const ALLOWED_ERROR_LOGS: Array<{ file: string; message: string }> = [
  // 409 on sign-in: an email bound to a different WorkOS user. The WorkOS key
  // cutover (#24) would send every sign-in here (every production row carries
  // a staging WorkOS id), and the alarms key on @level:error.
  { file: 'auth/routes.ts', message: 'Auth callback email linked to a different WorkOS user' },
];

const APP_ERROR_CLASS =
  '(?:AppError|DetailedError|NotFoundError|ForbiddenError|BadRequestError|UnauthorizedError|ConflictError|PaymentRequiredError|LastHeadCoachError|ResendCooldownError)';
const POSITIVE_INSTANCEOF = new RegExp(`(?<!!\\(\\s*)\\b\\w+\\s+instanceof\\s+${APP_ERROR_CLASS}\\b`);
const STATUS_4XX = /statusCode\s*<\s*500|statusCode\s*>=\s*400/;
const RESPONSE_WRITE = /\bres\s*\.\s*(?:status|json|send|sendStatus|end|redirect)\s*\(/g;

/** Blanks comments and string/template contents (keeping offsets) so braces in them are not counted. */
function maskNonCode(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index of the bracket closing the one at `open`. */
function matching(code: string, open: number): number {
  const [o, c] = code[open] === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return code.length;
}

interface Block {
  /** Catch body, comments and strings masked. */
  body: string;
  /** Catch body, original text (same offsets). */
  raw: string;
  line: number;
}

/** The body of every `try { … } catch (…) { … }` block; promise `.catch(` handlers are not matched. */
export function catchBlocks(source: string): Block[] {
  const code = maskNonCode(source);
  const blocks: Block[] = [];
  const head = /\}\s*catch\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matching(code, open);
    blocks.push({
      body: code.slice(open + 1, close),
      raw: source.slice(open + 1, close),
      line: code.slice(0, m.index).split('\n').length,
    });
  }
  return blocks;
}

interface Branch {
  cond: string;
  /** Offset of the `if` keyword. */
  start: number;
  /** Braces of the `if` body. */
  open: number;
  close: number;
  /** End of the whole if / else-if / else chain that follows. */
  chainEnd: number;
}

/** End of the else-chain after an `if` body closing at `close`. */
function chainEndAfter(code: string, close: number): number {
  const rest = code.slice(close + 1);
  const elseMatch = /^\s*else\s*/.exec(rest);
  if (!elseMatch) return close;
  let i = close + 1 + elseMatch[0].length;
  if (code.startsWith('if', i)) {
    const paren = code.indexOf('(', i);
    const brace = code.indexOf('{', matching(code, paren));
    return chainEndAfter(code, matching(code, brace));
  }
  if (code[i] === '{') return chainEndAfter(code, matching(code, i));
  i = code.indexOf(';', i);
  return i === -1 ? code.length : i;
}

/** Every `if` whose condition is a 4xx branch: a positive AppError instanceof or `statusCode < 500`. */
function fourXxBranches(body: string): Branch[] {
  const branches: Branch[] = [];
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const parenClose = matching(body, paren);
    const cond = body.slice(paren + 1, parenClose);
    if (!POSITIVE_INSTANCEOF.test(cond) && !STATUS_4XX.test(cond)) continue;
    const after = /^\s*\{/.exec(body.slice(parenClose + 1));
    const open = after ? parenClose + after[0].length : parenClose;
    const close = after ? matching(body, open) : body.indexOf(';', parenClose);
    branches.push({ cond, start: m.index ?? 0, open, close, chainEnd: chainEndAfter(body, close) });
  }
  return branches;
}

/** `if (res.headersSent) { … }` body ranges. */
function headersSentGuards(body: string): Array<[number, number]> {
  return [...body.matchAll(/\bif\s*\(\s*res\.headersSent\s*\)\s*\{/g)].map((m) => {
    const open = (m.index ?? 0) + m[0].length - 1;
    return [open, matching(body, open)];
  });
}

/** Brace depth at `i`, relative to the catch body. */
function depthAt(body: string, i: number): number {
  let depth = 0;
  for (let k = 0; k < i; k++) {
    if (body[k] === '{') depth++;
    else if (body[k] === '}') depth--;
  }
  return depth;
}

/** Messages of `logger.error(` calls on a 4xx path in one catch block. */
export function errorLogsOn4xxPath(block: Block): string[] {
  const branches = fourXxBranches(block.body);
  const offenders: string[] = [];
  for (const log of block.body.matchAll(/\blogger\.error\(\s*/g)) {
    const at = log.index ?? 0;
    const onFourXxPath = branches.some((b) => {
      if (b.start > at) {
        // Logged at the top of the catch, ahead of the 4xx branch, with no exit
        // between: every 4xx outcome is written at error (the shape #656 removed).
        const between = block.body.slice(at, b.start);
        return depthAt(block.body, at) === 0 && !/\breturn\b|\bnext\(|\bthrow\b/.test(between);
      }
      if (at < b.close) return true; // inside the 4xx branch
      if (at <= b.chainEnd) return false; // in its else: the 5xx path
      return !/\breturn\b|\bnext\(/.test(block.body.slice(b.open, b.close)); // falls through
    });
    if (onFourXxPath) {
      const msg = /^['"`]([^'"`]*)/.exec(block.raw.slice(at + log[0].length));
      offenders.push(msg ? msg[1] : '(dynamic message)');
    }
  }
  return offenders;
}

/** Count of `logRouteError(` calls that run before the response status is set. */
export function misorderedRouteLogs(block: Block): number {
  const guards = headersSentGuards(block.body);
  const inGuard = (i: number): boolean => guards.some(([o, c]) => i > o && i < c);
  const writes = [...block.body.matchAll(RESPONSE_WRITE)]
    .map((w) => w.index ?? 0)
    .filter((i) => !inGuard(i));
  const lastWrite = writes.length ? Math.max(...writes) : -1;
  return [...block.body.matchAll(/\blogRouteError\(/g)]
    .map((l) => l.index ?? 0)
    .filter((i) => !inGuard(i) && i < lastWrite).length;
}

describe('route catches log 4xx outcomes at warn (#656)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = sourceFiles(API);
  });
  const rel = (file: string): string => path.relative(API, file);

  it.each(ROUTERS)('scans %s', (router) => {
    // A guard that reads nothing passes for the wrong reason.
    const file = path.join(API, router);
    expect(existsSync(file)).toBe(true);
    expect(catchBlocks(readFileSync(file, 'utf8')).length).toBeGreaterThan(0);
  });

  it('no catch block logs a 4xx outcome at error level', () => {
    const offenders = files.flatMap((file) =>
      catchBlocks(readFileSync(file, 'utf8')).flatMap((block) =>
        errorLogsOn4xxPath(block)
          .filter((message) => !ALLOWED_ERROR_LOGS.some((a) => a.file === rel(file) && a.message === message))
          .map((message) => `src/api/${rel(file)}:${block.line} logger.error('${message}') (use logRouteError)`)
      )
    );
    expect(offenders).toEqual([]);
  });

  it('every allowlisted error log still exists', () => {
    for (const { file, message } of ALLOWED_ERROR_LOGS) {
      const blocks = catchBlocks(readFileSync(path.join(API, file), 'utf8'));
      expect(blocks.flatMap(errorLogsOn4xxPath)).toContain(message);
    }
  });

  it('logRouteError runs after the response status is set', () => {
    const offenders = files.flatMap((file) =>
      catchBlocks(readFileSync(file, 'utf8'))
        .filter((block) => misorderedRouteLogs(block) > 0)
        .map((block) => `src/api/${rel(file)}:${block.line}`)
    );
    expect(offenders).toEqual([]);
  });
});

describe('the guard', () => {
  const block = (body: string): Block => catchBlocks(`try { x(); } catch (error) {\n${body}\n}`)[0];

  it('flags logger.error ahead of the 4xx branching (the shape #656 removed)', () => {
    const b = block(`
      logger.error('Error getting team', { error: String(error) });
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed' });
      }`);
    expect(errorLogsOn4xxPath(b)).toEqual(['Error getting team']);
  });

  it('flags logger.error inside a 4xx branch', () => {
    const b = block(`
      if (error instanceof AppError) {
        logger.error('Inside', { error: String(error) });
        res.status(error.statusCode).json({ error: error.message });
        return;
      }`);
    expect(errorLogsOn4xxPath(b)).toEqual(['Inside']);
  });

  it('flags logger.error after a 4xx branch that falls through', () => {
    const b = block(`
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('After', { error: String(error) });`);
    expect(errorLogsOn4xxPath(b)).toEqual(['After']);
  });

  it('does not accept an exit in an unrelated branch', () => {
    const b = block(`
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
      }
      if (shuttingDown) {
        return;
      }
      logger.error('After', { error: String(error) });`);
    expect(errorLogsOn4xxPath(b)).toEqual(['After']);
  });

  it('treats statusCode-based branching as a 4xx branch', () => {
    const b = block(`
      if (error.statusCode < 500) {
        res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('After', { error: String(error) });`);
    expect(errorLogsOn4xxPath(b)).toEqual(['After']);
  });

  it('allows logger.error in the else of a 4xx branch and after a branch that exits', () => {
    const elseBranch = block(`
      if (error instanceof BadRequestError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        logger.error('Else', { error: String(error) });
        res.status(500).json({ error: 'Failed' });
      }`);
    const exits = block(`
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Exits', { error: String(error) });
      res.status(500).json({ error: 'Failed' });`);
    const negated = block(`
      if (!(error instanceof AppError)) {
        logger.error('Negated', { error: String(error) });
      }`);
    for (const b of [elseBranch, exits, negated]) expect(errorLogsOn4xxPath(b)).toEqual([]);
  });

  it('flags logRouteError before the response write, allows it after or under headersSent', () => {
    const misordered = block(`
      logRouteError(res, 'Early', error);
      res.status(500).json({ error: 'Failed' });`);
    const ordered = block(`
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed' });
      }
      logRouteError(res, 'Late', error);`);
    const guarded = block(`
      if (res.headersSent) {
        logRouteError(res, 'Streamed', error);
        res.end();
        return;
      }
      res
        .status(500)
        .json({ error: 'Failed' });
      logRouteError(res, 'Late', error);`);
    expect(misorderedRouteLogs(misordered)).toBe(1);
    expect(misorderedRouteLogs(ordered)).toBe(0);
    expect(misorderedRouteLogs(guarded)).toBe(0);
  });

  it('scans try/catch only, never a promise .catch( handler', () => {
    const src = `p.catch((error) => { logger.error('x'); });\ntry { a(); } catch { b(); }`;
    expect(catchBlocks(src)).toHaveLength(1);
  });

  it('ignores braces and keywords inside strings and comments', () => {
    const b = block(`
      // logger.error( } instanceof NotFoundError
      const s = '{ logger.error( }';
      res.status(500).json({ error: s });`);
    expect(errorLogsOn4xxPath(b)).toEqual([]);
  });
});
