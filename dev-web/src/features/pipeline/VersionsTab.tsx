/**
 * Every version of the pipeline, newest first: which one cycles pin now, which
 * is the draft, and the note each publish was made with.
 */
import { formatDateTime } from '#/lib/format'
import type { PipelineDetail } from './pipelineQueries'

export function VersionsTab({ detail }: { detail: PipelineDetail }) {
  const versions = [...detail.versions].sort((a, b) => b.version - a.version)
  return (
    <div className="table-wrap card">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">State</th>
            <th scope="col">Published</th>
            <th scope="col">Change note</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr key={version.id}>
              <td className="tabular">v{version.version}</td>
              <td>
                {version.status === 'DRAFT' ? (
                  <span className="badge" data-tone="warn">Draft · revision {version.revision}</span>
                ) : version.version === detail.currentPublishedVersion ? (
                  <span className="badge" data-tone="ok">Current — new cycles pin this</span>
                ) : (
                  <span className="badge">Published earlier</span>
                )}
              </td>
              <td>{version.publishedAt ? formatDateTime(version.publishedAt) : <span className="muted">—</span>}</td>
              <td>{version.changeNote ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field-hint" style={{ padding: '0 1rem 1rem' }}>
        A cycle keeps the version it opened with, and its applications keep it too, so publishing never re-routes a file
        already being worked.
      </p>
    </div>
  )
}
