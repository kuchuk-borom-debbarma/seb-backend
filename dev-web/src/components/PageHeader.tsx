/** The title block every signed-in screen opens with. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? (
          <p className="muted page-header-description">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  )
}
