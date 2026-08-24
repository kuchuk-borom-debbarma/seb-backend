/**
 * What somebody sees when they open an office screen their role does not reach.
 *
 * Deliberately not `RoleRefusal`. That one says "this part of Mission SEP is
 * for the programme office", which is the right thing to tell an applicant who
 * wandered in — and the wrong thing to tell a reviewer, who *is* the programme
 * office and is standing in it. They are not in the wrong place; they are in a
 * room they do not have the key to.
 *
 * So this names the one thing missing, says who has it, and offers the way back
 * to work they can do. Nothing is red and nothing apologises: holding a
 * narrower role is an ordinary fact about an account, not a mistake anybody
 * made.
 */
import { Link } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import styles from './RoleRefusal.module.css'

export function CapabilityRefusal({
  title,
  needs,
}: {
  /** What the screen is, so the sentence reads as a fact rather than an error. */
  title: string
  /** Who does hold it, in the words the office uses for them. */
  needs: string
}) {
  return (
    <main className="page">
      <PageHeader title={title} description={`This screen is open to ${needs}.`} />

      <section className={styles.panel}>
        <p className={styles.holding}>
          Your role covers the casework screens rather than this one. If you need it, ask
          a super administrator — changing what an account can do is theirs to do, and it
          is recorded when they do it.
        </p>

        <Link to="/admin" className="button" data-variant="primary">
          Back to dashboard
        </Link>
      </section>
    </main>
  )
}
