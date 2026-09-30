import { escapeHtml as e } from '../escape';
import { APP_NAME, SUPPORT_EMAIL } from './brand';

/**
 * The footer every template ends with (#450). It names the support address
 * and says where a reply goes: the messages are sent on behalf of a coach, and
 * a parent who answers one expects to reach that coach. `Reply-To` is the
 * support inbox (`createMailer`), so the footer has to say so.
 */
const REPLY_DESTINATION = `Replies go to ${APP_NAME} support, not to your coach.`;

export function footerHtml(): string {
  const address = e(SUPPORT_EMAIL);
  return `<hr>
  <p style="color:#999;font-size:12px;">${APP_NAME}</p>
  <p style="color:#999;font-size:12px;">Need help? Reply to this email or write to <a href="mailto:${address}" style="color:#999;">${address}</a>. ${REPLY_DESTINATION}</p>`;
}

export function footerText(): string {
  return `${APP_NAME}
Need help? Reply to this email or write to ${SUPPORT_EMAIL}. ${REPLY_DESTINATION}`;
}
