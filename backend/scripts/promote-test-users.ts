/**
 * Promote E2E test users (the `<base>+<persona>@<domain>` aliases) to the roles the
 * v2.0 E2E test plan needs — for one or more tester inboxes.
 *
 * Why this script exists:
 *  - WorkOS signup always creates users as PLAYER (ADMIN only via ADMIN_EMAILS), see
 *    src/services/workos-service.ts. Re-login never overwrites `role`, so DB changes stick.
 *  - Creating a team requires `User.role === 'COACH'` (src/services/team-service.ts), so the
 *    head-coach alias must be bumped BEFORE it can create a team.
 *  - The staff-assignment and guardian endpoints are NOT implemented (only Zod schemas are
 *    stubbed in src/api/teams/schemas.ts), so ASSISTANT_COACH / TEAM_MANAGER / PARENT can only
 *    be set by writing to the DB — which is what this script does.
 *
 * Tester accounts:
 *  Every base inbox gets the same persona set (`+headcoach`, `+player`, `+asstcoach`,
 *  `+manager`, `+parent`). Supply the base inboxes (comma- or space-separated) via
 *  `--accounts=` or the `TEST_ACCOUNTS` env var; the default is the single original inbox.
 *  Each tester's head coach is expected to create their own team named TEAM_NAME
 *  (override with `--team=`); the post phase resolves the team through that tester's
 *  head-coach staff row, so identically named teams from different testers don't collide.
 *
 * Run order (per tester):
 *  1. All aliases sign in once via WorkOS (creates the User rows).
 *  2. Run with `--phase=pre`  -> bumps headcoach -> COACH and parent -> PARENT.
 *  3. ADMIN creates the League + Season in-app (test C.1/C.2).
 *  4. Head coach creates "Test Team" in-app (test D.1) -> auto Head Coach + default team roles.
 *  5. The +player alias joins the team (invite-accept E.1->E.5, or a TeamMember insert).
 *  6. Run with `--phase=post` -> inserts TeamStaff (asst coach + manager) and the Guardian link.
 *  Run with no flag (or `--phase=all`) to attempt both phases in one go.
 *
 * Usage (point DATABASE_URL at the PRODUCTION RDS instance you are testing against):
 *   cd backend
 *   DATABASE_URL="<prod-url>" npx tsx scripts/promote-test-users.ts --phase=pre
 *   DATABASE_URL="<prod-url>" npx tsx scripts/promote-test-users.ts --phase=post
 *   DATABASE_URL="<prod-url>" npx tsx scripts/promote-test-users.ts \
 *     --accounts=deasystephen@gmail.com,tester@example.com --phase=pre
 *   TEST_ACCOUNTS="deasystephen@gmail.com tester@example.com" npx tsx scripts/promote-test-users.ts
 *
 * Safe to re-run: role updates are idempotent and inserts use skipDuplicates. A tester whose
 * aliases haven't signed in yet is reported and skipped; the others still get processed and
 * the script exits non-zero so the gap isn't missed.
 */
import prisma from '../src/models';

// ---- Config: tweak here if your alias scheme or team name differs ----------
const DEFAULT_ACCOUNTS = ['deasystephen@gmail.com'];
const DEFAULT_TEAM_NAME = 'Test Team';

type Persona = 'headcoach' | 'player' | 'asstcoach' | 'manager' | 'parent';

// ---- CLI / env parsing -----------------------------------------------------
const argValue = (flag: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);

const phase = (argValue('phase') ?? 'all') as 'pre' | 'post' | 'all';
if (!['pre', 'post', 'all'].includes(phase)) {
  console.error(`Unknown --phase=${phase} (expected pre | post | all)`);
  process.exit(1);
}
const TEAM_NAME = argValue('team') ?? process.env.TEST_TEAM_NAME ?? DEFAULT_TEAM_NAME;

export function parseAccounts(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_ACCOUNTS;
  const accounts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Report by position rather than echoing the value: the list comes from the environment /
  // CLI and gets printed by the top-level error handler.
  accounts.forEach((account, i) => {
    if (!/^[^\s@+]+@[^\s@]+\.[^\s@]+$/.test(account)) {
      throw new Error(
        `Invalid base account at position ${i + 1} of ${accounts.length} — expected a plain ` +
          `address like name@example.com (no "+alias"; personas are appended automatically).`,
      );
    }
  });
  return [...new Set(accounts)];
}

