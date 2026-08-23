/** Administration shares the same stable cursor contract as applicant lists. */
export {
  decodeCursor as decodeAdminCursor,
  encodeCursor as encodeAdminCursor,
  pageSize as adminPageSize,
  type SortKey,
} from '../application/pagination'
