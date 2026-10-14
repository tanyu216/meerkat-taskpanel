/**
 * Constants read from the *system under test* (the repo at `process.cwd()`),
 * so a probe cannot drift from the SUT's own idea of e.g. the attachments
 * directory name.
 */
export const { ATTACHMENTS_DIRNAME, ATTACHMENT_MAX_BYTES, DB_BUSY_MAX_ATTEMPTS } = await import(
  `file://${process.cwd()}/src/shared/constants.mjs`
);
