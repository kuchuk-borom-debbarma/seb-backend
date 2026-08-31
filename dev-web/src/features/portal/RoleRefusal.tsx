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
import { belongsInTheOffice, isApplicant, type SignedInUser } from '#/lib/session'
import styles from './RoleRefusal.module.css'

/**
 * The two authorities that are not rows, and so have no name to read.
 *
 * This is not the table that was deleted. That one listed the four roles the
 * office now composes for itself, and went stale the moment somebody composed
 * another. These two are hardcoded in the API for the same reason they are
 * written out here: `SUPER_ADMIN` is the wildcard and `APPLICANT` is created
 * only by verified signup, so neither will ever be a `core_role` anybody can
 * rename.
 */
const BUILT_IN_ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: 'Super administrator',
  APPLICANT: 'Applicant',
}

/**
 * How a role reads in a sentence.
 *
 * Derived from the key for everything else, because a composed role's name
 * lives behind `role`/`read` and nobody seeing this screen holds it. Derivation
 * beats the alternative that was here: every real role fell through to the raw
 * key, and somebody was told they hold `CASEWORK_READER`.
 */
const roleWords = (key: string): string => {
  const known = BUILT_IN_ROLE_NAMES[key]
  if (known) return known
  const words = key.replace(/_/gu, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function RoleRefusal({
  portal,
  user,
}: {
  portal: 'applicant' | 'office'
  user: SignedInUser
}) {
  const held = user.roles.map(roleWords)
  /*
   * Asked the way each door asks it. The office side is `belongsInTheOffice`,
   * not a named permission: somebody holding an announcement-only or audit-only
   * role beside their applicant grant may cross over, and telling them they
   * cannot is the door and the navigation disagreeing again.
   */
  const canCrossOver =
    portal === 'applicant' ? belongsInTheOffice(user) : isApplicant(user)

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
              to={portal === 'applicant' ? '/admin' : '/dashboard'}
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
