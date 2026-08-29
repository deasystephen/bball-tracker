import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';

/**
 * Team invitation email.
 *
 * `variant` (roster/invite unification spec): `'added'` when the player got a
 * roster entry at creation (they are already on the team; the link activates
 * their access), anything else / absent renders the classic "invited to join"
 * copy (existing-account invites, deprecated create-and-invite arm).
 */
export const invitationTemplate: EmailTemplate = {
  name: 'invitation',
  subject(vars) {
    return vars.variant === 'added'
      ? `You've been added to ${vars.teamName}`
      : `You've been invited to join ${vars.teamName}`;
  },
  html(vars) {
    const added = vars.variant === 'added';
    const heading = added
      ? `You've been added to ${e(vars.teamName)}!`
      : `You've been invited to join ${e(vars.teamName)}!`;
    const intro = added
      ? `${e(vars.inviterName)} has added you to the roster of <strong>${e(vars.teamName)}</strong>. Activate your access to see the schedule, RSVP to games and follow your stats.`
      : `${e(vars.inviterName)} has invited you to join <strong>${e(vars.teamName)}</strong>.`;
    const ctaLabel = added ? 'Activate Access' : 'Accept Invitation';
    const messageBlock = vars.message
      ? `<p style="color:#555;font-style:italic;">"${e(vars.message)}"</p>`
      : '';
    const ctaBlock = vars.acceptUrl
      ? `<p style="margin:24px 0;">
    <a href="${e(vars.acceptUrl)}" style="display:inline-block;background:#1A3A5C;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">${ctaLabel}</a>
  </p>
  <p style="color:#999;font-size:12px;">Or open this link: <a href="${e(vars.acceptUrl)}">${e(vars.acceptUrl)}</a></p>`
      : '<p>Open the CapyHoops app to accept or decline your invitation.</p>';
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>${heading}</h2>
  <p>Hi ${e(vars.playerName)},</p>
  <p>${intro}</p>
  ${messageBlock}
  <p>This invitation expires on ${e(vars.expiresAt)}.</p>
  ${ctaBlock}
  <hr>
  <p style="color:#999;font-size:12px;">Hooplings</p>
</body>
</html>`;
  },
  text(vars) {
    const added = vars.variant === 'added';
    const heading = added
      ? `You've been added to ${vars.teamName}!`
      : `You've been invited to join ${vars.teamName}!`;
    const intro = added
      ? `${vars.inviterName} has added you to the roster of ${vars.teamName}. Activate your access to see the schedule, RSVP to games and follow your stats.`
      : `${vars.inviterName} has invited you to join ${vars.teamName}.`;
    const messageBlock = vars.message ? `\n"${vars.message}"\n` : '';
    const ctaBlock = vars.acceptUrl
      ? `${added ? 'Activate your access' : 'Accept your invitation'}: ${vars.acceptUrl}`
      : 'Open the CapyHoops app to accept or decline your invitation.';
    return `${heading}

Hi ${vars.playerName},

${intro}
${messageBlock}
This invitation expires on ${vars.expiresAt}.

${ctaBlock}

Hooplings`;
  },
};
