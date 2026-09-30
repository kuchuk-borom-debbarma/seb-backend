/**
 * Whether the office has asked this applicant for a correction.
 *
 * There is no status for it any more: a submitted application stays
 * `IN_PIPELINE` while a stage waits on the applicant, and what says so is an
 * open revision request — which is what makes stages editable again. So the
 * question is answered from the same field the form uses to unlock stages.
 */
export const awaitingCorrection = (
  application: { status: string; editableStageKeys: readonly string[] } | null | undefined,
): boolean =>
  application?.status === 'IN_PIPELINE' && application.editableStageKeys.length > 0
