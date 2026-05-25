import { EmailTemplate } from '../index';

export const rsvpConfirmationTemplate: EmailTemplate = {
  name: 'rsvp-confirmation',
  subject(vars) {
    const statusLabel: Record<string, string> = {
      YES: 'confirmed',
      NO: 'declined',
      MAYBE: 'tentative',
    };
    const label = statusLabel[vars.rsvpStatus] ?? vars.rsvpStatus.toLowerCase();
    return `RSVP ${label}: ${vars.teamName} vs ${vars.opponent}`;
  },
  html(vars) {
    const statusLabel: Record<string, string> = {
      YES: 'Yes — attending',
      NO: 'No — not attending',
      MAYBE: 'Maybe — tentative',
    };
    const label = statusLabel[vars.rsvpStatus] ?? vars.rsvpStatus;
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>RSVP Confirmation</h2>
  <p>Hi ${vars.playerName},</p>
  <p>Your RSVP for the following game has been recorded:</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px;font-weight:bold;">Team</td><td style="padding:8px;">${vars.teamName}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Opponent</td><td style="padding:8px;">${vars.opponent}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Date</td><td style="padding:8px;">${vars.gameDate}</td></tr>
    <tr><td style="padding:8px;font-weight:bold;">Your RSVP</td><td style="padding:8px;">${label}</td></tr>
  </table>
  <p>You can update your RSVP at any time in the CapyHoops app.</p>
  <hr>
  <p style="color:#999;font-size:12px;">CapyHoops — Basketball Tracker</p>
</body>
</html>`;
  },
  text(vars) {
    const statusLabel: Record<string, string> = {
      YES: 'Yes — attending',
      NO: 'No — not attending',
      MAYBE: 'Maybe — tentative',
    };
    const label = statusLabel[vars.rsvpStatus] ?? vars.rsvpStatus;
    return `RSVP Confirmation

Hi ${vars.playerName},

Your RSVP for the following game has been recorded:

  Team:     ${vars.teamName}
  Opponent: ${vars.opponent}
  Date:     ${vars.gameDate}
  RSVP:     ${label}

You can update your RSVP at any time in the CapyHoops app.

CapyHoops — Basketball Tracker`;
  },
};
