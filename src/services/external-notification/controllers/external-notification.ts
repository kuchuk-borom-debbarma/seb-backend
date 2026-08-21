/**
 * Development notification transport. Its small function contract is the seam
 * where a production email or Queue-backed implementation will be substituted.
 * Never use this console transport in a publicly deployed environment.
 */
export const sendEmail = async (input: {
  to: string
  subject: string
  text: string
}): Promise<void> => {
  console.log('[external-notification:email]', {
    to: input.to,
    subject: input.subject,
    text: input.text,
  })
}
