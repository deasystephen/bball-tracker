/**
 * Guard for #656 and #831: a route `try/catch` answers its error through
 * `utils/respond-with-error.ts#respondWithError`, the one path that answers
 * every `AppError` with its own status (a `DetailedError` with its `body()`),
 * everything else with the route's 500 body, and logs by the status sent
 * (4xx at `warn`, 5xx at `error`; docs/architecture/backend-services.md#logging).
 *
 * The shapes it replaced: a per-route `instanceof NotFoundError | …` allow-list
 * that answered 500 for any `AppError` it forgot (#831), and a bare
 * `logger.error(...)` that wrote every 403/404 to the on-call stream (#656).
 *
 * In every `try { … } catch (e) { … }` block under `src/api/`:
 * - a catch that binds the error answers only through `respondWithError(`:
 *   any direct response write (`res.status(…)`, `res.json(…)`, …), whether an
 *   `instanceof` allow-list or a pre-branch ahead of the helper, fails unless
 *   the catch is a listed deliberate exception;
 * - a `logger.error(` appears only where `ALLOWED_ERROR_LOGS` lists it.
 *
 * Comments, strings, template text and regex literals are masked before
 * scanning, so braces and quotes inside them do not desync the block matcher.
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
 * Catches that write a response themselves, by file and a string the catch
 * contains. Each answers an outcome the helper's rules would get wrong.
 */
const ANSWERS_WITHOUT_HELPER: Array<{ file: string; marker: string }> = [
  // Auth callback 409 (email bound to a different WorkOS user) answers its
  // message but logs at `error` and goes to Sentry: the WorkOS key cutover
  // (#24) lockout signature. Every other callback error uses the helper.
  { file: 'auth/routes.ts', marker: 'Auth callback email linked to a different WorkOS user' },
  // POST /auth/refresh: maps the WorkOS SDK's HTTP `status` (429 → 429, none
  // or 5xx → 503, other 4xx → 401) so a transient failure never logs the
  // mobile client out (audit #20).
  { file: 'auth/routes.ts', marker: 'WorkOS rate-limited refresh' },
  // POST /auth/logout: a failed WorkOS revoke still answers 200
  // `{ revoked: false }`; the local session is gone either way.
  { file: 'auth/routes.ts', marker: 'Failed to revoke WorkOS session on logout' },
];

/**
 * Direct `logger.error` calls in a catch, by file and log message. Each is an
 * outcome that must reach the error stream whatever the status.
 */
const ALLOWED_ERROR_LOGS: Array<{ file: string; message: string }> = [
  // 409 on sign-in: an email bound to a different WorkOS user. The WorkOS key
  // cutover (#24) would send every sign-in here (every production row carries
  // a staging WorkOS id), and the alarms key on @level:error.
  { file: 'auth/routes.ts', message: 'Auth callback email linked to a different WorkOS user' },
  // Failed external calls (WorkOS), answered 503 and 200 respectively.
  { file: 'auth/routes.ts', message: 'WorkOS unavailable during refresh' },
  { file: 'auth/routes.ts', message: 'Failed to revoke WorkOS session on logout' },
];

const RESPONSE_WRITE = /\bres\s*\.\s*(?:status|json|send|sendStatus|end|redirect)\s*\(/;

/** A `/` after one of these (or a keyword like `return`) opens a regex literal, not a division. */
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*$/;

/** Blanks comments, string/template contents and regex literals (keeping offsets) so braces in them are not counted. */
export function maskNonCode(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next !== '/' && next !== '*' && BEFORE_REGEX.test(out.slice(-20))) {
      out += c;
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n' && (inClass || source[i] !== '/')) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        out += ' ';
        i++;
      }
      out += source[i] ?? '';
      i++;
    } else if (c === '/' && next === '/') {
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

/** Index of the brace closing the one at `open`. */
function matching(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

interface Block {
  /** Catch body, comments and strings masked. */
  body: string;
  /** Catch body, original text (same offsets). */
  raw: string;
  /** `catch (error)` rather than a bare `catch {`. */
  bindsError: boolean;
  line: number;
}

/** The body of every `try { … } catch (…) { … }` block; promise `.catch(` handlers are not matched. */
export function catchBlocks(source: string): Block[] {
  const code = maskNonCode(source);
  const blocks: Block[] = [];
  const head = /\}\s*catch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matching(code, open);
    blocks.push({
      body: code.slice(open + 1, close),
      raw: source.slice(open + 1, close),
      bindsError: m[1] !== undefined,
      line: code.slice(0, m.index).split('\n').length,
    });
  }
  return blocks;
}

/** A catch that writes a response itself instead of (or ahead of) `respondWithError`. */
export function answersWithoutHelper(block: Block): boolean {
  return block.bindsError && RESPONSE_WRITE.test(block.body);
}

