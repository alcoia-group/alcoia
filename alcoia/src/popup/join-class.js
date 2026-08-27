// join-class.js — accepting a class invite, with the disclosure gate (item S6)
//
// THE HARD RULE THIS FILE EXISTS TO ENFORCE: a join must never complete
// without the disclosure ("what your instructor can see") having actually
// rendered first. That is not a UX nicety here — ALCOIA-PLATFORM-SPEC.md §6
// calls it "the highest-stakes trust surface in the product." Two
// independent things guarantee it, not one:
//   1. Structurally: confirmJoinBtn lives INSIDE #disclosureState's own DOM
//      subtree in join-class.html — there is no code path where that
//      button exists in the page without the disclosure text also being
//      present, because they are the same render.
//   2. Explicitly: disclosureRendered, set true only inside showDisclosure()
//      and checked before acceptInvite() is ever called, so this is a
//      directly testable invariant, not just "trust the HTML structure."
//
// account.js's OWN resume-after-sign-in path deliberately does NOT
// complete a join itself, for exactly this reason — see that file's own
// header. A reader routed through sign-in always lands back HERE, and
// still sees the disclosure fresh before anything is submitted.
//
// LTI entry (item S6/E4 follow-up): background.js's onMessageExternal
// LTI-launch handler opens this SAME page — not a second disclosure
// screen — when a Canvas launch reports disclosureRequired: true. See
// this file's own showDisclosure()/completeJoin() for the second entry
// path (pendingLtiAckCode alongside pendingInviteText) and background.js's
// own header for the confirmed server shapes.
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';
import { createInvitesManager } from '../shared/invites.js';

const PENDING_INVITE_KEY = 'sra_pending_invite';
const PENDING_INVITE_MAX_AGE_MS = 10 * 60 * 1000;
const PENDING_LTI_LAUNCH_KEY = 'sra_pending_lti_launch';
const PENDING_LTI_LAUNCH_MAX_AGE_MS = 10 * 60 * 1000;
const CLASS_MEMBERSHIP_KEY = 'sra_class_membership';

const $ = (id) => document.getElementById(id);

$('logo-img').src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
$('logo-img-dark').src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
  document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
});
$('closeBtn').addEventListener('click', () => window.close());

const session = createSessionManager();
const entitlements = createEntitlementsManager({
  getSession: session.getSession,
  entitlementsUrl: self.ALCOIA_CONFIG.ENTITLEMENTS_URL,
});
const invites = createInvitesManager({
  getSession: session.getSession,
  acceptUrl: self.ALCOIA_CONFIG.INVITE_ACCEPT_URL,
  seatsUrl: self.ALCOIA_CONFIG.SEATS_URL,
  ltiAckUrl: self.ALCOIA_CONFIG.LTI_DISCLOSURE_ACK_URL,
});

const inputState = $('inputState');
const disclosureState = $('disclosureState');
const memberState = $('memberState');
const inputError = $('inputError');
const disclosureError = $('disclosureError');
const leaveError = $('leaveError');

let disclosureRendered = false;
let pendingInviteText = '';
// Set instead of pendingInviteText for the LTI entry path (item S6/E4
// follow-up) — mutually exclusive with it; completeJoin() below branches
// on which one is set, never both at once, since showInput()/showMember()
// clear both together.
let pendingLtiAckCode = '';

function hideErrors() {
  inputError.hidden = true;
  disclosureError.hidden = true;
  leaveError.hidden = true;
}

function showInput(prefill) {
  disclosureRendered = false;
  pendingLtiAckCode = '';
  inputState.hidden = false;
  disclosureState.hidden = true;
  memberState.hidden = true;
  hideErrors();
  if (typeof prefill === 'string') $('inviteInput').value = prefill;
}

// Takes no argument — callers set pendingInviteText OR pendingLtiAckCode
// (never both) immediately before calling this, so the SAME disclosure
// render (this function, this DOM) serves both entry paths without
// knowing or caring which one led here. The explicit half of the join-
// cannot-complete-without-disclosure guard — see this file's own header —
// is this same disclosureRendered flag either path sets, right after the
// disclosure block is actually in the visible DOM.
function showDisclosure() {
  inputState.hidden = true;
  disclosureState.hidden = false;
  memberState.hidden = true;
  hideErrors();
  disclosureRendered = true;
}

