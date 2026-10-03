/* reader-context.js — is this page the alcoia workspace, and which
 * assignment is it showing? (workspace.alcoia.app, repo alcoiaAssignments)
 *
 * The workspace is an ordinary web page to the extension, so the content
 * script reads it like any article. The one thing the page cannot say is
 * "this reading belongs to assignment X" for outcome reporting, so the URL
 * does: /a/<assignmentId>. Anything else (the sign-in page, the assignment
 * list, another site that happens to have the same path) is not a reader
 * context and reports nothing.
 *
 * Pure: takes the location and the reader origin, touches nothing global.
 */
const ASSIGNMENT_PATH = /^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function readerAssignmentId(loc, readerOrigin) {
  if (!loc || !readerOrigin || loc.origin !== readerOrigin) return null;
  const m = ASSIGNMENT_PATH.exec(loc.pathname || '');
  return m ? m[1].toLowerCase() : null;
}
