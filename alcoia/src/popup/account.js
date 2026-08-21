// account.js — the sign-in screen (item S3)
//
// Magic-link only, no password field exists anywhere in this file. The
// actual code-for-session exchange happens in background.js's
// onMessageExternal listener, triggered externally by the Phase 1 landing
// page (alcoiaWeb) once a reader clicks the emailed link — this page never
// receives that handoff directly (extension pages cannot receive
// onMessageExternal, only background.js can). What this page owns is
// requesting the link and reflecting whatever session state already
// exists, including reactively noticing when the handoff completes while
// this tab happens to still be open.
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';

const $ = (id) => document.getElementById(id);

$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

const session = createSessionManager();
// Item E1 — reuses this page's own session manager rather than
// constructing a second one; see entitlements.js's own header.
const entitlements = createEntitlementsManager({
  getSession: session.getSession,
  entitlementsUrl: self.ALCOIA_CONFIG.ENTITLEMENTS_URL,
});

const signInForm = $('signInForm');
const checkEmailState = $('checkEmailState');
const signedInState = $('signedInState');
const formError = $('formError');

function showForm() {
  signInForm.hidden = false;
  checkEmailState.hidden = true;
  signedInState.hidden = true;
}
function showCheckEmail(email) {
  signInForm.hidden = true;
  checkEmailState.hidden = false;
  signedInState.hidden = true;
  $('checkEmailSub').textContent = `We sent a sign-in link to ${email}. Open it in this same browser to finish signing in.`;
}
function showSignedIn(email) {
  signInForm.hidden = true;
  checkEmailState.hidden = true;
  signedInState.hidden = false;
  $('signedInEmail').textContent = email;
}

async function render() {
  const current = await session.getSession();
  if (current) showSignedIn(current.email);
  else showForm();
}

$('signInFormEl').addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const email = $('emailInput').value.trim();
  if (!email) return;

  const sendBtn = $('sendLinkBtn');
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';

  const ok = await session.requestMagicLink(email, self.ALCOIA_CONFIG.MAGIC_LINK_REQUEST_URL);

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send magic link';

  if (ok) {
    showCheckEmail(email);
  } else {
    // Honest, not a silent retry — the reader can try again themselves.
    formError.textContent = "Couldn't send that link. Check the address and try again.";
    formError.hidden = false;
  }
});

$('signOutBtn').addEventListener('click', async () => {
  await session.clearSession();
  showForm();
});

// The handoff (background.js) can complete while this tab is still open —
// e.g. the reader clicked the emailed link in a second tab in the same
// browser. Reacting to the storage write directly is simpler and more
// honest than polling getSession() on a timer, and costs nothing when it
// never fires.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(self.ALCOIA_CONFIG.SESSION_STORAGE_KEY in changes)) return;
  // Item E1: "refresh on sign-in" — the session key just changed (a fresh
  // sign-in landed, or a sign-out cleared it); either way the cached
  // entitlements from before this change are no longer trustworthy.
  // refresh() itself resolves a cleared/absent session to free, so this is
  // correct for sign-out too, not just sign-in.
  entitlements.refresh();
  render();
});

render();
