import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';

export const invitationTemplate: EmailTemplate = {
  name: 'invitation',
  subject(vars) {
    return `You've been invited to join ${vars.teamName}`;
  },
  html(vars) {
    const messageBlock = vars.message
      ? `<p style="color:#555;font-style:italic;">"${e(vars.message)}"</p>`
      : '';
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
  <h2>You've been invited to join ${e(vars.teamName)}!</h2>
  <p>Hi ${e(vars.playerName)},</p>
  <p>${e(vars.inviterName)} has invited you to join <strong>${e(vars.teamName)}</strong>.</p>
  ${messageBlock}
  <p>This invitation expires on ${e(vars.expiresAt)}.</p>
  ${ctaBlock}
  <hr>
  <p style="color:#999;font-size:12px;">CapyHoops — Basketball Tracker</p>
</body>
</html>`;
  },
  text(vars) {
    const messageBlock = vars.message ? `\n"${vars.message}"\n` : '';
    const ctaBlock = vars.acceptUrl
      ? `Accept your invitation: ${vars.acceptUrl}`
      : 'Open the CapyHoops app to accept or decline your invitation.';
    return `You've been invited to join ${vars.teamName}!

Hi ${vars.playerName},

${vars.inviterName} has invited you to join ${vars.teamName}.
${messageBlock}
This invitation expires on ${vars.expiresAt}.

${ctaBlock}

CapyHoops — Basketball Tracker`;
  },
};
