/**
 * The pipeline drawn as a flow: stages left to right by how many moves they
 * are from where files enter, endings at the far right.
 *
 * Plain SVG, laid out by `flowOf`. Moves are solid, returns and revisions
 * dashed, endings green when they complete and red when they close. A stage no
 * route reaches is drawn dashed in a column of its own, because that is the
 * one mistake a picture shows faster than a list of problems.
 */
import { useMemo } from 'react'
import type { PipelineDefinition } from './definition'
import { flowOf, type FlowEdge, type FlowNode } from './flow'
import styles from './Pipeline.module.css'

const NODE_WIDTH = 176
const NODE_HEIGHT = 52
const COLUMN_GAP = 104
const ROW_GAP = 44
const PAD = 28

const x = (node: FlowNode) => PAD + node.column * (NODE_WIDTH + COLUMN_GAP)
const y = (node: FlowNode) => PAD + node.row * (NODE_HEIGHT + ROW_GAP)

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** Edges sharing ends and style are drawn once, their labels joined. */
const merged = (edges: readonly FlowEdge[]): FlowEdge[] => {
  const byEnds = new Map<string, FlowEdge>()
  for (const edge of edges) {
    const id = `${edge.from}→${edge.to}:${edge.style}`
    const existing = byEnds.get(id)
    if (!existing) byEnds.set(id, { ...edge })
    else if (!existing.label.split(' · ').includes(edge.label)) existing.label = `${existing.label} · ${edge.label}`
  }
  return [...byEnds.values()]
}

/** A curve between two nodes, and the point its label sits on. */
const route = (from: FlowNode, to: FlowNode, lane: number) => {
  if (to.column > from.column) {
    const sx = x(from) + NODE_WIDTH
    const sy = y(from) + NODE_HEIGHT / 2
    const tx = x(to)
    const ty = y(to) + NODE_HEIGHT / 2
    const bend = (tx - sx) / 2
    return {
      d: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
      labelX: (sx + tx) / 2,
      labelY: (sy + ty) / 2 - 6,
    }
  }
  // Backwards or within a column: under the boxes, each pair in its own lane.
  const sx = x(from) + NODE_WIDTH / 2 + 18
  const sy = y(from) + NODE_HEIGHT
  const tx = x(to) + NODE_WIDTH / 2 - 18
  const ty = y(to) + NODE_HEIGHT
  const drop = 30 + lane * 18
  const low = Math.max(sy, ty) + drop
  return {
    d: `M ${sx} ${sy} C ${sx} ${low}, ${tx} ${low}, ${tx} ${ty}`,
    labelX: (sx + tx) / 2,
    labelY: low - drop / 4 - 2,
  }
}

export function FlowDiagram({
  definition,
  onSelectStage,
}: {
  definition: PipelineDefinition
  onSelectStage?: (stageKey: string) => void
}) {
  const flow = useMemo(() => flowOf(definition), [definition])
  const byId = useMemo(() => new Map(flow.nodes.map((node) => [node.id, node])), [flow])
  const edges = useMemo(() => merged(flow.edges), [flow])

  const width = PAD * 2 + flow.columns * NODE_WIDTH + Math.max(0, flow.columns - 1) * COLUMN_GAP
  // Room beneath the last row for the backward lanes.
  const backLanes = edges.filter((edge) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    return from && to && to.column <= from.column
  }).length
  const height = PAD * 2 + flow.rows * NODE_HEIGHT + (flow.rows - 1) * ROW_GAP + 40 + backLanes * 18

  let lane = 0
  return (
    <div className={styles.flowWrap}>
      <svg
        className={styles.flow}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="The pipeline's stages and how an application moves between them"
      >
        <defs>
          {(['move', 'return', 'revision', 'end'] as const).map((style) => (
            <marker
              key={style}
              id={`arrow-${style}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className={styles[`arrow_${style}`]} />
            </marker>
          ))}
        </defs>

        {edges.map((edge) => {
          const from = byId.get(edge.from)
          const to = byId.get(edge.to)
          if (!from || !to) return null
          const backwards = to.column <= from.column
          const path = route(from, to, backwards ? lane++ : 0)
          return (
            <g key={`${edge.from}-${edge.to}-${edge.style}`}>
              <path
                d={path.d}
                className={styles[`edge_${edge.style}`]}
                markerEnd={`url(#arrow-${edge.style})`}
                fill="none"
              >
                <title>{edge.label}</title>
              </path>
              <text x={path.labelX} y={path.labelY} textAnchor="middle" className={styles.edgeLabel}>
                {clip(edge.label, 34)}
              </text>
            </g>
          )
        })}

        {flow.nodes.map((node) => {
          const selectable = node.kind === 'stage' && onSelectStage
          return (
            <g
              key={node.id}
              transform={`translate(${x(node)}, ${y(node)})`}
              className={selectable ? styles.nodeSelectable : undefined}
              onClick={selectable ? () => onSelectStage(node.id) : undefined}
              onKeyDown={
                selectable
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') onSelectStage(node.id)
                    }
                  : undefined
              }
              tabIndex={selectable ? 0 : undefined}
              role={selectable ? 'button' : undefined}
              aria-label={selectable ? `Open the stage ${node.label}` : undefined}
            >
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={node.kind === 'stage' ? 8 : NODE_HEIGHT / 2}
                className={
                  node.kind === 'end'
                    ? node.closes
                      ? styles.nodeClose
                      : styles.nodeComplete
                    : node.kind === 'applicant'
                      ? styles.nodeApplicant
                      : node.reachable
                        ? styles.nodeStage
                        : styles.nodeUnreachable
                }
              />
              <text x={NODE_WIDTH / 2} y={node.initial || !node.reachable ? 22 : 30} textAnchor="middle" className={styles.nodeLabel}>
                {clip(node.label, 24)}
              </text>
              {node.initial ? (
                <text x={NODE_WIDTH / 2} y={40} textAnchor="middle" className={styles.nodeNote}>
                  Files enter here
                </text>
              ) : !node.reachable ? (
                <text x={NODE_WIDTH / 2} y={40} textAnchor="middle" className={styles.nodeNoteWarn}>
                  Nothing reaches this
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      <p className="field-hint">
        Solid arrows move the application; dashed ones send it back or to the applicant. Rounded ends are where the
        journey finishes — green when it completes, red when it closes. Select a stage to edit it.
      </p>
    </div>
  )
}
