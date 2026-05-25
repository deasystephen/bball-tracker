import { FakeMailer, createMailer, MailSendParams } from '../../src/services/mailer';
import { SesMailer } from '../../src/services/mailer/ses-mailer';
import { invitationTemplate } from '../../src/services/mailer/templates/invitation';
import { rsvpConfirmationTemplate } from '../../src/services/mailer/templates/rsvp-confirmation';
import { announcementTemplate } from '../../src/services/mailer/templates/announcement';

// Mock the AWS SES SDK so SesMailer tests don't make real network calls
jest.mock('@aws-sdk/client-sesv2', () => {
  const mockSend = jest.fn().mockResolvedValue({ MessageId: 'ses-msg-123' });
  return {
    SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    SendEmailCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    __mockSend: mockSend,
  };
});

const baseMetadata = { event_type: 'test', userId: 'user-1' };

function makeParams(overrides: Partial<MailSendParams> = {}): MailSendParams {
  return {
    template: invitationTemplate,
    to: 'player@example.com',
    variables: {
      playerName: 'Alex',
      teamName: 'Lakers',
      inviterName: 'Coach',
      message: '',
      expiresAt: '2026-06-01',
    },
    metadata: baseMetadata,
    ...overrides,
  };
}

describe('FakeMailer', () => {
  it('records sent emails', async () => {
    const fake = new FakeMailer();
    const params = makeParams();
    const result = await fake.send(params);

    expect(result.messageId).toMatch(/^fake-/);
    expect(fake.sentEmails).toHaveLength(1);
    expect(fake.sentEmails[0]).toBe(params);
  });

  it('accumulates multiple sends', async () => {
    const fake = new FakeMailer();
    await fake.send(makeParams());
    await fake.send(makeParams());
    expect(fake.sentEmails).toHaveLength(2);
  });
});

describe('createMailer', () => {
  const originalRegion = process.env.AWS_SES_REGION;
  const originalFrom = process.env.SES_FROM_ADDRESS;

  afterEach(() => {
    process.env.AWS_SES_REGION = originalRegion;
    process.env.SES_FROM_ADDRESS = originalFrom;
  });

  it('returns FakeMailer when env vars are missing', () => {
    delete process.env.AWS_SES_REGION;
    delete process.env.SES_FROM_ADDRESS;
    const m = createMailer();
    expect(m).toBeInstanceOf(FakeMailer);
  });

  it('returns FakeMailer when only one env var is set', () => {
    process.env.AWS_SES_REGION = 'us-east-1';
    delete process.env.SES_FROM_ADDRESS;
    const m = createMailer();
    expect(m).toBeInstanceOf(FakeMailer);
  });

  it('returns SesMailer when both env vars are set', () => {
    process.env.AWS_SES_REGION = 'us-east-1';
    process.env.SES_FROM_ADDRESS = 'noreply@mail.capyhoops.com';
    const m = createMailer();
    expect(m).toBeInstanceOf(SesMailer);
  });
});

describe('SesMailer', () => {
  const sesModule = jest.requireMock('@aws-sdk/client-sesv2') as {
    __mockSend: jest.Mock;
    SESv2Client: jest.Mock;
    SendEmailCommand: jest.Mock;
  };

  beforeEach(() => {
    sesModule.__mockSend.mockClear();
    sesModule.SESv2Client.mockClear();
    sesModule.SendEmailCommand.mockClear();
  });

  it('calls SES SendEmailCommand with rendered subject, html, text', async () => {
    const mailerInstance = new SesMailer({
      region: 'us-east-1',
      fromAddress: 'noreply@mail.capyhoops.com',
    });

    const result = await mailerInstance.send({
      template: invitationTemplate,
      to: 'player@example.com',
      variables: {
        playerName: 'Jordan',
        teamName: 'Bulls',
        inviterName: 'Phil',
        message: '',
        expiresAt: '2026-07-01',
      },
      metadata: { event_type: 'invitation.created', userId: 'user-1' },
    });

    expect(result.messageId).toBe('ses-msg-123');
    expect(sesModule.SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ['player@example.com'] },
        FromEmailAddress: 'noreply@mail.capyhoops.com',
        Content: expect.objectContaining({
          Simple: expect.objectContaining({
            Subject: expect.objectContaining({ Data: expect.stringContaining('Bulls') }),
          }),
        }),
      })
    );
    expect(sesModule.__mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns empty messageId when SES response has no MessageId', async () => {
    sesModule.__mockSend.mockResolvedValueOnce({});
    const mailerInstance = new SesMailer({ region: 'eu-west-1', fromAddress: 'x@y.com' });
    const result = await mailerInstance.send(makeParams());
    expect(result.messageId).toBe('');
  });
});

