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
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';
import { createInvitesManager } from '../shared/invites.js';

const PENDING_INVITE_KEY = 'sra_pending_invite';
const PENDING_INVITE_MAX_AGE_MS = 10 * 60 * 1000;
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
});

const inputState = $('inputState');
const disclosureState = $('disclosureState');
const memberState = $('memberState');
const inputError = $('inputError');
const disclosureError = $('disclosureError');
const leaveError = $('leaveError');

let disclosureRendered = false;
let pendingInviteText = '';

function hideErrors() {
  inputError.hidden = true;
  disclosureError.hidden = true;
  leaveError.hidden = true;
}

function showInput(prefill) {
  disclosureRendered = false;
  inputState.hidden = false;
  disclosureState.hidden = true;
  memberState.hidden = true;
  hideErrors();
  if (typeof prefill === 'string') $('inviteInput').value = prefill;
}

function showDisclosure(inviteText) {
  pendingInviteText = inviteText;
  inputState.hidden = true;
  disclosureState.hidden = false;
  memberState.hidden = true;
  hideErrors();
  // The explicit half of the guard — see this file's own header. Only
  // ever set true here, right after the disclosure block is actually in
  // the visible DOM.
  disclosureRendered = true;
}

function showMember(classId) {
  disclosureRendered = false;
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

  const result = await invites.acceptInvite(pendingInviteText);

  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Join this class';

  if (!result.ok) {
    disclosureError.textContent = joinErrorMessage(result.error);
    disclosureError.hidden = false;
    return;
  }

  await new Promise((resolve) => chrome.storage.local.set({
    [CLASS_MEMBERSHIP_KEY]: { classId: result.classId, seatId: result.seatId, role: result.role, joinedAt: Date.now() },
  }, resolve));

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

  showDisclosure(raw);
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
      showDisclosure(pending.invite);
      return;
    }
  }

  showInput();
}

boot();
