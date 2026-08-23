import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';

/**
 * Sent when a roster manager invites an adult to be a player's guardian
 * (PARENT role). Same accept-link shape as the team invitation.
 */
export const guardianInvitationTemplate: EmailTemplate = {
  name: 'guardian-invitation',
  subject(vars) {
    return `You've been invited as ${vars.childName}'s guardian on ${vars.teamName}`;
  },
  html(vars) {
    const ctaBlock = vars.acceptUrl
      ? `<p style="margin:24px 0;">
    <a href="${e(vars.acceptUrl)}" style="display:inline-block;background:#1A3A5C;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Accept Invitation</a>
  </p>
  <p style="color:#999;font-size:12px;">Or open this link: <a href="${e(vars.acceptUrl)}">${e(vars.acceptUrl)}</a></p>`
      : '<p>Open the CapyHoops app to accept or decline your invitation.</p>';
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>You've been invited as ${e(vars.childName)}'s guardian</h2>
  <p>Hi ${e(vars.guardianName)},</p>
  <p>${e(vars.inviterName)} has invited you to be a guardian of <strong>${e(vars.childName)}</strong> on <strong>${e(vars.teamName)}</strong>.</p>
  <p>As a guardian you can see ${e(vars.childName)}'s schedule, stats and team announcements, and RSVP to games on their behalf.</p>
  <p>This invitation expires on ${e(vars.expiresAt)}.</p>
  ${ctaBlock}
  <hr>
  <p style="color:#999;font-size:12px;">CapyHoops — Basketball Tracker</p>
</body>
</html>`;
  },
  text(vars) {
    const ctaBlock = vars.acceptUrl
      ? `Accept your invitation: ${vars.acceptUrl}`
      : 'Open the CapyHoops app to accept or decline your invitation.';
    return `You've been invited as ${vars.childName}'s guardian

Hi ${vars.guardianName},

${vars.inviterName} has invited you to be a guardian of ${vars.childName} on ${vars.teamName}.

As a guardian you can see ${vars.childName}'s schedule, stats and team announcements, and RSVP to games on their behalf.

This invitation expires on ${vars.expiresAt}.

${ctaBlock}

CapyHoops — Basketball Tracker`;
  },
};