describe('invitationTemplate', () => {
  const vars = {
    playerName: 'Jordan',
    teamName: 'Bulls',
    inviterName: 'Phil',
    message: 'Welcome aboard!',
    expiresAt: '2026-07-01',
  };

  it('subject includes team name', () => {
    expect(invitationTemplate.subject(vars)).toContain('Bulls');
  });

  it('html includes player name and message', () => {
    const html = invitationTemplate.html(vars);
    expect(html).toContain('Jordan');
    expect(html).toContain('Welcome aboard!');
  });

  it('html omits message block when message is empty', () => {
    const html = invitationTemplate.html({ ...vars, message: '' });
    expect(html).not.toContain('italic');
  });

  it('text includes all key fields', () => {
    const text = invitationTemplate.text(vars);
    expect(text).toContain('Bulls');
    expect(text).toContain('Phil');
    expect(text).toContain('2026-07-01');
  });

  it('text omits message block when message is empty', () => {
    const text = invitationTemplate.text({ ...vars, message: '' });
    expect(text).not.toContain('"');
  });
});

describe('rsvpConfirmationTemplate', () => {
  const vars = {
    playerName: 'Jordan',
    teamName: 'Bulls',
    opponent: 'Pistons',
    gameDate: '2026-06-15',
    rsvpStatus: 'YES',
  };

  it('subject includes "confirmed" for YES', () => {
    expect(rsvpConfirmationTemplate.subject(vars)).toContain('confirmed');
  });

  it('subject includes "declined" for NO', () => {
    expect(rsvpConfirmationTemplate.subject({ ...vars, rsvpStatus: 'NO' })).toContain('declined');
  });

  it('subject includes "tentative" for MAYBE', () => {
    expect(rsvpConfirmationTemplate.subject({ ...vars, rsvpStatus: 'MAYBE' })).toContain('tentative');
  });

  it('html includes game details', () => {
    const html = rsvpConfirmationTemplate.html(vars);
    expect(html).toContain('Pistons');
    expect(html).toContain('2026-06-15');
    expect(html).toContain('Yes');
  });

  it('text includes all key fields', () => {
    const text = rsvpConfirmationTemplate.text(vars);
    expect(text).toContain('Bulls');
    expect(text).toContain('Pistons');
    expect(text).toContain('2026-06-15');
  });

  it('handles unknown status gracefully', () => {
    const subject = rsvpConfirmationTemplate.subject({ ...vars, rsvpStatus: 'CUSTOM' });
    expect(subject).toContain('CUSTOM'.toLowerCase());
  });
});

describe('announcementTemplate', () => {
  const vars = {
    recipientName: 'Jordan',
    teamName: 'Bulls',
    title: 'Practice moved',
    body: 'Practice is at 5pm now.',
    authorName: 'Coach Phil',
  };

  it('subject is "teamName: title"', () => {
    expect(announcementTemplate.subject(vars)).toBe('Bulls: Practice moved');
  });

  it('html contains all fields', () => {
    const html = announcementTemplate.html(vars);
    expect(html).toContain('Jordan');
    expect(html).toContain('Practice moved');
    expect(html).toContain('Coach Phil');
  });

  it('text contains all fields', () => {
    const text = announcementTemplate.text(vars);
    expect(text).toContain('Practice is at 5pm now.');
    expect(text).toContain('Coach Phil');
  });
});
