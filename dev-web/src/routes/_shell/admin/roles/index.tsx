/**
 * The roles the office runs on.
 *
 * Authority is composed here rather than chosen from a fixed list, so this
 * screen is the one place the office decides what any of its own jobs may do.
 *
 * Two things it deliberately shows before offering a control. **How many people
 * hold a role**, because retiring one takes their access away on their very
 * next request and that should be a decision somebody makes knowing the cost,
 * not one they discover afterwards. And **what each role actually holds**, so a
 * name never has to be trusted to mean what it says.
 *
 * Reading is a permission. Composing is not — creating, editing and retiring a
 * role is the super administrator's alone, because a role able to hand out
 * roles could hand out everything. The create control is absent rather than
 * disabled for anybody else, since a control that always refuses teaches people
 * to ignore refusals.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { KeyRound, Plus, Users } from 'lucide-react'
import { PageHeader } from '#/components/PageHeader'
import { PermissionRefusal } from '#/features/portal/PermissionRefusal'
import {
  humanizeKey,
  permissionKey,
  rolesQuery,
  type Role,
} from '#/features/roles/roleQueries'
import { can, isSuperAdministrator } from '#/lib/session'
import styles from '#/features/roles/Roles.module.css'

export const Route = createFileRoute('/_shell/admin/roles/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(rolesQuery),
  component: RolesGate,
})

function RolesGate() {
  const { user } = Route.useRouteContext()
  if (!can(user, 'role', 'read')) {
    return (
      <PermissionRefusal
        title="Roles"
        needs="anybody who may read the office's roles"
      />
    )
  }
  return <RolesPage mayCompose={isSuperAdministrator(user)} />
}

function RolesPage({ mayCompose }: { mayCompose: boolean }) {
  const roles = useQuery(rolesQuery)
  const listed = roles.data?.response ?? []

  return (
    <main className="page">
      <PageHeader
        title="Roles"
        description={
          'What each job in the office may do. A person holds one or more of ' +
          'these, and what they may do is the union.'
        }
      />

      {roles.data && !roles.data.success ? (
        <div className="card"><p className="field-error">{roles.data.message}</p></div>
      ) : null}

      {mayCompose ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Link to="/admin/roles/new" className="button">
            <Plus size={16} aria-hidden /> Compose a role
          </Link>
        </div>
      ) : null}

      {/*
        `roles.data.success`, not `roles.isSuccess` — react-query's flag says
        the request resolved, which a refusal does too. Keyed on that, a refused
        read drew the refusal above *and* "no roles have been composed yet"
        beneath it, which is a different and untrue claim.
      */}
      {listed.length === 0 && roles.data?.success ? (
        <div className="card">
          <p>
            No roles have been composed yet.
            {mayCompose
              ? ' Compose one to describe a job the office does.'
              : ' A super administrator composes them.'}
          </p>
        </div>
      ) : null}

      <div className="stack">
        {listed.map((role) => (
          <RoleSummary key={role.id} role={role} mayCompose={mayCompose} />
        ))}
      </div>
    </main>
  )
}

function RoleSummary({ role, mayCompose }: { role: Role; mayCompose: boolean }) {
  return (
    <article className="card">
      <div className="card-header">
        <div>
          <h3 className={styles.title}>
            <KeyRound size={16} aria-hidden /> {role.name}
          </h3>
          <p className="field-hint">{role.description}</p>
        </div>
        {mayCompose ? (
          <Link to="/admin/roles/$key" params={{ key: role.key }} className="button" data-variant="ghost">
            Edit
          </Link>
        ) : null}
      </div>

      <dl className={styles.facts}>
        <div>
          <dt className="field-label">Key</dt>
          <dd><code>{role.key}</code></dd>
        </div>
        <div>
          <dt className="field-label">Held by</dt>
          <dd className={styles.withIcon}>
            <Users size={14} aria-hidden />
            {role.memberCount === 1 ? '1 account' : `${role.memberCount} accounts`}
          </dd>
        </div>
        <div>
          <dt className="field-label">Permissions</dt>
          <dd>{role.permissions.length}</dd>
        </div>
      </dl>

      {role.permissions.length === 0 ? (
        /*
         * A legitimate state, not a fault: a role starts empty and is filled in
         * as a second act, so a half-composed one is never live. Saying so
         * stops it reading as a bug.
         */
        <p className="field-hint">
          This role holds nothing yet, so it grants nothing.
        </p>
      ) : (
        <ul className={styles.chips}>
          {role.permissions.map((permission) => (
            <li key={permissionKey(permission)} className={styles.chip}>
              {humanizeKey(permission.resource)}: {permission.action}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
