/* upgrade.js — the plans page (item E3 turns the Reader tier's buttons on;
 * a same-day follow-up adds Student once confirmed server-side)
 *
 * Every disabled button here used to say, honestly, "no checkout is wired
 * up yet — a page that looks like it can take money before it can is the
 * one kind of bug here that costs somebody else something." This wires up
 * the Reader tier, and — confirmed separately, see below — the Student
 * plan, against the CONFIRMED alcoiaServer contract, read directly from
 * src/http/routes/billing.js before any of this was written:
 *
 *   POST /api/billing/checkout   { plan: 'reader' | 'student' } -> { checkout_url }
 *   GET  /api/billing/portal                                    -> { portal_url }
 *
 * Both Bearer-authenticated with the same session token E1/E2 already
 * established. Neither takes a billing-period field — the Annual/Monthly
 * toggle below is cosmetic only; src/billing/plans.js maps 'reader' to
 * exactly one Creem product_id. Not invented here, flagged in the PR.
 *
 * STUDENT IS THE SAME ENTITLEMENT AS READER, NEVER A SECOND TIER —
 * confirmed both ways before wiring its button: src/billing/plans.js maps
 * 'student' to CREEM_PRODUCT_ID_STUDENT exactly like 'reader' maps to
 * CREEM_PRODUCT_ID_READER (both set in the real .env, not just documented
 * in .env.example), and src/entitlements/resolve.js always returns the
 * literal `tier: 'reader'` for ANY account with an active plan — the
 * stored plan key ('reader' or 'student') never resurfaces in the
 * entitlements response at all. So hasFeature() needed zero changes: a
 * Student subscriber is indistinguishable from a Reader one the moment
 * checkout completes, which is why the Student action below has no
 * "current plan" state of its own — the Reader tier's own action area
 * already shows it once either checkout succeeds.
 *
 * WHY "RETURN FROM CHECKOUT" IS A REFOCUS EVENT, NOT A MESSAGE: Creem's
 * hosted checkout redirects the browser to a fixed, server-configured web
 * page (BILLING_SUCCESS_URL, e.g. console.alcoia.app/billing/success) —
 * confirmed in alcoiaServer's src/config.js. That page is not this
 * extension and cannot message it. So this page cannot be TOLD checkout
 * finished; it has to ASK, and the only reliable moment to ask is when the
 * reader comes back to this tab (visibilitychange). That is also
 * inherently honest about what it doesn't know: a refocus might mean
 * "I paid," "I cancelled," or "I switched tabs to check something else" —
 * this cannot tell those apart, so it always re-asks the server
 * (entitlements.refresh() — Phase 3's own mechanism, not a second cache)
 * and shows whatever comes back, never assuming success from the tab
 * simply having opened.
 *
 * SIGNED-OUT RESUME: a plan click while signed out stores the chosen plan
 * under sra_pending_checkout and routes to account.html in the SAME tab.
 * account.js's own sign-in-detection listener resumes checkout from
 * there — see that file — and redirects back here with `?checkout=pending`
 * so this page shows the processing state immediately rather than waiting
 * for a refocus that already happened before this page existed.
 *
 * ENTITLEMENT SOURCE (item S6 follow-up): "entitled" alone (hasFeature)
 * used to be all this page needed, because the only action was "manage
 * your subscription." Now a reader can also be entitled via a class seat
 * (item S6), and that reader has nothing to manage on Creem's side — the
 * Manage-subscription link would be a dead end. Confirmed by reading
 * alcoiaServer's src/entitlements/resolve.js directly: the server did NOT
 * distinguish source at all before this task (a subscriber-with-a-seat was
 * byte-for-byte identical, over the wire, to a subscriber-without-one), so
 * a small additive field (hasActiveSeat) was added there first — see that
 * file's own comment — and entitlements.js's getEntitlementSource() derives
 * 'subscription' | 'seat' | 'free' from it. Never inferred from this
 * extension's own local sra_class_membership record alone: that record is
 * only ever used below to LABEL which class, once the server has already
 * confirmed a seat is active — a reader could hold a stale local record
 * for a class left on another device while the server reports no active
 * seat at all, or vice versa, and the server's bit is what actually
 * decides the message shown, every time.
 */
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';
import { createBillingManager } from '../shared/billing.js';