export const aliasEmail = (account: string, persona: Persona): string => {
  const [local, domain] = account.split('@');
  return `${local}+${persona}@${domain}`;
};

// ---- Helpers ---------------------------------------------------------------
async function findUserId(account: string, persona: Persona): Promise<string> {
  const email = aliasEmail(account, persona);
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) {
    throw new Error(`User ${email} not found — has this alias signed in via WorkOS yet?`);
  }
  return user.id;
}

async function bumpRole(account: string, persona: Persona, role: 'COACH' | 'PARENT') {
  const email = aliasEmail(account, persona);
  const updated = await prisma.user.updateMany({ where: { email }, data: { role } });
  if (updated.count === 0) {
    throw new Error(`User ${email} not found — has this alias signed in via WorkOS yet?`);
  }
  console.log(`  ✓ ${email} -> ${role}`);
}

// ---- Phases ----------------------------------------------------------------
async function runPre(account: string) {
  console.log(`Phase: pre — system-role bumps for ${account}`);
  await bumpRole(account, 'headcoach', 'COACH');
  await bumpRole(account, 'parent', 'PARENT');
}

async function runPost(account: string) {
  console.log(`Phase: post — team staff + guardian for ${account} (team: "${TEAM_NAME}")`);

  const headCoachId = await findUserId(account, 'headcoach');

  // Resolve the team through this tester's head coach so that several testers can each
  // own a team with the same name without the script picking the wrong one.
  const team = await prisma.team.findFirst({
    where: { name: TEAM_NAME, staff: { some: { userId: headCoachId } } },
  });
  if (!team) {
    throw new Error(
      `Team "${TEAM_NAME}" with ${aliasEmail(account, 'headcoach')} on staff not found — ` +
        `the head coach must create it in-app first (test D.1).`,
    );
  }

  const roleByName = async (name: string) => {
    const role = await prisma.teamRole.findFirst({ where: { teamId: team.id, name } });
    if (!role) {
      throw new Error(
        `TeamRole "${name}" not found on team ${team.id}. Default roles are created on team ` +
          `creation — confirm the team was made via the app, not inserted manually.`,
      );
    }
    return role;
  };

  const assistantRole = await roleByName('Assistant Coach');
  const managerRole = await roleByName('Team Manager');

  const staff = await prisma.teamStaff.createMany({
    skipDuplicates: true,
    data: [
      { teamId: team.id, userId: await findUserId(account, 'asstcoach'), roleId: assistantRole.id },
      { teamId: team.id, userId: await findUserId(account, 'manager'), roleId: managerRole.id },
    ],
  });
  console.log(`  ✓ TeamStaff inserted (asst coach + manager): ${staff.count} new row(s)`);

  // Parent must be a guardian of the player who is actually on the team, so the
  // parent's read access (test Q.7) resolves through Guardian -> child -> TeamMember.
  const guardian = await prisma.guardian.createMany({
    skipDuplicates: true,
    data: [
      {
        parentId: await findUserId(account, 'parent'),
        childId: await findUserId(account, 'player'),
        relationship: 'MOTHER', // MOTHER | FATHER | GUARDIAN | OTHER
        isPrimary: true,
      },
    ],
  });
  console.log(`  ✓ Guardian link (parent -> player): ${guardian.count} new row(s)`);
}

async function main() {
  const accounts = parseAccounts(argValue('accounts') ?? process.env.TEST_ACCOUNTS);
  console.log(`Tester accounts (${accounts.length}): ${accounts.join(', ')}\n`);

  const failures: string[] = [];
  for (const account of accounts) {
    try {
      if (phase === 'pre' || phase === 'all') await runPre(account);
      if (phase === 'post' || phase === 'all') await runPost(account);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${account}: ${message}`);
      failures.push(account);
    }
    console.log('');
  }

  if (failures.length > 0) {
    console.error(`Done with errors for ${failures.length}/${accounts.length} account(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Done.');
  }
}

main()
  .catch((err) => {
    console.error('Promotion failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
