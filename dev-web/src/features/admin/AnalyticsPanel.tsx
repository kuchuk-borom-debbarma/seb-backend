/**
 * The programme's intake, as numbers and one part-to-whole chart.
 *
 * Drawn by hand as SVG circle segments rather than with a chart library: the
 * chart is two or three slices whose only job is share-of-total, and a library
 * would cost more bundle than the rest of the dashboard.
 *
 * Colour carries the category and nothing else, assigned to the entity rather
 * than to its rank so a filtered summary can never repaint a surviving slice.
 * The palette (blue, green, purple on white) passes the colour-vision and
 * contrast checks; identity is never colour alone — every slice appears in the
 * legend with its name, count and share.
 */
import { useQuery } from '@tanstack/react-query'
import { formatMoney, humanize } from '#/lib/format'
import styles from '#/features/dashboard/Dashboard.module.css'
import { analyticsSummaryQuery } from './analyticsQueries'

type Tone = 'blue' | 'green' | 'purple'

/**
 * Fixed by entity, not by position: Category A is always blue, wherever it
 * lands in the list and however the office filters.
 */
const CATEGORY_TONES: Record<string, Tone> = {
  CATEGORY_A: 'blue',
  CATEGORY_B: 'green',
}
const UNBANDED_TONE: Tone = 'purple'

const categoryLabel = (category: string | null): string =>
  category === null ? 'No funding band' : humanize(category)

type Slice = { label: string; count: number; share: number; tone: Tone }

/** The geometry every segment shares. One place, so the ring and its track agree. */
const RADIUS = 58
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** A hair of surface between adjacent slices, so fills never touch. */
const GAP = 3

function CategoryDonut({ slices, total }: { slices: Slice[]; total: number }) {
  // A one-slice ring needs no gaps: there is no neighbour to separate from.
  const gap = slices.length > 1 ? GAP : 0
  let consumed = 0
  const segments = slices.map((slice) => {
    const length = slice.share * CIRCUMFERENCE
    const segment = { ...slice, length: Math.max(length - gap, 0), offset: consumed + gap / 2 }
    consumed += length
    return segment
  })
  const described = slices
    .map((slice) => `${slice.label} ${slice.count} (${Math.round(slice.share * 100)}%)`)
    .join(', ')
  return (
    <svg
      className={styles.donutChart}
      viewBox="0 0 160 160"
      role="img"
      aria-label={`Funding band distribution: ${described}.`}
    >
      {segments.map((segment) => (
        <circle
          key={segment.label}
          className={styles.donutSegment}
          data-color={segment.tone}
          cx="80"
          cy="80"
          r={RADIUS}
          fill="none"
          strokeWidth="20"
          strokeDasharray={`${segment.length} ${CIRCUMFERENCE - segment.length}`}
          strokeDashoffset={-segment.offset}
          // Start at twelve o'clock; dashes otherwise begin at three.
          transform="rotate(-90 80 80)"
        />
      ))}
      <text x="80" y="76" textAnchor="middle" className={styles.donutTotal}>
        {total}
      </text>
      <text x="80" y="94" textAnchor="middle" className={styles.donutCaption}>
        applications
      </text>
    </svg>
  )
}

export function AnalyticsPanel() {
  const { data, isError } = useQuery(analyticsSummaryQuery)
  /*
   * The panel is an extra for programme leads; a failed read must not take the
   * working dashboard down with it, so it simply says what happened.
   */
  if (isError) {
    return (
      <section className={styles.adminCard} aria-label="Programme analytics">
        <h2 className={styles.adminCardTitle}>Programme analytics</h2>
        <p className={styles.analyticsEmpty}>The analytics could not be loaded.</p>
      </section>
    )
  }
  if (!data) return null
  const total = data.statuses.reduce((sum, entry) => sum + entry.count, 0)
  const slices: Slice[] = total === 0
    ? []
    : data.categories.map((entry) => ({
        label: categoryLabel(entry.category),
        count: entry.count,
        share: entry.count / total,
        tone: entry.category === null
          ? UNBANDED_TONE
          : CATEGORY_TONES[entry.category] ?? UNBANDED_TONE,
      }))
  return (
    <section className={styles.adminCard} aria-label="Programme analytics">
      <div className={styles.adminCardHeader}>
        <h2 className={styles.adminCardTitle}>Programme analytics</h2>
      </div>

      <div className={styles.analyticsStats}>
        <div className={styles.analyticsStat}>
          <span className={styles.analyticsStatLabel}>Applications</span>
          <strong className={styles.analyticsStatValue}>{total}</strong>
        </div>
        <div className={styles.analyticsStat}>
          <span className={styles.analyticsStatLabel}>Carrying a readable ask</span>
          <strong className={styles.analyticsStatValue}>{data.requested.count}</strong>
        </div>
        <div className={styles.analyticsStat}>
          <span className={styles.analyticsStatLabel}>Total requested</span>
          <strong className={styles.analyticsStatValue}>
            {formatMoney(data.requested.totalPaise)}
          </strong>
        </div>
        <div className={styles.analyticsStat}>
          <span className={styles.analyticsStatLabel}>Average ask</span>
          <strong className={styles.analyticsStatValue}>
            {formatMoney(data.requested.averagePaise)}
          </strong>
        </div>
      </div>

      {slices.length === 0 ? (
        <p className={styles.analyticsEmpty}>
          Nothing has been submitted yet, so there is nothing to chart.
        </p>
      ) : (
        <div className={styles.analyticsChartRow}>
          <CategoryDonut slices={slices} total={total} />
          <ul className={styles.donutLegend} aria-label="Funding bands">
            {slices.map((slice) => (
              <li key={slice.label} className={styles.legendRow}>
                <span
                  className={styles.legendSwatch}
                  data-color={slice.tone}
                  aria-hidden="true"
                />
                <span className={styles.legendLabel}>{slice.label}</span>
                <span className={styles.legendCount}>
                  {slice.count} · {Math.round(slice.share * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