function showMember(classId) {
  disclosureRendered = false;
  pendingInviteText = '';
  pendingLtiAckCode = '';
  inputState.hidden = true;
  disclosureState.hidden = true;
  memberState.hidden = false;
  hideErrors();
  $('memberClassId').textContent = `Class ${classId}`;
}

function joinErrorMessage(code) {
  switch (code) {
    case 'invalid_invite':          return "That invite code isn't recognised — double check the link or code.";
    case 'invite_revoked':          return 'This invite has been cancelled by the instructor.';
    case 'invite_expired':          return 'This invite has expired — ask your instructor for a new one.';
    case 'domain_mismatch':         return "This invite is limited to a specific email domain, and your account's email doesn't match.";
    case 'already_a_member':        return "You're already in this class.";
    case 'invite_full':             return 'This invite has reached its limit — ask your instructor for a new one.';
    case 'seat_capacity_exceeded':  return "This class doesn't have any open seats right now.";
    case 'no_session':              return 'Something went wrong signing you in — try again.';
    case 'no_token':                return 'Paste an invite link or code first.';
    // LTI entry (item S6/E4 follow-up) — server codes from
    // POST /api/lti/disclosure/ack, confirmed by reading
    // alcoiaServer's src/http/routes/lti.js directly.
    case 'invalid_code':            return 'This launch link has expired — go back to Canvas and open the reading again.';
    case 'code_already_used':       return 'This launch was already confirmed — go back to Canvas and open the reading again.';
    case 'code_expired':            return 'This launch link has expired — go back to Canvas and open the reading again.';
    case 'acknowledgement_required':
    case 'no_ack_code':             return 'Something went wrong confirming this — go back to Canvas and try again.';
    case 'no_seat_id':              return "This class membership came from your school's system and can't be left here.";
    default:                        return "Couldn't join that class just now — try again.";
  }
}

async function completeJoin() {
  // The structural guard's explicit half — see this file's own header.
  // Genuinely unreachable in normal use (confirmJoinBtn only exists
  // inside the disclosure's own DOM subtree), kept as a hard stop rather
  // than trusting the HTML alone.
  if (!disclosureRendered) {
    throw new Error('join-class.js: completeJoin() called without the disclosure having rendered — this must never happen');
  }

  const confirmBtn = $('confirmJoinBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Joining…';

  const result = pendingLtiAckCode
    ? await invites.acknowledgeLtiDisclosure(pendingLtiAckCode)
    : await invites.acceptInvite(pendingInviteText);

  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Join this class';

  if (!result.ok) {
    disclosureError.textContent = joinErrorMessage(result.error);
    disclosureError.hidden = false;
    return;
  }

  if (pendingLtiAckCode) {
    // LTI: no session existed before this call — a successful ack is what
    // mints one (background.js's onMessageExternal handler does the same
    // thing for a launch that skipped the disclosure because it was
    // already acknowledged; this is the branch for the one that wasn't).
    await new Promise((resolve) => chrome.storage.local.set({
      [self.ALCOIA_CONFIG.SESSION_STORAGE_KEY]: { token: result.sessionToken, email: '', expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000 },
      [CLASS_MEMBERSHIP_KEY]: { classId: result.classId, seatId: null, role: null, joinedAt: Date.now() },
    }, resolve));
  } else {
    await new Promise((resolve) => chrome.storage.local.set({
      [CLASS_MEMBERSHIP_KEY]: { classId: result.classId, seatId: result.seatId, role: result.role, joinedAt: Date.now() },
    }, resolve));
  }

  // "Holding a seat grants Reader entitlements automatically" — refresh
  // now, using Phase 3's own mechanism, not a guess that it worked.
  await entitlements.refresh();

  showMember(result.classId);
}

$('inputFormEl').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideErrors();
  const raw = $('inviteInput').value.trim();
  if (!raw) return;

  const current = await session.getSession();
  if (!current) {
    // Signed-out: remember the invite, route to sign-in, resume there —
    // see account.js. Deliberately does NOT show the disclosure yet or
    // call accept — that only ever happens after this same field's value
    // is back in front of the reader, on this page, post sign-in.
    await new Promise((resolve) => chrome.storage.local.set(
      { [PENDING_INVITE_KEY]: { invite: raw, at: Date.now() } }, resolve,
    ));
    location.href = 'account.html';
    return;
  }

  pendingInviteText = raw;
  showDisclosure();
});

