// account.js — the sign-in screen (item S3, item E3 adds checkout resume)
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
//
// Item E3: a reader who clicked a plan while signed out lands here with
// sra_pending_checkout set (by upgrade.js). The moment a session appears,
// this resumes the checkout they actually asked for — they came here to
// finish subscribing, not just to sign in — then redirects back to
// upgrade.html with ?checkout=pending so that page shows the processing
// state immediately instead of waiting for a refocus event that already
// happened before it existed.
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';
import { createBillingManager } from '../shared/billing.js';

const PENDING_CHECKOUT_KEY = 'sra_pending_checkout';
// Long enough to sign in without rushing; short enough that a plan click
// abandoned days ago cannot silently resume as a surprise checkout tab on
// some unrelated later visit to this page.
const PENDING_CHECKOUT_MAX_AGE_MS = 10 * 60 * 1000;

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
// Item E3 — reuses this page's own session manager, same reasoning.
const billing = createBillingManager({
  getSession: session.getSession,
  checkoutUrl: self.ALCOIA_CONFIG.BILLING_CHECKOUT_URL,
  portalUrl: self.ALCOIA_CONFIG.BILLING_PORTAL_URL,
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

/* Item E3: resumes a checkout the reader started while signed out. Reads
 * and unconditionally clears sra_pending_checkout — a stale or expired
 * intent is discarded, never silently retried on some later, unrelated
 * sign-in. Only ever runs when a session now genuinely exists (checked by
 * the caller) — this never starts a checkout for a reader who is still
 * signed out. */
async function resumePendingCheckoutIfAny() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get({ [PENDING_CHECKOUT_KEY]: null }, (res) => resolve(res[PENDING_CHECKOUT_KEY])));
  if (!stored) return;
  await new Promise((resolve) => chrome.storage.local.remove(PENDING_CHECKOUT_KEY, resolve));

  const fresh = typeof stored.at === 'number' && Date.now() - stored.at < PENDING_CHECKOUT_MAX_AGE_MS;
  if (!fresh || typeof stored.plan !== 'string') return;

  const result = await billing.startCheckoutSession(stored.plan);
  if (result.ok) {
    // Same hard platform requirement as upgrade.js's own click handler —
    // an external hosted checkout page cannot be framed or hosted inside
    // this page/the popup, it must be a real tab.
    chrome.tabs.create({ url: result.checkoutUrl });
  }
  // Whether or not the resumed checkout itself succeeded, send the reader
  // back to the plans page — it is what they actually asked to see, and
  // upgrade.js's own error/processing states pick up from there correctly
  // either way.
  location.href = 'upgrade.html?checkout=pending';
}

// The handoff (background.js) can complete while this tab is still open —
// e.g. the reader clicked the emailed link in a second tab in the same
// browser. Reacting to the storage write directly is simpler and more
// honest than polling getSession() on a timer, and costs nothing when it
// never fires.
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(self.ALCOIA_CONFIG.SESSION_STORAGE_KEY in changes)) return;
  // Item E1: "refresh on sign-in" — the session key just changed (a fresh
  // sign-in landed, or a sign-out cleared it); either way the cached
  // entitlements from before this change are no longer trustworthy.
  // refresh() itself resolves a cleared/absent session to free, so this is
  // correct for sign-out too, not just sign-in.
  await entitlements.refresh();
  render();

  const current = await session.getSession();
  if (current) await resumePendingCheckoutIfAny();
});

render();
