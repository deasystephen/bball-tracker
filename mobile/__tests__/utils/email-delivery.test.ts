import {
  emailDeliveryIssueExplanation,
  emailDeliveryIssueLabel,
  getEmailDeliveryIssue,
} from '../../utils/email-delivery';

const BOUNCED_AT = '2026-09-27T18:00:00.000Z';

describe('getEmailDeliveryIssue', () => {
  it('reports a bounce', () => {
    expect(
      getEmailDeliveryIssue({
        email: 'kid@example.com',
        emailSuppressedAt: BOUNCED_AT,
        emailSuppressedReason: 'BOUNCE',
      })
    ).toBe('bounced');
  });

  it('reports a complaint', () => {
    expect(
      getEmailDeliveryIssue({
        email: 'kid@example.com',
        emailSuppressedAt: BOUNCED_AT,
        emailSuppressedReason: 'COMPLAINT',
      })
    ).toBe('complaint');
  });

  it.each([
    ['a missing reason', undefined],
    ['a null reason', null],
    ['a reason a newer backend added', 'SOMETHING_NEW'],
  ])('treats %s as a bounce: mail is not being delivered either way', (_label, reason) => {
    expect(
      getEmailDeliveryIssue({
        email: 'kid@example.com',
        emailSuppressedAt: BOUNCED_AT,
        emailSuppressedReason: reason,
      })
    ).toBe('bounced');
  });

  it.each([
    ['the payload carries no delivery state (non-manager, or an older backend)', { email: 'kid@example.com' }],
    ['the state is explicitly clear', { email: 'kid@example.com', emailSuppressedAt: null, emailSuppressedReason: null }],
    ['a reason arrives without a timestamp', { email: 'kid@example.com', emailSuppressedReason: 'BOUNCE' }],
    ['there is no address on file', { email: null, emailSuppressedAt: BOUNCED_AT, emailSuppressedReason: 'BOUNCE' }],
    ['the address is an empty string', { email: '', emailSuppressedAt: BOUNCED_AT, emailSuppressedReason: 'BOUNCE' }],
    [
      'the account was deleted',
      { email: 'kid@example.com', deletedAt: BOUNCED_AT, emailSuppressedAt: BOUNCED_AT, emailSuppressedReason: 'BOUNCE' },
    ],
  ])('reports nothing when %s', (_label, player) => {
    expect(getEmailDeliveryIssue(player)).toBeNull();
  });
});

describe('copy', () => {
  it('labels each issue', () => {
    expect(emailDeliveryIssueLabel('bounced')).toBe('Email bounced');
    expect(emailDeliveryIssueLabel('complaint')).toBe('Email blocked');
  });

  it('tells the coach what to do, differently for each issue', () => {
    expect(emailDeliveryIssueExplanation('bounced')).toMatch(/bounced.*typos/i);
    expect(emailDeliveryIssueExplanation('complaint')).toMatch(/spam.*belongs to this player/i);
  });
});
