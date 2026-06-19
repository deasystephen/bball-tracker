/**
 * Promote E2E test users (the `deasystephen+<persona>@gmail.com` aliases) to the
 * roles the v2.0 E2E test plan needs.
 *
 * Why this script exists:
 *  - WorkOS signup always creates users as PLAYER (ADMIN only via ADMIN_EMAIL), see
 *    src/services/workos-service.ts. Re-login never overwrites `role`, so DB changes stick.
 *  - Creating a team requires `User.role === 'COACH'` (src/services/team-service.ts), so the
 *    head-coach alias must be bumped BEFORE it can create a team.
 *  - The staff-assignment and guardian endpoints are NOT implemented (only Zod schemas are
 *    stubbed in src/api/teams/schemas.ts), so ASSISTANT_COACH / TEAM_MANAGER / PARENT can only
 *    be set by writing to the DB — which is what this script does.
 *
 * Run order:
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
 *
 * Safe to re-run: role updates are idempotent and inserts use skipDuplicates.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ---- Config: tweak here if your alias scheme or team name differs ----------
const BASE_LOCALPART = 'deasystephen';
const BASE_DOMAIN = 'gmail.com';
const TEAM_NAME = 'Test Team';
const aliasEmail = (tag: string) => `${BASE_LOCALPART}+${tag}@${BASE_DOMAIN}`;

const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
const phase = (phaseArg?.split('=')[1] ?? 'all') as 'pre' | 'post' | 'all';

async function getUserIdByAlias(tag: string): Promise<string> {
  const user = await prisma.user.findFirst({ where: { email: aliasEmail(tag) } });
  if (!user) {
    throw new Error(
      `User ${aliasEmail(tag)} not found — has this alias signed in via WorkOS yet?`,
    );
  }
  return user.id;
}

async function runPre() {
  console.log('Phase: pre — system-role bumps');

  const headCoach = await prisma.user.update({
    where: { email: aliasEmail('headcoach') },
    data: { role: 'COACH' },
  });
  console.log(`  ✓ ${headCoach.email} -> COACH (can now create a team)`);

  const parent = await prisma.user.update({
    where: { email: aliasEmail('parent') },
    data: { role: 'PARENT' },
  });
  console.log(`  ✓ ${parent.email} -> PARENT`);
}

async function runPost() {
  console.log(`Phase: post — team staff + guardian (team: "${TEAM_NAME}")`);

  const team = await prisma.team.findFirst({ where: { name: TEAM_NAME } });
  if (!team) {
    throw new Error(
      `Team "${TEAM_NAME}" not found — the head coach must create it in-app first (test D.1).`,
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
      { teamId: team.id, userId: await getUserIdByAlias('asstcoach'), roleId: assistantRole.id },
      { teamId: team.id, userId: await getUserIdByAlias('manager'), roleId: managerRole.id },
    ],
  });
  console.log(`  ✓ TeamStaff inserted (asst coach + manager): ${staff.count} new row(s)`);

  // Parent must be a guardian of the player who is actually on the team, so the
  // parent's read access (test Q.7) resolves through Guardian -> child -> TeamMember.
  const guardian = await prisma.guardian.createMany({
    skipDuplicates: true,
    data: [
      {
        parentId: await getUserIdByAlias('parent'),
        childId: await getUserIdByAlias('player'),
        relationship: 'MOTHER', // MOTHER | FATHER | GUARDIAN | OTHER
        isPrimary: true,
      },
    ],
  });
  console.log(`  ✓ Guardian link (parent -> player): ${guardian.count} new row(s)`);
}

async function main() {
  if (phase === 'pre' || phase === 'all') await runPre();
  if (phase === 'post' || phase === 'all') await runPost();
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Promotion failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
