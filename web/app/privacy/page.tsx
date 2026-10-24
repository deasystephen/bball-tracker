import type { Metadata } from 'next';
import {
  Email,
  LegalDocument,
  Placeholder,
  PRIVACY_EMAIL,
  Section,
  Summary,
  SUPPORT_EMAIL,
  Table,
} from '../_legal/legal-document';

/*
 * Privacy policy draft (#25). Every fact below is taken from the code or from
 * the "Retention" section of docs/runbooks/data-subject-requests.md, which
 * CLAUDE.md names as the source this page must match. When that section
 * changes, change this page in the same PR; __tests__/legal-pages.test.tsx
 * fails when a retention figure stated here no longer appears there.
 */

export const metadata: Metadata = {
  title: 'Privacy Policy | Hooplings',
  description: 'How Hooplings collects, uses, shares and deletes personal information.',
};

export default function PrivacyPolicyPage() {
  return (
    <LegalDocument title="Hooplings Privacy Policy">
      <Summary>
        <p>
          <strong>The short version.</strong>
        </p>
        <ul>
          <li>
            Hooplings is a team app for youth and amateur basketball. We use the information you and your coaches enter
            to run teams, rosters, schedules, live games and statistics.
          </li>
          <li>We do not sell personal information, we show no advertising and we do not track you across other apps.</li>
          <li>
            Usage analytics and error reports go to a small set of service providers named below, without your name,
            email address or photo.
          </li>
          <li>
            You can delete your account in the app at any time (Profile → Account → Delete account). Parents and
            guardians can delete a child’s record that has no sign-in of its own.
          </li>
          <li>
            Questions or requests: <Email address={PRIVACY_EMAIL} />.
          </li>
        </ul>
      </Summary>

      <Section id="who-we-are" title="1. Who we are">
        <p>
          Hooplings (“Hooplings”, “we”, “us”) is provided by <Placeholder>LEGAL ENTITY NAME</Placeholder>, organised
          under the laws of <Placeholder>JURISDICTION</Placeholder>, <Placeholder>REGISTERED ADDRESS</Placeholder>.
          This policy covers the Hooplings mobile app, the Hooplings API that the app talks to, the emails we send and
          the pages on hooplings.com.
        </p>
        <p>
          For anything about your personal information, write to <Email address={PRIVACY_EMAIL} />. For general help,
          write to <Email address={SUPPORT_EMAIL} />.
        </p>
      </Section>

      <Section id="information-we-collect" title="2. Information we collect">
        <h3>Information you give us</h3>
        <ul>
          <li>
            <strong>Account information:</strong> your email address and name, and a profile photo if you add one. When
            you first sign in, our sign-in provider passes us your email address, your name and, if your sign-in
            account has one, a profile photo. You can change your name and photo in the app.
          </li>
          <li>
            <strong>Team information:</strong> teams, leagues and seasons you create, including a team’s name, age
            group and gender category; staff roles; games (opponent, date, scores); the game events recorded during a
            game (shots, rebounds, assists and similar) and the box scores and season statistics calculated from them;
            RSVPs; and team announcements and replies.
          </li>
          <li>
            <strong>Information you enter about other people:</strong> a coach or other team staff member with roster
            permission can add a player with a name and, optionally, an email address, a profile photo, a jersey
            number and a position. They can invite a player to the team by email, with an optional personal message of
            up to 500 characters, and invite a parent or guardian by email, recording the guardian’s relationship to
            the player (mother, father, guardian or other).
          </li>
        </ul>

        <h3>Information collected automatically</h3>
        <ul>
          <li>
            <strong>Push notification token:</strong> if you allow notifications, the app registers a push token for
            your device, with the platform (iOS or Android), so we can send you notifications.
          </li>
          <li>
            <strong>Usage analytics:</strong> what you do in the app, such as screens viewed and the teams, rosters,
            invitations, announcements, games, game events and RSVPs you create, change or delete, sent to our
            analytics provider. Details are in <a href="#analytics">section 6</a>.
          </li>
          <li>
            <strong>Error and performance reports:</strong> when something goes wrong, a report with technical
            details is sent to our error-monitoring provider. During normal use the app also reports app-session health
            (whether a session ended in a crash), and both the app and the API send performance timings for a sample
            of about one in ten screens and requests. Details are in <a href="#retention">section 6</a>.
          </li>
          <li>
            <strong>Server logs:</strong> our API writes one log line per request (the method, a redacted path, the
            result and how long it took), together with your internal user id when you are signed in.
          </li>
          <li>
            <strong>Network address:</strong> like any internet service, our servers see the IP address of each
            request. The API uses it in memory to limit how many requests one address can make. It writes the
            address to its logs only when it refuses a live-game connection for going over that limit. Our analytics
            provider receives it and derives an approximate city, region and country from it (see{' '}
            <a href="#analytics">section 6</a>). The providers your device contacts directly (our sign-in page, error
            reporting and app updates) also see it, as any website does.
          </li>
        </ul>

        <h3>Information that stays on your device</h3>
        <p>
          Your sign-in session tokens are stored in your device’s secure keychain. Sort preferences and onboarding
          progress are stored on the device. We do not receive these.
        </p>

        <h3>What we do not collect</h3>
        <p>
          We do not ask for a date of birth or age. The app never reads your device’s location (it asks for no
          location permission), your contacts, your microphone or any advertising identifier. There are no purchases
          in the app, so we hold no payment information. The camera and photo library are used only when you choose
          to take or pick a profile photo, and only the photo you choose is uploaded.
        </p>
      </Section>

      <Section id="how-we-use" title="3. How we use information">
        <ul>
          <li>
            <strong>To provide Hooplings:</strong> create and run teams, rosters, schedules and live games, calculate
            statistics, and show each team’s information to the people on it.
          </li>
          <li>
            <strong>To send messages you or your team expect:</strong> emails for team invitations, guardian
            invitations, team announcements, replies to an announcement you posted, and RSVP confirmations; and push
            notifications for team announcements, replies to your announcements and being added to a team’s staff.
            You can turn off reply notifications in the app and all push notifications in your device settings. We do
            not send marketing email.
          </li>
          <li>
            <strong>To keep the service working and secure:</strong> limit request rates, investigate errors and abuse,
            and keep logs for a short time.
          </li>
          <li>
            <strong>To understand and improve the app:</strong> usage analytics tell us which features are used and
            where people run into errors.
          </li>
        </ul>
        <p>
          We do not sell or rent personal information, we do not use it for advertising, we do not share it with data
          brokers and we make no automated decisions about you that have legal or similarly significant effects.
        </p>
        <p>
          <strong>Legal bases (where the law requires one):</strong> we process information to provide the service you
          asked for (contract), to keep it secure and improve it (our legitimate interests), and with your permission
          where we ask for it, such as for notifications and photos (consent).{' '}
          <Placeholder>OWNER DECISION: confirm which privacy laws apply and whether this paragraph is needed</Placeholder>
        </p>
      </Section>

      <Section id="who-can-see" title="4. Who can see your information in the app">
        <ul>
          <li>
            The people on a team (its players, its staff and the parents or guardians of its players) can see the
            team’s roster (names, photos, jersey numbers and positions), its schedule, game results, box scores and
            season statistics, and its announcements.
          </li>
          <li>
            Players’ email addresses are shown only to team staff who can manage the roster. Staff email addresses are
            shown to everyone on the team.
          </li>
          <li>
            Profile photos are stored at a web address made of the uploader’s internal account id and a random
            identifier. Anyone who has that address
            can open the photo.
          </li>
          <li>
            Invitation and announcement emails are sent on behalf of the coach. Replies to them go to Hooplings
            support, not to the coach.
          </li>
        </ul>
      </Section>

      <Section id="service-providers" title="5. Service providers we share information with">
        <p>
          We use the following providers to run Hooplings. They process information on our behalf, for the purposes
          below.
        </p>
        <Table>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">What it does for us</th>
              <th scope="col">Information involved</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Amazon Web Services (AWS), United States (US East)</td>
              <td>
                Hosts the API, the database and its backups, a cache, profile photo storage (Amazon S3), email delivery
                (Amazon SES) and server logs (Amazon CloudWatch)
              </td>
              <td>Everything the service stores; email addresses and message content for the emails we send</td>
            </tr>
            <tr>
              <td>WorkOS</td>
              <td>Sign-in (the hosted sign-in page and your sign-in account)</td>
              <td>
                Your email address, name and the details you enter on the sign-in page{' '}
                <Placeholder>OWNER DECISION: list the sign-in methods offered (email, password, social sign-in)</Placeholder>
              </td>
            </tr>
            <tr>
              <td>Amplitude</td>
              <td>Usage analytics</td>
              <td>See section 6; no name, email address or photo</td>
            </tr>
            <tr>
              <td>Sentry</td>
              <td>Error reports from the app and the API</td>
              <td>See section 6; no name, email address or photo</td>
            </tr>
            <tr>
              <td>Datadog</td>
              <td>Server log search and alerting</td>
              <td>A copy of the API’s server logs (see section 6)</td>
            </tr>
            <tr>
              <td>Expo, and Apple’s and Google’s push notification services</td>
              <td>Delivering push notifications; Expo also delivers app updates</td>
              <td>
                Your device’s push token and the notification text (for example a team name, an announcement title and
                the start of its text, or the name of the person who replied)
              </td>
            </tr>
            <tr>
              <td>Google Workspace</td>
              <td>Our support and privacy mailboxes</td>
              <td>Whatever you write to us, and your email address</td>
            </tr>
            <tr>
              <td>
                <Placeholder>OWNER DECISION: web host for hooplings.com</Placeholder>
              </td>
              <td>Serving the hooplings.com web pages</td>
              <td>Standard web request information, such as IP address and browser type</td>
            </tr>
          </tbody>
        </Table>
        <p>
          We may also disclose information when the law requires it, to protect the safety of any person, or as part of
          a merger, acquisition or sale of assets, in which case this policy continues to apply to the information
          transferred.
        </p>
        <p>
          Our infrastructure is in the United States, and our providers may process information in the United States
          and other countries.
        </p>
      </Section>

      <Section id="retention" title="6. How long we keep information">
        <p>
          We keep your account and team information for as long as your account exists. When an account is deleted (see{' '}
          <a href="#deleting">section 7</a>), this is what remains and for how long:
        </p>
        <ul>
          <li>
            An account with no history (never on a roster, no game events or statistics, no invitations sent or
            received, no announcements or replies) is <strong>erased</strong>: the record is deleted and nothing about it remains
            in our application database. Outside the database, the server log lines and the provider records described
            below still carry the internal id until their retention periods end.
          </li>
          <li>
            Otherwise the account record is kept only as an anonymous placeholder holding an internal id, the account
            type, the date it was created and the date it was deleted.
          </li>
          <li>
            Game events, box scores and season statistics recorded for the person’s teams are kept, attributed to
            “Deleted user”, so that everyone else’s statistics stay correct.
          </li>
          <li>
            Automated database backups keep the information as it was before the deletion for up to{' '}
            <strong>7 days</strong>. Backups are not edited. Snapshots of the database taken by hand before major
            maintenance are kept until we delete them.{' '}
            <Placeholder>OWNER DECISION: set and state a maximum age for manual database snapshots</Placeholder>
          </li>
          <li>
            <strong>Error reports (Sentry)</strong> are kept for Sentry’s retention period (90 days by default). No
            name, email address or photo is sent. Reports from our servers carry the internal user id of the signed-in
            person whose request they describe. Reports from the app carry no user id; they hold the device model, the
            operating system version, the app version and a redacted record of recent navigation and requests. The
            same applies to the session-health and performance data described in{' '}
            <a href="#information-we-collect">section 2</a>.{' '}
            <Placeholder>OWNER DECISION: confirm in the Sentry project whether it stores the sending device’s IP address, and say so here</Placeholder>
          </li>
          <li id="analytics">
            <strong>Usage analytics (Amplitude)</strong> are kept for the retention period of our Amplitude plan{' '}
            <Placeholder>OWNER DECISION: state the Amplitude plan’s retention period</Placeholder>. Every analytics
            event (app opens, screens viewed, recorded as the kind of screen and never the specific team or player,
            sign-in and sign-out, onboarding steps, notification permission answers and taps, errors shown, and every
            team, roster, staff, invitation, guardian, announcement, league, season, game, game event and RSVP the
            person created, changed or deleted) carries the internal user id, a device id, the device’s vendor
            identifier on iOS or app set id on Android, the device manufacturer and model, operating system details,
            language, mobile carrier, and the IP address of the request, from which Amplitude derives an approximate{' '}
            <strong>city, region and country</strong>. Event details are internal ids, categories, counts and yes/no
            flags: which fields changed, never their values; an error’s code, never its message. Amplitude also holds a
            few facts about the account: its role, whether the person is a head coach, assistant coach, parent or
            player, how many teams they can see, their plan and the app version. No name, email address, jersey number,
            message or photo is sent, and no advertising identifier is ever sent.{' '}
            <Placeholder>OWNER DECISION: confirm in the Amplitude project whether the raw IP address is kept after the location lookup, and say which</Placeholder>
          </li>
          <li>
            <strong>Server logs</strong> (one line per API request with the method, a redacted path, the result and
            the duration, plus records of events such as an account being deleted) carry the internal user id whenever
            the request was signed in. They contain no names and no secret links, and email addresses appear only as a
            short one-way hash (someone who already knows an address can compute the same hash, but the hash does not
            reveal the address). Log lines written before a logging fix was deployed may still contain a
            recipient’s email address from a failed email send until they age out. Logs are kept for{' '}
            <strong>30 days</strong> in Amazon CloudWatch and, as a copy, for <strong>15 days</strong> in Datadog.{' '}
            <Placeholder>OWNER CHECK: re-confirm the Datadog log index retention before publishing</Placeholder>
          </li>
          <li>
            After deletion nothing in our application links the internal id back to a person, but the analytics, server
            error and log records above remain with Amplitude, Sentry and Datadog and in Amazon CloudWatch, keyed on
            that id, until their retention periods end. If you want them removed sooner, ask us at{' '}
            <Email address={PRIVACY_EMAIL} /> and we will use each provider’s own deletion process for that id (Amazon
            CloudWatch offers none short of deleting the whole log).
          </li>
          <li>
            Email delivery records at Amazon SES keep only a hashed form of the recipient’s address. Two exceptions:
            if an address bounces permanently or its owner marks our email as spam, Amazon SES adds the address itself
            to a suppression list that stops further delivery and keeps it there until we remove it; and the
            bounce or complaint notice, which names the address, waits in a message queue until our API processes it,
            for at most <strong>14 days</strong>.
          </li>
        </ul>
      </Section>

      <Section id="deleting" title="7. Deleting your account">
        <p>
          <strong>In the app:</strong> Profile → Account → <strong>Delete account</strong>, then type DELETE to
          confirm. Deletion happens immediately and cannot be undone. It signs you out, and signing in again with the
          same email address creates a new, empty account.
        </p>
        <p>Deleting an account removes:</p>
        <ul>
          <li>your sign-in, email address, name and current photo (we also try to delete the photo file);</li>
          <li>your push notification tokens and calendar subscription links;</li>
          <li>your staff roles and league administrator roles, and your RSVPs;</li>
          <li>your guardian links, in both directions;</li>
          <li>
            pending invitations addressed to you, and your email address from every guardian invitation that carried
            it.
          </li>
        </ul>
        <p>
          It keeps, without your name: your places on team rosters (shown as “Deleted user” until a coach removes them),
          the game events and statistics recorded for you, announcements and replies you posted, and team invitations
          you sent, with any message you wrote in them. If
          none of these exist, the account is erased entirely (see <a href="#retention">section 6</a>). Your account
          with our sign-in provider, WorkOS, is deleted at the same time.
        </p>
        <p>
          If you are the only head coach of a team in an active season, the app asks you to make someone else head
          coach or delete the team first. Teams in past seasons never block a deletion.
        </p>
        <p>
          <strong>A child’s record:</strong> a parent or guardian can delete the record of a child who has never
          signed in: Profile → My kids → ⋯ → <strong>Delete [child]’s record</strong>. A child who has signed in
          deletes their own account from their own Profile.
        </p>
        <p>
          <strong>By email:</strong> write to <Email address={PRIVACY_EMAIL} /> from the email address on the account.
          For a child’s record, write from the email address of your guardian account, or the one your guardian
          invitation for that child was sent to. We act only on a request from such an address, never on one passed on
          by a third party or a coach.
        </p>
      </Section>

      <Section id="children" title="8. Children and families">
        <p>
          Hooplings is used by youth teams, so many players are children. This is what the app does with their
          information today.
        </p>
        <ul>
          <li>
            We do not ask for anyone’s age or date of birth, and sign-up has no age check.
          </li>
          <li>
            Children’s information is entered by adults: a coach or other staff member with roster permission adds a
            player’s name and, optionally, an email address, photo, jersey number and position. A player added without
            an email address is a record managed by the team, with no sign-in. If an email address is entered, we send
            an invitation to it, and the person who uses that address can sign in and take over the record.
          </li>
          <li>
            A coach can invite a parent or guardian by email. Once the invitation is accepted, the guardian is linked
            to the child and can see the child’s teams, schedules, live games, box scores and statistics; RSVP for the
            child; change the child’s name and photo; receive the team’s announcements; and delete the child’s record
            if the child has never signed in.
          </li>
          <li>
            Team members, staff and other families on the team see the child’s name, photo, jersey number, position and
            statistics, as described in <a href="#who-can-see">section 4</a>. The child’s email address is shown only
            to staff who can manage the roster.
          </li>
          <li>
            Analytics and error reports describe what the person using the app does. When a coach adds a player, the
            analytics event records only yes/no flags (for example, whether a photo or jersey number was added), never
            the player’s name, email address, jersey number or photo.
          </li>
          <li>
            We do not use children’s information for advertising, and we do not sell it.
          </li>
        </ul>
        <p>
          A parent or guardian can ask to see, correct or delete their child’s information by writing to{' '}
          <Email address={PRIVACY_EMAIL} /> (see <a href="#deleting">section 7</a> for how we verify the request).
        </p>
        <p>
          <Placeholder>
            OWNER DECISION: whether Hooplings is directed to children under 13 under the US Children’s Online Privacy
            Protection Act (COPPA), whether children under 13 may have their own sign-in, and, if so, how verifiable
            parental consent is obtained before a coach adds a child. Today the app has no age check and no parental
            consent step. Replace this paragraph with the decided position; do not publish a compliance claim the app
            does not implement.
          </Placeholder>
        </p>
      </Section>

      <Section id="your-rights" title="9. Your choices and rights">
        <ul>
          <li>
            <strong>See and export your information:</strong> email <Email address={PRIVACY_EMAIL} /> from your
            account’s email address and we will send you a copy of the information we hold about your account, as a
            single file.
          </li>
          <li>
            <strong>Correct it:</strong> change your name and photo in the app; ask your coach to correct roster
            details, or write to us.
          </li>
          <li>
            <strong>Delete it:</strong> in the app or by email, as described in <a href="#deleting">section 7</a>.
          </li>
          <li>
            <strong>Notifications:</strong> turn push notifications off in your device settings, and reply
            notifications off in the app.
          </li>
          <li>
            <strong>Camera and photos:</strong> the app asks only when you choose to take or pick a photo, and you can
            change the permission in your device settings.
          </li>
          <li>
            <strong>Analytics:</strong> the app has no setting to turn analytics off.{' '}
            <Placeholder>OWNER DECISION: add an in-app analytics opt-out, or describe how to object by email</Placeholder>
          </li>
        </ul>
        <p>
          Depending on where you live, you may have further rights, such as to restrict or object to some processing,
          to receive your information in a portable format, or to complain to a data protection authority. Write to{' '}
          <Email address={PRIVACY_EMAIL} /> to use any of them. We will verify your request as described in{' '}
          <a href="#deleting">section 7</a>, respond within the time the law requires, and not treat you differently
          for making a request.
        </p>
      </Section>

      <Section id="security" title="10. Security">
        <p>
          Information travels between the app and our servers over encrypted connections. The database is encrypted at
          rest, sign-in tokens are kept in the device’s secure keychain, invitation links are secret and expire, and
          our logs leave out names and secret links. No system is perfectly secure, so we cannot guarantee that
          information will never be accessed without permission. If that happens, we will notify you as the law
          requires.
        </p>
      </Section>

      <Section id="website" title="11. Our website">
        <p>
          The hooplings.com pages set no cookies and run no analytics. The invitation page looks up the invitation in
          the link with our API so it can show who invited you and let you accept, and it tells your browser not to
          pass the invitation link on to other sites.
        </p>
      </Section>

      <Section id="changes" title="12. Changes to this policy">
        <p>
          When we change this policy, we will update the effective date at the top. If a change is significant, we
          will tell you in the app or by email before it takes effect.
        </p>
      </Section>

      <Section id="contact" title="13. Contact us">
        <p>
          <Placeholder>LEGAL ENTITY NAME</Placeholder>, <Placeholder>REGISTERED ADDRESS</Placeholder>. Privacy
          questions and requests: <Email address={PRIVACY_EMAIL} />. Everything else:{' '}
          <Email address={SUPPORT_EMAIL} />.
        </p>
      </Section>
    </LegalDocument>
  );
}
