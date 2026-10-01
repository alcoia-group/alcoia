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
 * Opening: PDF, PowerPoint and Word documents open in the alcoia web reader
 * (assignments.alcoia.app). The popup asks the server for a one-time handoff
 * code and opens <reader>/a/<id>#c=<code>, which signs the student in with no
 * sign-in step. If the handoff fails (server not reachable, reader not
 * deployed yet) a PDF falls back to the extension's own viewer below, which
 * stays as the fallback; other formats say so plainly and offer a download.
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
  assignmentsUrl: self.ALCOIA_CONFIG.ASSIGNMENTS_URL,
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
    default: return "Couldn't load your assignments just now. Try again.";
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

// Formats the web reader can show. Status is deliberately not checked: a row
// uploaded before its format could be read keeps a stale 'unsupported' until
// the server re-reads it, and the reader (which converts on open) is what
// corrects that. A file that really cannot be read shows a download there.
const READER_FORMATS = ['pdf', 'pptx', 'docx'];
function readerDocument(a) {
  return a.documents.find((d) => READER_FORMATS.includes(d.format)) || null;
}

async function openInReader(a, doc) {
  const handoff = await assignments.requestReaderHandoff(a.assignmentId);
  if (handoff.ok) {
    const url = self.ALCOIA_CONFIG.READER_ORIGIN
      + '/a/' + encodeURIComponent(a.assignmentId)
      + '#c=' + encodeURIComponent(handoff.code);
    chrome.tabs.create({ url });
    return;
  }
  // Fall back to what worked before the web reader existed.
  if (doc.format === 'pdf') {
    await openPdf(a.assignmentId, doc.documentId, a.className || 'Assignment');
    return;
  }
  showError("Couldn't open that document just now. Try again.");
}

async function openPdf(assignmentId, documentId, title) {
  const result = await assignments.getDownloadUrl(documentId);
  if (!result.ok) {
    showError("Couldn't open that document just now. Try again.");
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
    showError("Couldn't fetch that file just now. Try again.");
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

  const doc = readerDocument(a);
  if (doc) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-primary';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => openInReader(a, doc));
    actionRow.appendChild(openBtn);
  } else if (a.documents.length > 0) {
    // A real document exists in a format the reader does not show —
    // honest state, not a silent failure. "Download instead" uses the SAME
    // signed URL rather than a second, unconfirmed endpoint.
    const note = document.createElement('p');
    note.className = 'assign-row-note';
    note.textContent = 'This file type can\'t be opened here.';
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