$('confirmJoinBtn').addEventListener('click', () => { completeJoin(); });

$('backBtn').addEventListener('click', () => {
  showInput($('inviteInput').value);
});

$('leaveBtn').addEventListener('click', async () => {
  const leaveBtn = $('leaveBtn');
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get({ [CLASS_MEMBERSHIP_KEY]: null }, (res) => resolve(res[CLASS_MEMBERSHIP_KEY])));
  if (!stored) { showInput(); return; }

  leaveBtn.disabled = true;
  leaveBtn.textContent = 'Leaving…';
  const result = await invites.releaseSeat(stored.seatId);
  leaveBtn.disabled = false;
  leaveBtn.textContent = 'Leave this class';

  if (!result.ok) {
    leaveError.textContent = joinErrorMessage(result.error);
    leaveError.hidden = false;
    return;
  }

  await new Promise((resolve) => chrome.storage.local.remove(CLASS_MEMBERSHIP_KEY, resolve));
  // Releasing reverts the account to free (ALCOIA-PLATFORM-SPEC.md §6) —
  // reflect it now via Phase 3's own refresh(), not by assuming.
  await entitlements.refresh();
  showInput();
});

async function boot() {
  // Checked FIRST, before any existing membership — background.js opened
  // THIS tab specifically because a fresh Canvas launch needs the
  // disclosure shown, and that signal is short-lived and single-use
  // server-side (lti_pending_launches). A student must never see a stale
  // "you're already in class X" screen (from some earlier, unrelated
  // native join) when the reason this tab exists at all is a new launch
  // waiting on this exact screen.
  const ltiPending = await new Promise((resolve) =>
    chrome.storage.local.get({ [PENDING_LTI_LAUNCH_KEY]: null }, (res) => resolve(res[PENDING_LTI_LAUNCH_KEY])));
  if (ltiPending) {
    await new Promise((resolve) => chrome.storage.local.remove(PENDING_LTI_LAUNCH_KEY, resolve));
    const fresh = typeof ltiPending.at === 'number' && Date.now() - ltiPending.at < PENDING_LTI_LAUNCH_MAX_AGE_MS;
    if (fresh && typeof ltiPending.ackCode === 'string' && ltiPending.ackCode) {
      pendingLtiAckCode = ltiPending.ackCode;
      showDisclosure();
      return;
    }
    // Stale or malformed — the ackCode is single-use and short-lived
    // server-side regardless, so showing it now would just fail cleanly
    // on submit; falling through to the normal checks below is the
    // honest option rather than showing a disclosure this specific launch
    // can no longer actually complete.
  }

  const membership = await new Promise((resolve) =>
    chrome.storage.local.get({ [CLASS_MEMBERSHIP_KEY]: null }, (res) => resolve(res[CLASS_MEMBERSHIP_KEY])));
  if (membership) {
    showMember(membership.classId);
    return;
  }

  // Resumed from account.js after signing in specifically to finish this
  // join — the disclosure still has to render fresh here (see this file's
  // own header), so this jumps straight to showDisclosure(), never
  // straight to completeJoin().
  const pending = await new Promise((resolve) =>
    chrome.storage.local.get({ [PENDING_INVITE_KEY]: null }, (res) => resolve(res[PENDING_INVITE_KEY])));
  if (pending) {
    await new Promise((resolve) => chrome.storage.local.remove(PENDING_INVITE_KEY, resolve));
    const fresh = typeof pending.at === 'number' && Date.now() - pending.at < PENDING_INVITE_MAX_AGE_MS;
    const current = await session.getSession();
    if (fresh && typeof pending.invite === 'string' && current) {
      pendingInviteText = pending.invite;
      showDisclosure();
      return;
    }
  }

  showInput();
}

boot();
