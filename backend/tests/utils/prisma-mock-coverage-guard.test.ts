/**
 * Guard for #766: the shared Prisma mock (`tests/setup.ts#mockPrisma`) defines
 * every delegate method that `src/` calls.
 *
 * An API test that runs a real service against the shared mock (validation →
 * route → service, the path production runs) dies with
 * `TypeError: tx.teamMember.upsert is not a function` the first time it reaches
 * a delegate method the mock lacks. `$transaction` hands the callback
 * `mockPrisma` itself, so `tx.<model>.<method>` needs the same method.
 *
 * Source-derived, never a hand list: the model names come from the generated
 * client (`Prisma.ModelName`) and the calls from `src/`, with any receiver
 * (`prisma`, `tx`, `db`, or the next alias someone writes) and any whitespace
 * or line break between the parts. When this fails, add the named method to
 * the matching block in `tests/setup.ts` as `<method>: jest.fn()`.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { mockPrisma } from '../setup';

const BACKEND = path.resolve(__dirname, '../..');
const SRC = path.join(BACKEND, 'src');

/** Model delegate names as they appear on the client: `TeamMember` → `teamMember`. */
const MODEL_DELEGATES = Object.values(Prisma.ModelName).map(
  (name) => name.charAt(0).toLowerCase() + name.slice(1)
);

/** Every operation a Prisma model delegate exposes. */
const DELEGATE_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
];

const DELEGATE_CALL = new RegExp(
  `\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(${MODEL_DELEGATES.join('|')})\\s*\\.\\s*(${DELEGATE_OPERATIONS.join('|')})\\s*\\(`,
  'g'
);
/** Client-level methods: `prisma.$transaction(…)`, ``tx.$queryRaw`…` ``. */
const CLIENT_CALL = /\b[A-Za-z_][\w]*\s*\.\s*(\$[A-Za-z]+)\s*[(`]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `model.method` for every delegate call, `$method` for every client call. */
export function findPrismaCalls(source: string): string[] {
  const code = stripComments(source);
  const delegate = [...code.matchAll(DELEGATE_CALL)].map(([, model, op]) => `${model}.${op}`);
  const client = [...code.matchAll(CLIENT_CALL)].map(([, method]) => method);
  return [...delegate, ...client];
}

/** The calls in `calls` that `mock` does not define as a function. */
export function missingFromMock(calls: Iterable<string>, mock: object): string[] {
  const root = mock as Record<string, unknown>;
  return [...new Set(calls)]
    .filter((call) => {
      const [first, second] = call.split('.');
      if (second === undefined) return typeof root[first] !== 'function';
      const delegate = root[first] as Record<string, unknown> | undefined;
      return typeof delegate?.[second] !== 'function';
    })
    .sort();
}

describe('the shared Prisma mock covers every call in src/ (#766)', () => {
  const files = sourceFiles(SRC);
  const callsByFile = files.map((file) => ({
    file: path.relative(BACKEND, file),
    calls: findPrismaCalls(readFileSync(file, 'utf8')),
  }));
  const allCalls = callsByFile.flatMap(({ calls }) => calls);

  it('scans the backend source and finds the calls it is meant to', () => {
    // A guard that reads nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(MODEL_DELEGATES.length).toBeGreaterThan(15);
    expect(new Set(allCalls).size).toBeGreaterThan(100);
    // One per receiver the source uses today: the client, a transaction, a `db` parameter.
    expect(allCalls).toEqual(
      expect.arrayContaining(['teamMember.upsert', 'teamInvitation.findUniqueOrThrow', 'teamRole.createMany', '$transaction'])
    );
  });

  it('finds no delegate method that src/ calls and mockPrisma lacks', () => {
    const offenders = missingFromMock(allCalls, mockPrisma).map((call) => {
      const where = callsByFile.filter(({ calls }) => calls.includes(call)).map(({ file }) => file);
      return `${call} (called in ${where.join(', ')})`;
    });

    expect(offenders).toEqual([]);
  });
});

describe('the guard pattern', () => {
  it.each([
    ['await prisma.teamMember.upsert({', ['teamMember.upsert']],
    ['return tx.teamInvitation.findUniqueOrThrow({ where })', ['teamInvitation.findUniqueOrThrow']],
    ['db.teamRole.createMany({ data })', ['teamRole.createMany']],
    ['await client\n  .game\n  .findMany({', ['game.findMany']],
    ['await prisma.$transaction(async (tx) => {', ['$transaction']],
    ['await tx.$queryRaw`SELECT 1`', ['$queryRaw']],
  ])('reports %j', (source, expected) => {
    expect(findPrismaCalls(source)).toEqual(expected);
  });

  it.each([
    ['// prisma.teamMember.upsert({'],
    ['/* tx.teamInvitation.findUniqueOrThrow( */'],
    ['req.user.id'],
    ['prisma.notAModel.findMany('],
    ['prisma.team.notAnOperation('],
    ["const shape = 'team.findMany';"],
  ])('ignores %j', (source) => {
    expect(findPrismaCalls(source)).toEqual([]);
  });

  it('names a method the mock lacks, a model the mock lacks and a missing client method', () => {
    const mock = { team: { findMany: jest.fn() }, $transaction: jest.fn() };
    expect(
      missingFromMock(['team.findMany', 'team.upsert', 'game.findMany', '$transaction', '$queryRaw'], mock)
    ).toEqual(['$queryRaw', 'game.findMany', 'team.upsert']);
  });
});
