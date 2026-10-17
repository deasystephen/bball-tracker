/**
 * Shared helpers for the config-bound tests that read `infra/*.tf`
 * (`prevent-destroy.test.ts`, `ses-events.test.ts`).
 *
 * This is not an HCL parser. It is a small scanner that knows the three things
 * that can hide or fake a brace or an attribute: comments (`#`, `//`, `/* *\/`),
 * quoted strings (with `\` escapes and `${…}` interpolations, which may nest
 * further strings) and heredocs (`<<EOF` / `<<-EOF`). Every extraction fails
 * loudly when the block cannot be found, so a file that changed shape turns
 * the calling test red instead of letting it pass vacuously.
 */

interface Scanned {
  /** The source with every comment blanked to spaces (newlines kept, so offsets line up). */
  code: string;
  /** `true` at every offset that is HCL structure: not inside a string, heredoc or comment. */
  structural: boolean[];
}

type Frame = { mode: 'code'; depth: number; interpolation: boolean } | { mode: 'string' };

function scan(source: string): Scanned {
  const code = source.split('');
  const structural = new Array<boolean>(source.length).fill(false);
  const stack: Frame[] = [{ mode: 'code', depth: 0, interpolation: false }];
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to; j += 1) if (code[j] !== '\n') code[j] = ' ';
  };

  let i = 0;
  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const c = source[i];
    const next = source[i + 1];

    if (frame.mode === 'string') {
      if (c === '\\') {
        i += 2;
      } else if (c === '$' && next === '{') {
        stack.push({ mode: 'code', depth: 0, interpolation: true });
        i += 2;
      } else {
        if (c === '"') stack.pop();
        i += 1;
      }
      continue;
    }

    if (c === '#' || (c === '/' && next === '/')) {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const heredoc = c === '<' ? /^<<-?([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n/.exec(source.slice(i)) : null;
    if (heredoc) {
      const terminator = new RegExp(`^[ \\t]*${heredoc[1]}[ \\t]*$`, 'm');
      const bodyStart = i + heredoc[0].length;
      const end = terminator.exec(source.slice(bodyStart));
      i = end ? bodyStart + end.index + end[0].length : source.length;
      continue;
    }
    if (c === '"') {
      stack.push({ mode: 'string' });
      i += 1;
      continue;
    }
    if (c === '}' && frame.interpolation && frame.depth === 0) {
      stack.pop();
      i += 1;
      continue;
    }
    if (c === '{') frame.depth += 1;
    if (c === '}') frame.depth -= 1;
    structural[i] = true;
    i += 1;
  }
  return { code: code.join(''), structural };
}

/** The source with every comment blanked, string contents untouched. */
export function stripComments(source: string): string {
  return scan(source).code;
}

/** Returns the text between the structural `{` ending at `openEnd` and its matching `}`. */
function braceBody(scanned: Scanned, openEnd: number, what: string): string {
  let depth = 1;
  for (let i = openEnd; i < scanned.code.length; i += 1) {
    if (!scanned.structural[i]) continue;
    if (scanned.code[i] === '{') depth += 1;
    if (scanned.code[i] === '}') depth -= 1;
    if (depth === 0) return scanned.code.slice(openEnd, i);
  }
  throw new Error(`${what} has no closing brace.`);
}

/**
 * Returns the body of `<kind> "<type>" "<name>" { … }` (comments blanked),
 * brace-matched. Throws when the header is missing or commented out.
 */
export function extractBlock(source: string, kind: string, type: string, name: string, label: string): string {
  const scanned = scan(source);
  const header = new RegExp(`^${kind}\\s+"${type}"\\s+"${name}"\\s*\\{`, 'm').exec(scanned.code);
  if (!header) {
    throw new Error(
      `${label}: could not find ${kind} "${type}" "${name}". If the file changed shape, update the ` +
        'calling test in backend/tests/infra/ — do not let it pass vacuously.',
    );
  }
  return braceBody(scanned, header.index + header[0].length, `${label}: ${kind} "${type}" "${name}"`);
}

/**
 * True when a resource body has a `lifecycle { … }` sub-block whose
 * `prevent_destroy` is `true`. A trailing comment on the line is allowed.
 */
export function hasPreventDestroy(block: string, label: string): boolean {
  const scanned = scan(block);
  const header = /^\s*lifecycle\s*\{/m.exec(scanned.code);
  if (!header) return false;
  const lifecycle = braceBody(scanned, header.index + header[0].length, `${label} lifecycle`);
  return /^\s*prevent_destroy\s*=\s*true\s*$/m.test(lifecycle);
}
