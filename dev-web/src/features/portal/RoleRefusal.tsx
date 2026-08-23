/**
 * What somebody sees when they open a portal their account cannot use.
 *
 * This is not an error. It is an ordinary fact about an account, and it is
 * written the way the rest of the interface writes an empty state: say what is
 * true, then offer the real next action. Nobody arrives here having done
 * anything wrong, so nothing apologises and nothing is red.
 *
 * The three cases are genuinely different and each gets its own way out:
 *
 *   - holds the other portal's role  → a link to the portal they can use
 *   - holds nothing at all           → the exact words to ask for
 *   - holds the role but is refused  → cannot happen; the gates check first
 */
import { Link } from '@tanstack/react-router'
import { PageHeader } from '#/components/PageHeader'
import { isAdministrator, isApplicant, type SignedInUser } from '#/lib/session'
import styles from './RoleRefusal.module.css'

/** How a role reads in a sentence, matching the overview screen's vocabulary. */
const ROLE_NAMES: Record<string, string> = {
  APPLICANT: 'Applicant',
  ADMIN: 'Programme officer',
  SUPER_ADMIN: 'Super administrator',
}

export function RoleRefusal({
  portal,
  user,
}: {
  portal: 'applicant' | 'office'
  user: SignedInUser
}) {
  const held = user.roles.map((role) => ROLE_NAMES[role] ?? role)
  const canCrossOver = portal === 'applicant' ? isAdministrator(user) : isApplicant(user)

  return (
    <main className="page">
      <PageHeader
        title={
          portal === 'applicant'
            ? 'This part of Mission SEP is for applicants'
            : 'This part of Mission SEP is for the programme office'
        }
        description={
          portal === 'applicant'
            ? 'Registering an enterprise and applying for seed funding needs the applicant role.'
            : 'Reviewing applications, recording decisions and administering awards needs a programme office role.'
        }
      />

      <section className={styles.panel}>
        <p className={styles.holding}>
          {held.length > 0 ? (
            <>
              This account holds <strong>{held.join(' and ')}</strong>.
            </>
          ) : (
            <>This account holds no roles yet.</>
          )}
        </p>

        {canCrossOver ? (
          <>
            <p className={styles.body}>
              {portal === 'applicant'
                ? 'The programme office console is where your work is.'
                : 'The applicant portal is where your applications are.'}
            </p>
            <Link
              to={portal === 'applicant' ? '/admin' : '/'}
              className="button"
              data-variant="primary"
            >
              {portal === 'applicant'
                ? 'Go to the programme office'
                : 'Go to the applicant portal'}
            </Link>
          </>
        ) : (
          <>
            {/*
              With no way across, the next step is a person rather than a
              button. So the screen gives them the sentence to send instead of a
              control that would only be refused.
            */}
            <p className={styles.body}>
              A super administrator grants roles. Ask one for the role you need, quoting
              the address you signed in with:
            </p>
            <p className={styles.quote}>
              Please grant <span className="tabular">{user.email}</span> the{' '}
              {portal === 'applicant' ? 'applicant' : 'programme officer'} role.
            </p>
          </>
        )}
      </section>

      <p className={styles.aside}>
        <Link to="/guide">How Mission SEP works</Link> explains what each role does, and
        is open to everyone.
      </p>
    </main>
  )
}
