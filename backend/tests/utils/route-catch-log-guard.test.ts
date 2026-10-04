/**
 * Guard for #656: a route `catch` that answers an `AppError` itself never
 * writes that outcome at `error` level.
 *
 * The rule (docs/architecture/backend-services.md#logging): expected client
 * outcomes (4xx) are `warn`, `error` is for 5xx and failed external calls.
 * Route catches log through `utils/log-route-error.ts#logRouteError` as their
 * last statement, which reads the status the client actually got. The old
 * shape, `logger.error(...)` first and the `instanceof NotFoundError | …`
 * branching after it, wrote every 403/404 to the on-call error stream.
 *
 * Within every `catch` block under `src/api/`, a `logger.error(` is allowed
 * only after every `instanceof <AppError class>` branch above it has exited
 * (`return` or `next(`), i.e. on the path that answers 5xx.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const BACKEND = path.resolve(__dirname, '../..');
const API = path.join(BACKEND, 'src/api');

const APP_ERROR_CHECK =
  /instanceof\s+(AppError|DetailedError|NotFoundError|ForbiddenError|BadRequestError|UnauthorizedError|ConflictError|PaymentRequiredError|LastHeadCoachError|ResendCooldownError)\b/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Blanks comments and string/template contents so braces inside them are not counted. */
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

/** The body of every `catch (...) { … }` block, with comments and strings masked. */
export function catchBlocks(source: string): string[] {
  return catchBlocksWithLines(source).map((b) => b.body);
}

function catchBlocksWithLines(source: string): { body: string; line: number }[] {
  const code = maskNonCode(source);
  const blocks: { body: string; line: number }[] = [];
  const head = /\bcatch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    blocks.push({ body: code.slice(start, i - 1), line: code.slice(0, m.index).split('\n').length });
  }
  return blocks;
}

/** Offending `logger.error(` positions in one catch body (empty when it follows the rule). */
export function errorLogsOn4xxPath(block: string): number[] {
  const checks = [...block.matchAll(APP_ERROR_CHECK)].map((c) => c.index ?? 0);
  if (checks.length === 0) return [];
  const offenders: number[] = [];
  for (const log of block.matchAll(/\blogger\.error\(/g)) {
    const at = log.index ?? 0;
    const firstCheck = checks[0];
    if (at < firstCheck) {
      // Logged before the branching: every 4xx outcome goes to `error`.
      offenders.push(at);
      continue;
    }
    // After a check: the 4xx branch above must have exited first.
    const between = block.slice(firstCheck, at);
    if (!/\breturn\b|\bnext\(/.test(between)) offenders.push(at);
  }
  return offenders;
}

describe('route catches log 4xx outcomes at warn (#656)', () => {
  const files = sourceFiles(API);

  it('scans the route files', () => {
    // A guard that reads nothing passes for the wrong reason.
    const routers = files.filter((f) => /routes\.ts$|calendar\.ts$/.test(f));
    expect(routers.length).toBeGreaterThanOrEqual(12);
    const blocks = files.flatMap((f) => catchBlocks(readFileSync(f, 'utf8')));
    expect(blocks.length).toBeGreaterThan(80);
    expect(blocks.filter((b) => b.includes('logRouteError(')).length).toBeGreaterThan(70);
  });

  it('no catch block logs an AppError outcome at error level', () => {
    const offenders = files.flatMap((file) =>
      catchBlocksWithLines(readFileSync(file, 'utf8'))
        .filter(({ body }) => errorLogsOn4xxPath(body).length > 0)
        .map(({ line }) => `${path.relative(BACKEND, file)}:${line} (use logRouteError)`)
    );
    expect(offenders).toEqual([]);
  });
});

describe('the guard', () => {
  const wrap = (body: string): string => `try { x(); } catch (error) {\n${body}\n}`;

  it('flags logger.error ahead of the 4xx branching (the shape #656 removed)', () => {
    const src = wrap(`
      logger.error('Error getting team', { error: String(error) });
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed' });
      }`);
    expect(errorLogsOn4xxPath(catchBlocks(src)[0])).toHaveLength(1);
  });

  it('flags logger.error after a 4xx branch that falls through', () => {
    const src = wrap(`
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
      }
      logger.error('Error', { error: String(error) });`);
    expect(errorLogsOn4xxPath(catchBlocks(src)[0])).toHaveLength(1);
  });

  it('allows logRouteError and an error log on the 5xx path after the 4xx branch exits', () => {
    const helper = wrap(`
      if (error instanceof AppError) {
        res.status(error.statusCode).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed' });
      }
      logRouteError(res, 'Error', error);`);
    const exits = wrap(`
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Error', { error: String(error) });
      res.status(500).json({ error: 'Failed' });`);
    const plain500 = wrap(`
      logger.error('Error', { error: String(error) });
      res.status(500).json({ error: 'Failed' });`);
    for (const src of [helper, exits, plain500]) {
      expect(errorLogsOn4xxPath(catchBlocks(src)[0])).toEqual([]);
    }
  });

  it('ignores braces and keywords inside strings and comments', () => {
    const src = wrap(`
      // logger.error( } instanceof NotFoundError
      const s = '{ logger.error( }';
      res.status(500).json({ error: s });`);
    expect(catchBlocks(src)).toHaveLength(1);
    expect(errorLogsOn4xxPath(catchBlocks(src)[0])).toEqual([]);
  });
});
