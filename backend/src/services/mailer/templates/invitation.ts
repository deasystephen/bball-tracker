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
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>You've been invited to join ${e(vars.teamName)}!</h2>
  <p>Hi ${e(vars.playerName)},</p>
  <p>${e(vars.inviterName)} has invited you to join <strong>${e(vars.teamName)}</strong>.</p>
  ${messageBlock}
  <p>This invitation expires on ${e(vars.expiresAt)}.</p>
  <p>Open the CapyHoops app to accept or decline your invitation.</p>
  <hr>
  <p style="color:#999;font-size:12px;">CapyHoops — Basketball Tracker</p>
</body>
</html>`;
  },
  text(vars) {
    const messageBlock = vars.message ? `\n"${vars.message}"\n` : '';
    return `You've been invited to join ${vars.teamName}!

Hi ${vars.playerName},

${vars.inviterName} has invited you to join ${vars.teamName}.
${messageBlock}
This invitation expires on ${vars.expiresAt}.

Open the CapyHoops app to accept or decline your invitation.

CapyHoops — Basketball Tracker`;
  },
};
