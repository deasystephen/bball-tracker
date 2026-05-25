import { EmailTemplate } from '../index';
import { escapeHtml as e } from '../escape';

export const announcementTemplate: EmailTemplate = {
  name: 'announcement',
  subject(vars) {
    return `${vars.teamName}: ${vars.title}`;
  },
  html(vars) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2>${e(vars.teamName)}</h2>
  <h3>${e(vars.title)}</h3>
  <p>Hi ${e(vars.recipientName)},</p>
  <div style="background:#f5f5f5;padding:16px;border-radius:4px;">
    <p style="margin:0;white-space:pre-wrap;">${e(vars.body)}</p>
  </div>
  <p style="color:#555;font-size:14px;">Posted by ${e(vars.authorName)}</p>
  <hr>
  <p style="color:#999;font-size:12px;">CapyHoops — Basketball Tracker</p>
</body>
</html>`;
  },
  text(vars) {
    return `${vars.teamName}: ${vars.title}

Hi ${vars.recipientName},

${vars.body}

Posted by ${vars.authorName}

CapyHoops — Basketball Tracker`;
  },
};
