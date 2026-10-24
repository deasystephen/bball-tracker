import type { Metadata } from 'next';
import Link from 'next/link';
import { Email, LegalDocument, Placeholder, Section, SUPPORT_EMAIL } from '../_legal/legal-document';

/*
 * Terms of Service draft (#25). Needs the owner's, and ideally a lawyer's,
 * review before it is published. Bracketed placeholders are open decisions.
 */

export const metadata: Metadata = {
  title: 'Terms of Service | Hooplings',
  description: 'The terms that apply when you use Hooplings.',
};

export default function TermsOfServicePage() {
  return (
    <LegalDocument title="Hooplings Terms of Service">
      <Section id="agreement" title="1. Agreement">
        <p>
          These terms are an agreement between you and <Placeholder>LEGAL ENTITY NAME</Placeholder> (“Hooplings”,
          “we”, “us”), and they apply when you use the Hooplings mobile app, the emails we send and the pages on
          hooplings.com (together, the “Service”). By creating an account or using the Service you agree to them. If
          you use the Service for a team, club or league, you also confirm that you are allowed to act for it.
        </p>
        <p>
          Our <Link href="/privacy">Privacy Policy</Link> explains how we handle personal information and is part of
          these terms.
        </p>
      </Section>

      <Section id="service" title="2. The Service">
        <p>
          Hooplings helps coaches, players and families run basketball teams: rosters, schedules, invitations,
          announcements, live game tracking and statistics. The Service is free today and has no purchases. We may
          add, change or remove features. If we ever introduce paid features, we will tell you the price and terms
          before you are charged, and nothing you already use will start costing money without your agreement.
        </p>
      </Section>

      <Section id="accounts" title="3. Accounts and eligibility">
        <ul>
          <li>
            You sign in through our sign-in provider. Keep your sign-in details secure; you are responsible for what
            happens under your account.
          </li>
          <li>Give us accurate information and keep it up to date.</li>
          <li>
            <Placeholder>
              OWNER DECISION: minimum age to hold an account, and whether a younger player may sign in with a parent’s
              or guardian’s permission. This must match the decision in section 8 of the Privacy Policy.
            </Placeholder>
          </li>
          <li>One person, one account. Do not share your account or sign in as someone else.</li>
        </ul>
      </Section>

      <Section id="coaches" title="4. Coaches, team staff and rosters">
        <p>If you create a team or manage one as staff, you agree that:</p>
        <ul>
          <li>you have the authority of the team, club or league to manage it in Hooplings;</li>
          <li>
            before you add a child to a roster, or add a child’s email address or photo, you have the permission of the
            child’s parent or guardian to do so;
          </li>
          <li>
            you enter only information that is accurate and needed to run the team, and you invite only email
            addresses you have permission to use;
          </li>
          <li>
            you link a guardian only to a player for whom that person really is a parent or guardian;
          </li>
          <li>
            you understand that invitations and announcements are emailed on your behalf, and that the roster, its
            photos and the team’s statistics are visible to everyone on the team;
          </li>
          <li>
            you keep the roster current, including removing players and guardians who have left the team; and
          </li>
          <li>
            before you leave or delete your account, you hand a team you lead to another head coach if it is still
            active.
          </li>
        </ul>
      </Section>

      <Section id="families" title="5. Parents and guardians">
        <p>
          If you accept an invitation to be linked to a player as a parent or guardian, you confirm that you are that
          player’s parent or legal guardian. You can see the child’s teams and statistics, RSVP for the child and change
          the child’s name and photo. You can delete the child’s record if the child has never signed in, as described
          in the Privacy Policy.
        </p>
      </Section>

      <Section id="content" title="6. Your content">
        <p>
          “Your content” is what you put into the Service: names, photos, rosters, schedules, game events, messages,
          announcements and replies. You keep ownership of it. You give us a worldwide, non-exclusive, royalty-free
          licence to host, store, copy, process, display and transmit your content only as needed to operate, provide
          and improve the Service, including showing it to the people on your teams. The licence ends when your content
          is deleted, except that game events and statistics stay with the team without your name, and backup copies
          last for a short time, as the Privacy Policy describes.
        </p>
        <p>
          You confirm that you have the rights and permissions needed for the content you add, including any photo of
          another person.
        </p>
      </Section>

      <Section id="acceptable-use" title="7. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>break the law, or help anyone else to;</li>
          <li>harass, bully, threaten or demean anyone, or post hateful, sexual or violent content;</li>
          <li>post anything about a child that is not needed to run the team;</li>
          <li>impersonate someone or misrepresent your connection to a team, player or family;</li>
          <li>send invitations or announcements as spam, or to people who have not agreed to hear from the team;</li>
          <li>
            collect other people’s information from the Service, or copy it by automated means (scraping, bots);
          </li>
          <li>
            probe, disrupt or overload the Service, get around its limits or security, or access accounts or data that
            are not yours; or
          </li>
          <li>
            copy, modify, reverse engineer or resell the Service, except where the law allows it despite this term.
          </li>
        </ul>
        <p>We may remove content that breaks these terms.</p>
      </Section>

      <Section id="termination" title="8. Suspension and termination">
        <p>
          You can stop using Hooplings at any time and delete your account in the app (Profile → Account → Delete
          account). We may suspend or close an account, or remove content, if you break these terms, if we must do so by
          law, or to protect other users or the Service. Where it is reasonable, we will tell you first and explain why.
          Sections 6 (the licence to the extent described there), 10, 11, 12 and 13 survive termination.
        </p>
      </Section>

      <Section id="third-parties" title="9. App stores and other services">
        <p>
          You download the app from Apple’s App Store <Placeholder>OWNER DECISION: and Google Play, once released</Placeholder>,
          and the store’s own terms also apply. These terms are between you and us, not the store. Apple and Google are
          not responsible for the app or for supporting it, and have no obligation to provide maintenance or support.
          The Service relies on providers such as our sign-in, hosting and notification providers, and we are not
          responsible for their services.
        </p>
      </Section>

      <Section id="disclaimers" title="10. Disclaimers">
        <p>
          The Service is provided “as is” and “as available”. To the fullest extent the law allows, we make no
          warranties, express or implied, including of merchantability, fitness for a particular purpose and
          non-infringement. Statistics are only as accurate as the events recorded during a game, live scores can lag
          behind the court, and notifications and emails can be delayed or fail. Hooplings is not a safety, medical or
          emergency tool, and it does not supervise teams, coaches or events.
        </p>
      </Section>

      <Section id="liability" title="11. Limitation of liability">
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental, special, consequential or
          punitive damages, or for lost data, profits or goodwill, arising from your use of the Service. Our total
          liability for any claim about the Service is limited to the greater of the amount you paid us in the 12
          months before the claim and <Placeholder>LIABILITY CAP AMOUNT</Placeholder>. Some places do not allow these
          limits, so they may not all apply to you. Nothing in these terms limits liability that cannot be limited by
          law.
        </p>
      </Section>

      <Section id="indemnity" title="12. Indemnity">
        <p>
          To the extent the law allows, you agree to cover our reasonable costs and losses from a claim by someone else
          that arises from content you added or from your breach of these terms.
        </p>
      </Section>

      <Section id="governing-law" title="13. Governing law and disputes">
        <p>
          These terms are governed by the laws of <Placeholder>JURISDICTION</Placeholder>. Disputes will be resolved
          in <Placeholder>OWNER DECISION: courts or arbitration, and the venue</Placeholder>. If you live somewhere
          that gives you the right to bring a claim in your local courts or under your local consumer law, these
          terms do not take that right away.
        </p>
      </Section>

      <Section id="changes" title="14. Changes to these terms">
        <p>
          We may update these terms. We will change the effective date at the top and, if a change is significant,
          tell you in the app or by email before it takes effect. If you keep using the Service after a change takes
          effect, the new terms apply; if you do not agree, delete your account.
        </p>
      </Section>

      <Section id="general" title="15. General">
        <p>
          These terms and the Privacy Policy are the whole agreement between you and us about the Service. If a part
          of them cannot be enforced, the rest still applies. If we do not enforce a term straight away, we have not
          given up the right to. You may not transfer these terms to anyone else; we may transfer them as part of a
          merger, acquisition or sale of assets.
        </p>
      </Section>

      <Section id="contact" title="16. Contact us">
        <p>
          <Placeholder>LEGAL ENTITY NAME</Placeholder>, <Placeholder>REGISTERED ADDRESS</Placeholder>. Questions about
          these terms: <Email address={SUPPORT_EMAIL} />.
        </p>
      </Section>
    </LegalDocument>
  );
}
