/**
 * The one place an announcement link becomes an `href`.
 *
 * The API already refused anything that could not safely be one, but this
 * renders on the public landing page, so the client repeats the decision
 * rather than trusting the wire: only kinds it knows, only shapes it expects,
 * and anything else renders as plain text instead of an anchor. The editor
 * validates through this same function, so what passes here is exactly what
 * will render.
 */
export type AnnouncementLinkView =
  | { href: string; external: true; anchor: false }
  | { href: string; external: false; anchor: boolean }

export const resolveAnnouncementLink = (
  link: { kind: string; target: string } | null | undefined,
): AnnouncementLinkView | null => {
  if (!link) return null
  if (link.kind === 'EXTERNAL') {
    let parsed: URL
    try {
      parsed = new URL(link.target)
    } catch {
      return null
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return { href: parsed.href, external: true, anchor: false }
  }
  if (link.kind === 'ROUTE') {
    if (
      !link.target.startsWith('/') ||
      link.target.startsWith('//') ||
      link.target.startsWith('/\\')
    ) {
      return null
    }
    return { href: link.target, external: false, anchor: false }
  }
  if (link.kind === 'ANCHOR') {
    if (!link.target.startsWith('#')) return null
    // Normalized to a landing-page address so the card works from any route;
    // on `/` itself the smooth-scroll handler intercepts it.
    return { href: `/${link.target}`, external: false, anchor: true }
  }
  return null
}