const CLASS_MEMBERSHIP_KEY = 'sra_class_membership';

function seatOnlyMessage(classId) {
  return classId
    ? `You have Reader access through Class ${classId}.`
    : 'You have Reader access through a class seat.';
}
function alsoInClassMessage(classId) {
  return classId
    ? `You're also enrolled in Class ${classId}, which includes Reader on its own.`
    : "You're also enrolled in a class that includes Reader on its own.";
}
function teamsMembershipMessage(classId) {
  return classId
    ? `You're a member of Class ${classId} under this plan.`
    : "You're a member of a class under this plan.";
}

// Display-only, same known limitation join-class.html already states
// plainly: no server endpoint resolves a classId to a name yet (confirmed
// by reading alcoiaServer's classes.js/invites.js — see src/shared/
// invites.js's own header). This never decides WHETHER a seat is active —
// only which id to print once the server has already said one is.
async function getLocalClassId() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get({ [CLASS_MEMBERSHIP_KEY]: null }, (res) => resolve(res[CLASS_MEMBERSHIP_KEY])));
  return stored && typeof stored.classId === 'string' ? stored.classId : null;
}

const PRICES = {
  annual:  { amount: '$4.92', unit: '/mo', note: '$59 billed annually' },
  monthly: { amount: '$9',    unit: '/mo', note: 'Billed monthly, cancel any time' },
};

const session = createSessionManager();
const entitlements = createEntitlementsManager({
  getSession: session.getSession,
  entitlementsUrl: self.ALCOIA_CONFIG.ENTITLEMENTS_URL,
});
const billing = createBillingManager({
  getSession: session.getSession,
  checkoutUrl: self.ALCOIA_CONFIG.BILLING_CHECKOUT_URL,
  portalUrl: self.ALCOIA_CONFIG.BILLING_PORTAL_URL,
});

