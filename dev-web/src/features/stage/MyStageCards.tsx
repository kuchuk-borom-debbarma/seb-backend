/**
 * One card per stage the person works, grouped by pipeline, each linking to
 * that stage's queue. Drawn on "My stages" and on the office dashboard, so
 * both say the same thing about the same stages.
 */
import { Link } from '@tanstack/react-router'
import { Inbox } from 'lucide-react'
import type { MyStagesQuery } from '#/graphql/generated/operations'
import styles from './Stage.module.css'

type WorkedStage = NonNullable<
  MyStagesQuery['admin']['stage']['myStages']['response']
>[number]

export function MyStageCards({ stages }: { stages: readonly WorkedStage[] }) {
  if (stages.length === 0) {
    return (
      <div className="card card-body">
        <p
          className="muted"
          style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}
        >
          <Inbox size={18} aria-hidden="true" />
          None of your roles works a stage of a published pipeline yet. Stage owners are
          set on the pipeline’s Owners tab.
        </p>
      </div>
    )
  }

  // Grouped by pipeline, in the order the API returned them.
  const pipelines = new Map<
    string,
    { name: string; version: number; stages: WorkedStage[] }
  >()
  for (const stage of stages) {
    const group = pipelines.get(stage.pipelineId) ?? {
      name: stage.pipelineName,
      version: stage.pipelineVersion,
      stages: [],
    }
    group.stages.push(stage)
    pipelines.set(stage.pipelineId, group)
  }

  return (
    <div className="stack" style={{ gap: '20px' }}>
      {[...pipelines.entries()].map(([pipelineId, group]) => (
        <section key={pipelineId} aria-label={group.name}>
          {pipelines.size > 1 ? (
            <h2 className="field-label" style={{ marginBottom: '8px' }}>
              {group.name} <span className="muted">· version {group.version}</span>
            </h2>
          ) : null}
          <div className={styles.stageGrid}>
            {group.stages.map((stage) => (
              <Link
                key={stage.stageKey}
                to="/admin/stages/$pipelineId/$stageKey"
                params={{ pipelineId: stage.pipelineId, stageKey: stage.stageKey }}
                className={styles.stageCard}
                data-empty={stage.waiting === 0 ? 'true' : undefined}
              >
                <span className={styles.stageCardText}>
                  <span className={styles.stageCardName}>{stage.stageName}</span>
                  <span className={styles.stageCardPipeline}>{stage.pipelineName}</span>
                </span>
                <span className={styles.stageCount}>
                  <strong>{stage.waiting}</strong>
                  waiting
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
