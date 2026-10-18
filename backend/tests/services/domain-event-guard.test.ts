/**
 * Guard for #686: every service method that mutates data logs one info-level
 * domain event (CLAUDE.md, "URLs, email and logging";
 * `docs/architecture/backend-services.md#logging`).
 *
 * The rule used to be followed only by the methods #617 enumerated, so leagues,
 * seasons, players, staff, RSVPs and game events left no audit line at all.
 * This suite scans every file under `src/services/`, finds each `static`
 * method and each top-level `function` (async or not, generic or not), and
 * fails when a body that writes through Prisma (`prisma.<model>.<write>(`,
 * `tx.<model>.<write>(`, `$transaction(` or `$executeRaw`) contains no
 * `logger.info(` call.
 *
 * A method also counts as logging when it calls a same-file helper named
 * `log<Something>` whose own body contains `logger.info(` (one level only):
 * `InvitationService.addRosterPlayer` emits its events through
 * `logRosterAdd`, which every exit path calls. Only `log*` helpers count, so an
 * unrelated callee that happens to log something else at info (a refusal, say)
 * never stands in for the domain event.
 *
 * What it cannot see: a method that writes only through a helper it calls. The
 * helper is then the method that is flagged; when the caller already logs the
 * event, the helper goes in `ALLOWED` with the reason, so the list documents
 * every exception.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { sourceFiles, stripComments } from '../support/source-scan';

const BACKEND = path.resolve(__dirname, '../..');
const SERVICES = path.join(BACKEND, 'src/services');

/**
 * `<file relative to src/services>#<method>` → why it logs no info-level event.
 * Keep each reason specific; "it is fine" is not one.
 */
const ALLOWED: Record<string, string> = {
  // In-transaction helpers: the public method that calls them logs the event.
  'game-event-service.ts#recomputeHomeScore':
    'derives Game.homeScore inside createEvent/deleteEvent, which log `Game event created` / `deleted`',
  'guardian-service.ts#promoteNextPrimary':
    'runs inside guardian unlink and account deletion, which log `Guardian unlinked` / the deletion',
  'guardian-service.ts#resolveAcceptingParent':
    'provisions the parent row inside guardian accept, which logs `Guardian linked`',
  'invitation-service.ts#createInvitationRow':
    'inserts the row for createInvitation and Add Player, which log `Invitation sent`',
  'invitation-service.ts#createRosteredInvitedPlayer':
    'Add Player case 2 transaction; addRosterPlayer logs `Roster player added` and `Invitation sent`',
  'invitation-service.ts#transitionPending':
    'status-guarded PENDING exit inside accept/reject/cancel, which log `Invitation accepted` / `declined` / `cancelled`',
  'invitation-service.ts#stripUnclaimedEmail':
    'consent guard inside rejectInvitation, which logs `Invitation declined`',
  'invitation-service.ts#expireOldInvitations':
    'bulk expiry kept for a future maintenance job; nothing calls it today',
  // The SES event consumer (#449): background work driven by SES
  // notifications, not by a request. `applySesEvent` logs each outcome itself.
  'mailer/ses-events.ts#suppress': 'SES consumer: flags bounced/complained rows; applySesEvent logs the outcome',
  'mailer/ses-events.ts#clear': 'SES consumer: clears the flag on delivery; applySesEvent logs the outcome',
};

