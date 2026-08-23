/**
 * The title block every signed-in screen opens with.
 *
 * `description` is the lede: what this screen is for, in the reader's terms.
 * Every screen has one, because a screen that opens with a bare table teaches
 * nobody what they are looking at.
 *
 * `meta` is the identifying line that finishes the title — the cycle code, the
 * enterprise, when and where a meeting sits. It exists because three office
 * screens were spending the lede slot on it and so had no lede at all; folding
 * the two together would have buried the identity in a muted paragraph.
 */
export function PageHeader({
  title,
  meta,
  description,
  actions,
}: {
  title: string
  /** Identity that completes the title, not prose. Rendered above the lede. */
  meta?: string
  /** What this screen is for. */
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {meta ? <p className="page-header-meta">{meta}</p> : null}
        {description ? (
          <p className="muted page-header-description">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  )
}
