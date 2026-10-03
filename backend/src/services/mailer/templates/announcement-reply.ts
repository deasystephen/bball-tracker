import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';
import { footerHtml, footerText } from './footer';

/**
 * Sent to an announcement's author when someone replies (#34). Off when the
 * author has `notifyOnReplies` false (Profile → Reply notifications).
 */
export const announcementReplyTemplate: EmailTemplate = {
  name: 'announcement-reply',
  subject(vars) {
    return `${vars.teamName}: ${vars.replierName} replied to "${vars.title}"`;
  },
  html(vars) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>${e(vars.teamName)}</h2>
  <p>Hi ${e(vars.recipientName)},</p>
  <p>${e(vars.replierName)} replied to your announcement <strong>${e(vars.title)}</strong>:</p>
  <div style="background:#f5f5f5;padding:16px;border-radius:4px;">
    <p style="margin:0;white-space:pre-wrap;">${e(vars.body)}</p>
  </div>
  <p style="color:#555;font-size:14px;">Open the announcement in the app to read the thread or reply.</p>
  ${footerHtml()}
</body>
</html>`;
  },
  text(vars) {
    return `${vars.teamName}

Hi ${vars.recipientName},

${vars.replierName} replied to your announcement "${vars.title}":

${vars.body}

Open the announcement in the app to read the thread or reply.

${footerText()}`;
  },
};