const MUTATION =
  /\b(?:prisma|tx)\.\w+\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|delete|deleteMany|upsert)\(|\$transaction\(|\$executeRaw/;

/**
 * Every `static` method and top-level `function`, async or not, generic or not.
 * Non-async ones count because `return prisma.x.deleteMany(…)` without `await`
 * is a write too (the shape `NotificationService.removeToken` had before #686).
 */
const METHOD =
  /\bstatic\s+(?:async\s+)?(\w+)\s*[(<]|^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm;

/** Index of the bracket matching `source[open]`. */
function matchingClose(source: string, open: number): number {
  const opener = source[open];
  const closer = opener === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opener) depth++;
    else if (source[i] === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return source.length - 1;
}

/**
 * The `{` that opens the body after a parameter list closing at `paramsClose`.
 * Skips a return type annotation, whose `Promise<{ … }>` braces sit inside
 * angle brackets.
 */
function bodyOpen(source: string, paramsClose: number): number {
  let angle = 0;
  for (let i = paramsClose + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '<') angle++;
    else if (ch === '>' && source[i - 1] !== '=') angle--;
    else if (ch === '{' && angle === 0) return i;
  }
  return -1;
}

export interface ScannedMethod {
  name: string;
  body: string;
}

/** Every method in comment-stripped `code` (see `METHOD`), with its body. */
function scan(code: string): ScannedMethod[] {
  const methods: ScannedMethod[] = [];
  for (const match of code.matchAll(METHOD)) {
    const name = match[1] ?? match[2];
    let paramsOpen = (match.index ?? 0) + match[0].length - 1;
    if (code[paramsOpen] === '<') paramsOpen = code.indexOf('(', paramsOpen);
    const open = bodyOpen(code, matchingClose(code, paramsOpen));
    if (open === -1) continue;
    methods.push({ name, body: code.slice(open, matchingClose(code, open) + 1) });
  }
  return methods;
}

/** Names of the methods in `source` that write through Prisma and log no `logger.info(`. */
export function findSilentMutations(source: string): string[] {
  const methods = scan(stripComments(source));
  // Built only when a mutating body has no `logger.info(` of its own.
  let loggers: string[] | undefined;
  const callsLogHelper = (body: string): boolean => {
    loggers ??= methods
      .filter(({ name, body: b }) => /^log[A-Z]/.test(name) && b.includes('logger.info('))
      .map(({ name }) => name);
    return loggers.some((name) => new RegExp(`\\b${name}\\(`).test(body));
  };
  return methods
    .filter(({ body }) => MUTATION.test(body) && !body.includes('logger.info(') && !callsLogHelper(body))
    .map(({ name }) => name);
}

describe('every mutating service method logs a domain event (#686)', () => {
  let files: string[] = [];
  // `<file relative to src/services>#<method>` for every silent mutating method.
  let silent: string[] = [];
  beforeAll(() => {
    files = sourceFiles(SERVICES);
    silent = files.flatMap((file) => {
      const rel = path.relative(SERVICES, file);
      return findSilentMutations(readFileSync(file, 'utf8')).map((name) => `${rel}#${name}`);
    });
  });

  it('scans the service layer', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain(path.join(SERVICES, 'season-service.ts'));
    expect(files).toContain(path.join(SERVICES, 'mailer/ses-events.ts'));
  });

  it('finds no mutating method without logger.info outside the allowlist', () => {
    expect(silent.filter((key) => !(key in ALLOWED))).toEqual([]);
  });

  it('keeps every allowlist entry live (no stale exceptions)', () => {
    expect(Object.keys(ALLOWED).filter((key) => !silent.includes(key))).toEqual([]);
  });

  describe('the scanner', () => {
    it('flags a static async method that writes and does not log', () => {
      const source = `
        export class S {
          static async deleteThing(id: string): Promise<{ success: true }> {
            await prisma.thing.delete({ where: { id } });
            return { success: true };
          }
        }`;
      expect(findSilentMutations(source)).toEqual(['deleteThing']);
    });

    it('flags a $transaction and a top-level async function', () => {
      const source = `
        async function helper(tx: Tx): Promise<void> {
          await tx.thing.update({ where: { id: '1' }, data: {} });
        }
        export class S {
          static async run(): Promise<void> {
            await prisma.$transaction(async (tx) => helper(tx));
          }
        }`;
      expect(findSilentMutations(source)).toEqual(['helper', 'run']);
    });

    it('passes a method that logs, and ignores reads and commented-out writes', () => {
      const source = `
        export class S {
          static async createThing(): Promise<Thing> {
            const thing = await prisma.thing.create({ data: {} });
            logger.info('Thing created', { thingId: thing.id });
            return thing;
          }
          static async getThing(id: string): Promise<{ id: string } | null> {
            // await prisma.thing.delete({ where: { id } });
            return prisma.thing.findUnique({ where: { id } });
          }
        }`;
      expect(findSilentMutations(source)).toEqual([]);
    });

    it('counts a call to a same-file helper that logs', () => {
      const source = `
        export class S {
          private static logAdd(id: string): void {
            logger.info('Thing added', { id });
          }
          static async addThing(): Promise<void> {
            const thing = await prisma.thing.create({ data: {} });
            this.logAdd(thing.id);
          }
        }`;
      expect(findSilentMutations(source)).toEqual([]);
    });

    it('does not count a callee that is not a log* helper', () => {
      const source = `
        export class S {
          private static async assertAllowed(): Promise<void> {
            logger.info('Thing refused', {});
          }
          static async addThing(): Promise<void> {
            await this.assertAllowed();
            await prisma.thing.create({ data: {} });
          }
        }`;
      expect(findSilentMutations(source)).toEqual(['addThing']);
    });

    it('flags a generic method', () => {
      const source = `
        export class S {
          private static async move<T extends Sel>(tx: Tx, select: T): Promise<Payload<T>> {
            await tx.thing.updateMany({ where: {}, data: {} });
            return tx.thing.findUniqueOrThrow({ where: {}, select });
          }
        }`;
      expect(findSilentMutations(source)).toEqual(['move']);
    });

    it('flags a non-async method that returns a write promise without await', () => {
      const source = `
        export class S {
          static removeThing(id: string): Promise<Prisma.BatchPayload> {
            return prisma.thing.deleteMany({ where: { id } });
          }
        }
        function dropAll(): Promise<Prisma.BatchPayload> {
          return prisma.thing.deleteMany({});
        }`;
      expect(findSilentMutations(source)).toEqual(['removeThing', 'dropAll']);
    });

    it('does not count a logger.warn as the domain event', () => {
      const source = `
        export class S {
          static async removeThing(id: string): Promise<void> {
            await prisma.thing.deleteMany({ where: { id } });
            logger.warn('Thing removed', { id });
          }
        }`;
      expect(findSilentMutations(source)).toEqual(['removeThing']);
    });
  });
});
