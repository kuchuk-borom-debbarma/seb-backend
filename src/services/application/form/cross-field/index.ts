/** Every server-side cross-field rule, keyed by the catalogue's own union. */
import type { FormRuleType } from '../../../catalogue/workflow.generated'
import { atLeastOneTrue } from './at-least-one-true'
import { atMostField } from './at-most-field'
import type { FormRuleEvaluator } from './define'
import { differentValues } from './different-values'
import { sumAtMost } from './sum-at-most'

export const formRuleEvaluators = {
  AT_LEAST_ONE_TRUE: atLeastOneTrue,
  DIFFERENT_VALUES: differentValues,
  SUM_AT_MOST: sumAtMost,
  AT_MOST_FIELD: atMostField,
} satisfies Record<FormRuleType, FormRuleEvaluator>

