import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';
import { APP_NAME } from './brand';
import { footerHtml, footerText } from './footer';

/**
 * Sent when a head coach invites an address to a staff role (#460). The
 * address may have no account yet: accepting creates it. Same accept-link
 * shape as the team and guardian invitations.
 */
export const staffInvitationTemplate: EmailTemplate = {
  name: 'staff-invitation',
  subject(vars) {
    return `You've been invited to join ${vars.teamName} as ${vars.roleName}`;
  },
  html(vars) {
    const ctaBlock = vars.acceptUrl
      ? `<p style="margin:24px 0;">
    <a href="${e(vars.acceptUrl)}" style="display:inline-block;background:#1A3A5C;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Accept Invitation</a>
  </p>
  <p style="color:#999;font-size:12px;">Or open this link: <a href="${e(vars.acceptUrl)}">${e(vars.acceptUrl)}</a></p>`
      : `<p>Open the ${APP_NAME} app to accept or decline your invitation.</p>`;
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>You've been invited to join a team's staff on ${APP_NAME}</h2>
  <p>${e(vars.inviterName)} has invited you to join <strong>${e(vars.teamName)}</strong> as <strong>${e(vars.roleName)}</strong>.</p>
  <p>If you don't have a ${APP_NAME} account yet, sign up with this email address after accepting and the team will be waiting for you.</p>
  <p>This invitation expires on ${e(vars.expiresAt)}.</p>
  ${ctaBlock}
  ${footerHtml()}
</body>
</html>`;
  },
  text(vars) {
    const ctaBlock = vars.acceptUrl
      ? `Accept your invitation: ${vars.acceptUrl}`
      : `Open the ${APP_NAME} app to accept or decline your invitation.`;
    return `You've been invited to join a team's staff on ${APP_NAME}

${vars.inviterName} has invited you to join ${vars.teamName} as ${vars.roleName}.

If you don't have a ${APP_NAME} account yet, sign up with this email address after accepting and the team will be waiting for you.

This invitation expires on ${vars.expiresAt}.

${ctaBlock}

${footerText()}`;
  },
};