/** Messages of every `logger.error(` call in one catch block. */
export function errorLogs(block: Block): string[] {
  return [...block.body.matchAll(/\blogger\.error\(\s*/g)].map((log) => {
    const msg = /^['"`]([^'"`]*)/.exec(block.raw.slice((log.index ?? 0) + log[0].length));
    return msg ? msg[1] : '(dynamic message)';
  });
}

describe('route catches answer through respondWithError (#656, #831)', () => {
  let files: string[] = [];
  beforeAll(() => {
    files = sourceFiles(API);
  });
  const rel = (file: string): string => path.relative(API, file);
  const isException = (file: string, block: Block): boolean =>
    ANSWERS_WITHOUT_HELPER.some((e) => e.file === rel(file) && block.raw.includes(e.marker));

  it.each(ROUTERS)('scans %s', (router) => {
    // A guard that reads nothing passes for the wrong reason.
    const file = path.join(API, router);
    expect(existsSync(file)).toBe(true);
    expect(catchBlocks(readFileSync(file, 'utf8')).length).toBeGreaterThan(0);
  });

  it('every catch answers an error only through respondWithError', () => {
    const offenders = files.flatMap((file) =>
      catchBlocks(readFileSync(file, 'utf8'))
        .filter((block) => answersWithoutHelper(block) && !isException(file, block))
        .map((block) => `src/api/${rel(file)}:${block.line} (answer through respondWithError)`)
    );
    expect(offenders).toEqual([]);
  });

  it('no catch block calls logger.error unless it is listed', () => {
    const offenders = files.flatMap((file) =>
      catchBlocks(readFileSync(file, 'utf8')).flatMap((block) =>
        errorLogs(block)
          .filter((message) => !ALLOWED_ERROR_LOGS.some((a) => a.file === rel(file) && a.message === message))
          .map((message) => `src/api/${rel(file)}:${block.line} logger.error('${message}') (use respondWithError)`)
      )
    );
    expect(offenders).toEqual([]);
  });

  it('every listed exception still exists', () => {
    for (const { file, marker } of ANSWERS_WITHOUT_HELPER) {
      const blocks = catchBlocks(readFileSync(path.join(API, file), 'utf8'));
      expect(blocks.filter((b) => b.raw.includes(marker) && answersWithoutHelper(b))).toHaveLength(1);
    }
    for (const { file, message } of ALLOWED_ERROR_LOGS) {
      const blocks = catchBlocks(readFileSync(path.join(API, file), 'utf8'));
      expect(blocks.flatMap(errorLogs)).toContain(message);
    }
  });
});

describe('the guard', () => {
  const block = (body: string): Block => catchBlocks(`try { x(); } catch (error) {\n${body}\n}`)[0];

  it('flags the per-route instanceof allow-list (#831)', () => {
    const b = block(`
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed' });
      }
      logRouteError(res, 'Error getting team', error);`);
    expect(answersWithoutHelper(b)).toBe(true);
  });

  it('flags a bare logger.error in a catch (#656)', () => {
    const b = block(`
      logger.error('Error getting team', { error: String(error) });
      res.status(500).json({ error: 'Failed' });`);
    expect(errorLogs(b)).toEqual(['Error getting team']);
    expect(answersWithoutHelper(b)).toBe(true);
  });

  it('flags a pre-branch that answers ahead of the helper', () => {
    const b = block(`
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: 'Invitation not found' });
        return;
      }
      respondWithError(res, error, { log: 'Error', fallback: 'Failed' });`);
    expect(answersWithoutHelper(b)).toBe(true);
  });

  it('flags logger.error even next to the helper', () => {
    const b = block(`
      logger.error('Twice', { error: String(error) });
      respondWithError(res, error, { log: 'Error', fallback: 'Failed' });`);
    expect(errorLogs(b)).toEqual(['Twice']);
    expect(answersWithoutHelper(b)).toBe(false);
  });

  it('accepts the helper alone', () => {
    const b = block(`respondWithError(res, error, { log: 'Error', fallback: 'Failed', notFound: 'Gone' });`);
    expect(answersWithoutHelper(b)).toBe(false);
    expect(errorLogs(b)).toEqual([]);
  });

  it('ignores a catch that answers nothing or binds no error', () => {
    const rethrow = block(`if (error instanceof NotFoundError) return fallback(); throw error;`);
    const forward = block(`next(error);`);
    const bare = catchBlocks(`try { x(); } catch {\n res.status(400).json({ error: 'Bad URL' });\n}`)[0];
    for (const b of [rethrow, forward, bare]) expect(answersWithoutHelper(b)).toBe(false);
  });

  it('masks regex literals, so a quote or brace inside one does not desync the scan', () => {
    const src = `try { a(); } catch (error) {\n  const re = /['{]+/g;\n  const half = n / 2;\n  res.status(500).json({ error: 'x' });\n}\nconst after = 1;`;
    const blocks = catchBlocks(src);
    expect(blocks).toHaveLength(1);
    expect(answersWithoutHelper(blocks[0])).toBe(true);
    expect(blocks[0].raw).not.toContain('after');
    expect(maskNonCode('x = /a{b/; y = c / d;')).toBe('x = /   /; y = c / d;');
  });

  it('scans try/catch only, never a promise .catch( handler', () => {
    const src = `p.catch((error) => { logger.error('x'); });\ntry { a(); } catch { b(); }`;
    expect(catchBlocks(src)).toHaveLength(1);
  });

  it('ignores braces and keywords inside strings and comments', () => {
    const b = block(`
      // logger.error( } res.status(
      const s = '{ logger.error( res.json( }';
      respondWithError(res, error, { log: s, fallback: 'Failed' });`);
    expect(errorLogs(b)).toEqual([]);
    expect(answersWithoutHelper(b)).toBe(false);
  });
});