function checkoutErrorMessage(code) {
  switch (code) {
    case 'billing_not_configured': return "Checkout isn't available yet. Try again later.";
    case 'invalid_session':        return 'Your session expired. Sign in again to continue.';
    case 'invalid_plan':           return "That plan isn't recognised. Try reloading this page.";
    case 'no_subscription':        return "You don't have a subscription to manage yet.";
    default:                       return "Couldn't reach that just now. Try again.";
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  try {
    const light = $('logo-img');
    const dark = $('logo-img-dark');
    if (light) light.src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
    if (dark) dark.src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
  } catch (e) { /* opened outside an extension context */ }

  try {
    chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
      document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
    });
  } catch (e) { /* no storage */ }

  const price = $('readerPrice');
  const note = $('readerNote');
  const annualBtn = $('annualBtn');
  const monthlyBtn = $('monthlyBtn');
  const readerBtn = $('readerBtn');
  const stateNote = $('readerStateNote');
  const manageBtn = $('manageBtn');
  const studentBtn = $('studentBtn');
  const studentStateNote = $('studentStateNote');
  const readerSeatNote = $('readerSeatNote');
  const teamsBtn = $('teamsBtn');
  const teamsStateNote = $('teamsStateNote');

  function setPeriod(period) {
    const p = PRICES[period];
    if (!p || !price || !note) return;
    price.innerHTML = `${p.amount}<span class="unit">${p.unit}</span>`;
    note.textContent = p.note;
    annualBtn.classList.toggle('active', period === 'annual');
    monthlyBtn.classList.toggle('active', period === 'monthly');
    annualBtn.setAttribute('aria-pressed', String(period === 'annual'));
    monthlyBtn.setAttribute('aria-pressed', String(period === 'monthly'));
  }
  annualBtn?.addEventListener('click', () => setPeriod('annual'));
  monthlyBtn?.addEventListener('click', () => setPeriod('monthly'));
  $('closeBtn')?.addEventListener('click', () => window.close());

  // Set the moment a checkout tab is actually opened (by this page, or by
  // account.js just before redirecting back here) — never assumed true
  // just because a session exists or a click happened.
  let checkoutInFlight = new URL(location.href).searchParams.get('checkout') === 'pending';

  function showStateNote(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'plan-state-note' + (kind ? ' ' + kind : '');
    el.hidden = !text;
  }

  /* The one render function for BOTH checkout actions — Reader's own
   * button and Student's inline one — since they lead to the identical
   * entitlement (see this file's own header). Reads entitlements via
   * hasFeature() ONLY — never a bare tier comparison (CLAUDE.md, and
   * entitlements.js's own header: "no other module reads chrome.storage
   * for plan state directly... everything goes through hasFeature()").
   * own_documents stands in for "on the Reader-or-Student plan" — every
   * reader-tier feature arrives together (entitlements.js's own
   * READER_FEATURES), so any one of them is representative; this never
   * reads or branches on the tier NAME itself, and never needs to tell
   * apart which of the two checkouts got them there. */
  async function renderReaderTier() {
    if (!readerBtn) return;

    const signedIn = await session.getSession();
    if (!signedIn) {
      readerBtn.hidden = false;
      readerBtn.disabled = false;
      readerBtn.textContent = 'Sign in to subscribe';
      if (manageBtn) manageBtn.hidden = true;
      if (studentBtn) { studentBtn.hidden = false; studentBtn.disabled = false; }
      if (!checkoutInFlight) { showStateNote(stateNote, '', null); showStateNote(studentStateNote, '', null); }
      showStateNote(readerSeatNote, '', null);
      return;
    }

    const entitled = await entitlements.hasFeature('own_documents');
    if (entitled) {
      checkoutInFlight = false;
      // Bug found here: hiding alone left the button showing whatever
      // label/disabled state a prior "Opening checkout…"/"Waiting…" had
      // set, because nothing ever reset it once entitled — genuinely
      // visible in-browser (a `.btn { display: inline-flex }` rule beats
      // `[hidden]`'s equal-specificity UA default; see panel.css's own
      // comment on the CSS half of this fix). Resetting label/disabled
      // HERE, not just .hidden, means the button is correct even if it is
      // ever shown again later (a downgrade), not just invisible while
      // secretly stale.
      readerBtn.hidden = true;
      readerBtn.disabled = false;
      readerBtn.textContent = 'Subscribe';

      // Item S6 follow-up — see this file's own header for why this reads
      // getEntitlementSource() rather than inferring from local storage.
      const { source, hasActiveSeat } = await entitlements.getEntitlementSource();
      const localClassId = hasActiveSeat ? await getLocalClassId() : null;

      if (source === 'seat') {
        // No subscription exists to manage — the portal link would be a
        // dead end, so it stays hidden, and the seat message becomes the
        // PRIMARY note rather than a secondary addition to it.
        if (manageBtn) manageBtn.hidden = true;
        showStateNote(stateNote, seatOnlyMessage(localClassId), 'current');
        showStateNote(readerSeatNote, '', null);
      } else {
        // Subscription is the source (with or without a seat also
        // active) — the prior task's fix is untouched: manage link shown,
        // "You're on the Reader plan." stays the primary note.
        if (manageBtn) manageBtn.hidden = false;
        showStateNote(stateNote, "You're on the Reader plan.", 'current');
        // "Both" case: an explicit second line, never hidden in favour of
        // the subscription message above it.
        showStateNote(readerSeatNote, hasActiveSeat ? alsoInClassMessage(localClassId) : '', hasActiveSeat ? 'current' : null);
      }

      // Same entitlement, so the Student action has nothing left to do —
      // hidden rather than shown alongside a manage link that already
      // covers it, avoiding two competing "you already have this"
      // moments.
      if (studentBtn) {
        studentBtn.hidden = true;
        studentBtn.disabled = false;
        studentBtn.textContent = 'start checkout';
      }
      showStateNote(studentStateNote, '', null);
      return;
    }

    readerBtn.hidden = false;
    if (manageBtn) manageBtn.hidden = true;
    if (studentBtn) studentBtn.hidden = false;
    showStateNote(readerSeatNote, '', null);
    if (checkoutInFlight) {
      readerBtn.disabled = true;
      readerBtn.textContent = 'Waiting…';
      if (studentBtn) studentBtn.disabled = true;
      const processing = "Processing. This can take a few seconds after you finish on Creem's page. Come back to this tab once you're done there.";
      showStateNote(stateNote, processing, null);
      showStateNote(studentStateNote, processing, null);
    } else {
      readerBtn.disabled = false;
      readerBtn.textContent = 'Subscribe';
      if (studentBtn) studentBtn.disabled = false;
      showStateNote(stateNote, '', null);
      showStateNote(studentStateNote, '', null);
    }
  }

  /* Item S6 follow-up. There is no self-serve checkout for this tier at
   * all (this file's own header) — the button stays disabled/"Coming
   * soon" for everyone except a reader who already holds an active class
   * seat, where it reflects that real membership instead. Not a Teams
   * console: the only action offered is a link into the ALREADY-BUILT
   * leave/manage flow in join-class.html (item S6), opened as its own
   * tab the same way every other cross-page action in this file works —
   * nothing about class membership is managed on this page itself. */
  async function renderTeamsTier() {
    if (!teamsBtn) return;

    const signedIn = await session.getSession();
    if (!signedIn) {
      teamsBtn.disabled = true;
      teamsBtn.textContent = 'Coming soon';
      showStateNote(teamsStateNote, '', null);
      return;
    }

    const { hasActiveSeat } = await entitlements.getEntitlementSource();
    if (!hasActiveSeat) {
      teamsBtn.disabled = true;
      teamsBtn.textContent = 'Coming soon';
      showStateNote(teamsStateNote, '', null);
      return;
    }

    const localClassId = await getLocalClassId();
    teamsBtn.disabled = false;
    teamsBtn.textContent = 'Manage your class membership';
    showStateNote(teamsStateNote, teamsMembershipMessage(localClassId), 'current');
  }

  teamsBtn?.addEventListener('click', () => {
    if (teamsBtn.disabled) return;
    chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/join-class.html') });
  });

  /* Shared by the Reader button and the Student link — same
   * startCheckoutSession() call, only the plan key and which button/note
   * pair reflects it differ. Signed-out click: remember the plan, route
   * to sign-in, resume there (see account.js) — generic over `plan`
   * already, no changes needed there for a second plan key. */
  async function startCheckout(plan, btn, noteEl, busyLabel, idleLabel) {
    const signedIn = await session.getSession();
    if (!signedIn) {
      await new Promise((resolve) => chrome.storage.local.set(
        { sra_pending_checkout: { plan, at: Date.now() } }, resolve,
      ));
      location.href = 'account.html';
      return;
    }

    const restoreLabel = btn.textContent;
    btn.disabled = true;
    if (busyLabel) btn.textContent = busyLabel;
    const result = await billing.startCheckoutSession(plan);

    if (!result.ok) {
      btn.disabled = false;
      btn.textContent = idleLabel ?? restoreLabel;
      showStateNote(noteEl, checkoutErrorMessage(result.error), 'error');
      return;
    }

    // A hosted external checkout page cannot be framed or hosted inside
    // this page/the popup — a real tab is a hard platform requirement,
    // not a style choice.
    chrome.tabs.create({ url: result.checkoutUrl });
    checkoutInFlight = true;
    renderReaderTier();
  }

  readerBtn?.addEventListener('click', () => startCheckout('reader', readerBtn, stateNote, 'Opening checkout…', 'Subscribe'));
  studentBtn?.addEventListener('click', () => startCheckout('student', studentBtn, studentStateNote, 'Opening checkout…', 'start checkout'));

  manageBtn?.addEventListener('click', async () => {
    manageBtn.disabled = true;
    const result = await billing.getManagePortalUrl();
    manageBtn.disabled = false;
    if (result.ok) chrome.tabs.create({ url: result.portalUrl });
    else showStateNote(stateNote, checkoutErrorMessage(result.error), 'error');
  });

  // The only "return from checkout" signal available — see this file's
  // own header for why. Always re-asks the server via Phase 3's own
  // refresh(), never assumes success from the tab having opened.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!checkoutInFlight) return;
    entitlements.refresh().then(() => { renderReaderTier(); renderTeamsTier(); });
  });

  // A session appearing/disappearing (signed in elsewhere, or via
  // account.js while this tab is still open) should update this page too,
  // without waiting for a refocus.
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(self.ALCOIA_CONFIG.SESSION_STORAGE_KEY in changes)) return;
    renderReaderTier();
    renderTeamsTier();
  });

  setPeriod('annual');
  renderReaderTier();
  renderTeamsTier();
});
