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
 * client (`Prisma.ModelName`) and the calls from `src/`. A receiver is any
 * identifier (`prisma`, `tx`, `db`, or the next alias someone writes) or a
 * parenthesised or call expression (`(tx ?? prisma)`, `getClient()`); a type
 * argument (`$queryRaw<Row[]>`) and whitespace or line breaks between the parts
 * are allowed. Optional chaining (`prisma?.team`) and a delegate stored in a
 * variable first (`const d = prisma.team; d.findMany()`) are not seen. When
 * this fails, add the named method to the matching block in `tests/setup.ts`
 * as `<method>: jest.fn()`.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { mockPrisma } from '../setup';
import { sourceFiles, stripComments } from '../support/source-scan';

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

/** An identifier, or the close of a parenthesised or call expression. */
const RECEIVER = String.raw`(?:\b[A-Za-z_$][\w$]*|\))`;
/** An optional type argument: `<Row[]>`, `<{ id: string }[]>`. */
const TYPE_ARGUMENT = String.raw`(?:\s*<[^()\x60;]*>)?`;

const DELEGATE_CALL = new RegExp(
  String.raw`${RECEIVER}\s*\.\s*(${MODEL_DELEGATES.join('|')})\s*\.\s*(${DELEGATE_OPERATIONS.join('|')})${TYPE_ARGUMENT}\s*\(`,
  'g'
);
/** Client-level methods: `prisma.$transaction(…)`, ``tx.$queryRaw<Row[]>`…` ``. */
const CLIENT_CALL = new RegExp(String.raw`${RECEIVER}\s*\.\s*(\$[A-Za-z]+)${TYPE_ARGUMENT}\s*[(\x60]`, 'g');

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
  let callsByFile: Array<{ file: string; calls: string[] }> = [];

  beforeAll(() => {
    callsByFile = sourceFiles(SRC).map((file) => ({
      file: path.relative(BACKEND, file),
      calls: findPrismaCalls(readFileSync(file, 'utf8')),
    }));
  });

  it('scans the backend source and finds calls in it', () => {
    // A guard that reads nothing passes for the wrong reason. Floors only:
    // which calls exist is the service code's business, not this guard's;
    // each receiver shape is proven on fixture strings below.
    expect(callsByFile.length).toBeGreaterThan(50);
    expect(MODEL_DELEGATES.length).toBeGreaterThan(15);
    expect(new Set(callsByFile.flatMap(({ calls }) => calls)).size).toBeGreaterThan(50);
  });

  it('finds no delegate method that src/ calls and mockPrisma lacks', () => {
    const allCalls = callsByFile.flatMap(({ calls }) => calls);
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
    ['const rows = await tx.$queryRaw<LockedGame[]>`SELECT', ['$queryRaw']],
    ['await tx.$queryRaw<{ id: string }[]>`SELECT id`', ['$queryRaw']],
    ['await prisma.$transaction<number>(async (tx) => {', ['$transaction']],
    ['await prisma.team.findMany<Prisma.TeamFindManyArgs>({', ['team.findMany']],
    ['await (tx ?? prisma).teamStaff.deleteMany({', ['teamStaff.deleteMany']],
    ['await getClient().pushToken.upsert({', ['pushToken.upsert']],
    ['await getClient().$executeRaw`DELETE`', ['$executeRaw']],
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
