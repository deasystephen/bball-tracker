import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './legal.module.css';

/**
 * Shared shell for the legal pages (#25). `_legal` is a private App Router
 * folder: nothing in it becomes a route.
 *
 * Both documents are drafts awaiting the owner's (and ideally a lawyer's)
 * review. Every value the owner still has to supply renders through
 * `Placeholder` as bracketed, highlighted text, so a search for "[" in the
 * rendered page finds all of them. Remove `DraftNotice` when the owner
 * publishes the final text.
 */

export const PRIVACY_EMAIL = 'privacy@hooplings.com';
/** Must equal `SUPPORT_EMAIL` in `backend/src/services/mailer/templates/brand.ts` (pinned by a test). */
export const SUPPORT_EMAIL = 'support@hooplings.com';

export function Placeholder({ children }: { children: ReactNode }) {
  return <mark className={styles.placeholder}>[{children}]</mark>;
}

export function DraftNotice() {
  return (
    <div className={styles.draftNotice} role="note">
      <strong>Draft.</strong> This document has not been reviewed or published yet. Text in highlighted brackets
      is a placeholder or an open decision for the owner.
    </div>
  );
}

export function Email({ address }: { address: string }) {
  return <a href={`mailto:${address}`}>{address}</a>;
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}

export function Summary({ children }: { children: ReactNode }) {
  return <div className={styles.summary}>{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  );
}

export function LegalDocument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <article className={styles.document}>
        <h1>{title}</h1>
        <p className={styles.meta}>
          Effective date: <Placeholder>EFFECTIVE DATE</Placeholder>
        </p>
        <DraftNotice />
        {children}
        <Link className={styles.backLink} href="/">
          Back to Hooplings
        </Link>
      </article>
    </main>
  );
}
