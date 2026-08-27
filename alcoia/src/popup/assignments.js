/* assignments.js — the Assignments entry point (item S6/E4 follow-up)
 *
 * Lists a signed-in student's own active assignments and opens a PDF one
 * through the EXISTING PDF viewer (src/pdf-viewer/viewer.js), extended —
 * not rebuilt — to accept a remote signed URL and an assignmentId. See
 * that file's own header for the confirmed remote-loading behaviour
 * (pdfjsLib.getDocument({url}) already worked for any http(s) URL; item
 * 31 proved this before this item touched it) and reading-bridge.js's own
 * header for how assignmentId reaches host.js's outcome reporting.
 *
 * PPTX/DOCX: no viewer exists for either yet (CLAUDE.md §7's own "PDF
 * works... do not advertise three formats before three work"). Shown
 * honestly as not viewable here, with a "Download instead" affordance
 * using the SAME signed URL this page already has — not a silent
 * failure, and not a second server call this item has no confirmed
 * endpoint for.
 */
import { createSessionManager } from '../shared/session.js';
import { createAssignmentsManager } from '../shared/assignments.js';

const $ = (id) => document.getElementById(id);

$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

const session = createSessionManager();
const assignments = createAssignmentsManager({
  getSession: session.getSession,
  mineUrl: self.ALCOIA_CONFIG.ASSIGNMENTS_MINE_URL,
  documentsUrl: self.ALCOIA_CONFIG.DOCUMENTS_URL,
});

const pageError = $('pageError');
const loadingState = $('loadingState');
const emptyState = $('emptyState');
const assignList = $('assignList');

function showError(text) {
  pageError.textContent = text;
  pageError.hidden = !text;
}

function fetchErrorMessage(code) {
  switch (code) {
    case 'no_session': return 'Sign in to see your assignments.';
    default: return "Couldn't load your assignments just now — try again.";
  }
}

function formatClosesAt(iso) {
  // Plain date/time, never a countdown (CLAUDE.md / ALCOIA-PLATFORM-
  // SPEC.md §7: "a due date is a window, not a countdown").
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch (e) {
    return iso;
  }
}

// The one PDF a row can open — the first accepted pdf document, matching
// this item's own "PDF only for now" scope. An assignment can have more
// than one document row (no uniqueness constraint server-side — see
// assignments.js's shared-module header); any additional ones are not
// surfaced separately here, since there is no confirmed way to tell them
// apart (no per-document title exists either).
function openablePdf(a) {
  return a.documents.find((d) => d.format === 'pdf' && d.status === 'accepted') || null;
}

async function openPdf(assignmentId, documentId, title) {
  const result = await assignments.getDownloadUrl(documentId);
  if (!result.ok) {
    showError("Couldn't open that document just now — try again.");
    return;
  }
  const viewerUrl = chrome.runtime.getURL('src/pdf-viewer/viewer.html')
    + '?src=' + encodeURIComponent(result.url)
    + '&assignmentId=' + encodeURIComponent(assignmentId)
    + '&title=' + encodeURIComponent(title);
  chrome.tabs.create({ url: viewerUrl });
}

async function downloadInstead(documentId) {
  const result = await assignments.getDownloadUrl(documentId);
  if (!result.ok) {
    showError("Couldn't fetch that file just now — try again.");
    return;
  }
  chrome.tabs.create({ url: result.url });
}

function renderRow(a) {
  const li = document.createElement('li');
  li.className = 'assign-row';

  const title = document.createElement('p');
  title.className = 'assign-row-title';
  title.textContent = a.className || 'Assignment';
  li.appendChild(title);

  const closes = document.createElement('p');
  closes.className = 'assign-row-closes';
  closes.textContent = `Closes ${formatClosesAt(a.closesAt)}`;
  li.appendChild(closes);

  const actionRow = document.createElement('div');
  actionRow.className = 'assign-row-action';

  const pdf = openablePdf(a);
  if (pdf) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-primary';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => openPdf(a.assignmentId, pdf.documentId, a.className || 'Assignment'));
    actionRow.appendChild(openBtn);
  } else if (a.documents.length > 0) {
    // A real document exists but this extension cannot render it (pptx,
    // docx, or a pdf the server itself marked 'unsupported') — honest
    // state, not a silent failure. "Download instead" uses the SAME
    // signed URL rather than a second, unconfirmed endpoint.
    const note = document.createElement('p');
    note.className = 'assign-row-note';
    note.textContent = 'Not viewable in the extension yet.';
    actionRow.appendChild(note);

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'assign-download-link';
    dl.textContent = 'Download instead';
    dl.addEventListener('click', () => downloadInstead(a.documents[0].documentId));
    actionRow.appendChild(dl);
  } else {
    const note = document.createElement('p');
    note.className = 'assign-row-note';
    note.textContent = 'No document uploaded yet.';
    actionRow.appendChild(note);
  }

  li.appendChild(actionRow);
  return li;
}

async function boot() {
  const current = await session.getSession();
  if (!current) {
    loadingState.hidden = true;
    showError(fetchErrorMessage('no_session'));
    return;
  }

  const result = await assignments.listMine();
  loadingState.hidden = true;

  if (!result.ok) {
    showError(fetchErrorMessage(result.error));
    return;
  }

  if (result.assignments.length === 0) {
    emptyState.hidden = false;
    return;
  }

  assignList.hidden = false;
  for (const a of result.assignments) assignList.appendChild(renderRow(a));
}

boot();
