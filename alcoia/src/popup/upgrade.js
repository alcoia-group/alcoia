/* upgrade.js — the plans page (item E3 turns the Reader tier's buttons on)
 *
 * Every disabled button here used to say, honestly, "no checkout is wired
 * up yet — a page that looks like it can take money before it can is the
 * one kind of bug here that costs somebody else something." This wires up
 * exactly the Reader tier (the only one the server has a self-serve
 * checkout for — see upgrade.html's own comment on why Teams/Institution
 * stay inert) against the CONFIRMED alcoiaServer contract, read directly
 * from src/http/routes/billing.js before any of this was written:
 *
 *   POST /api/billing/checkout   { plan: 'reader' | 'student' } -> { checkout_url }
 *   GET  /api/billing/portal                                    -> { portal_url }
 *
 * Both Bearer-authenticated with the same session token E1/E2 already
 * established. Neither takes a billing-period field — the Annual/Monthly
 * toggle below is cosmetic only; src/billing/plans.js maps 'reader' to
 * exactly one Creem product_id. Not invented here, flagged in the PR.
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
 */
import { createSessionManager } from '../shared/session.js';
import { createEntitlementsManager } from '../shared/entitlements.js';
import { createBillingManager } from '../shared/billing.js';

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
    case 'billing_not_configured': return "Checkout isn't available yet — try again later.";
    case 'invalid_session':        return 'Your session expired — sign in again to continue.';
    case 'invalid_plan':           return "That plan isn't recognised — try reloading this page.";
    case 'no_subscription':        return "You don't have a subscription to manage yet.";
    default:                       return "Couldn't reach that just now — try again.";
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

  function showStateNote(text, kind) {
    if (!stateNote) return;
    stateNote.textContent = text || '';
    stateNote.className = 'plan-state-note' + (kind ? ' ' + kind : '');
    stateNote.hidden = !text;
  }

  /* The one render function for the Reader tier's action area. Reads
   * entitlements via hasFeature() ONLY — never a bare tier comparison
   * (the project notes, and entitlements.js's own header: "no other module reads
   * chrome.storage for plan state directly... everything goes through
   * hasFeature()"). own_documents stands in for "on the Reader plan" —
   * every reader-tier feature arrives together (entitlements.js's own
   * READER_FEATURES), so any one of them is representative; this never
   * reads or branches on the tier NAME itself. */
  async function renderReaderTier() {
    if (!readerBtn) return;

    const signedIn = await session.getSession();
    if (!signedIn) {
      readerBtn.hidden = false;
      readerBtn.disabled = false;
      readerBtn.textContent = 'Sign in to subscribe';
      if (manageBtn) manageBtn.hidden = true;
      if (!checkoutInFlight) showStateNote('', null);
      return;
    }

    const entitled = await entitlements.hasFeature('own_documents');
    if (entitled) {
      checkoutInFlight = false;
      readerBtn.hidden = true;
      if (manageBtn) manageBtn.hidden = false;
      showStateNote("You're on the Reader plan.", 'current');
      return;
    }

    readerBtn.hidden = false;
    if (manageBtn) manageBtn.hidden = true;
    if (checkoutInFlight) {
      readerBtn.disabled = true;
      readerBtn.textContent = 'Waiting…';
      showStateNote(
        "Processing — this can take a few seconds after you finish on Creem's page. Come back to this tab once you're done there.",
        null,
      );
    } else {
      readerBtn.disabled = false;
      readerBtn.textContent = 'Subscribe';
      showStateNote('', null);
    }
  }

  async function startReaderCheckout() {
    const signedIn = await session.getSession();
    if (!signedIn) {
      // Signed-out click: remember the plan, route to sign-in, resume
      // there — see account.js.
      await new Promise((resolve) => chrome.storage.local.set(
        { sra_pending_checkout: { plan: 'reader', at: Date.now() } }, resolve,
      ));
      location.href = 'account.html';
      return;
    }

    readerBtn.disabled = true;
    readerBtn.textContent = 'Opening checkout…';
    const result = await billing.startCheckoutSession('reader');

    if (!result.ok) {
      readerBtn.disabled = false;
      readerBtn.textContent = 'Subscribe';
      showStateNote(checkoutErrorMessage(result.error), 'error');
      return;
    }

    // A hosted external checkout page cannot be framed or hosted inside
    // this page/the popup — a real tab is a hard platform requirement,
    // not a style choice.
    chrome.tabs.create({ url: result.checkoutUrl });
    checkoutInFlight = true;
    renderReaderTier();
  }
  readerBtn?.addEventListener('click', startReaderCheckout);

  manageBtn?.addEventListener('click', async () => {
    manageBtn.disabled = true;
    const result = await billing.getManagePortalUrl();
    manageBtn.disabled = false;
    if (result.ok) chrome.tabs.create({ url: result.portalUrl });
    else showStateNote(checkoutErrorMessage(result.error), 'error');
  });

  // The only "return from checkout" signal available — see this file's
  // own header for why. Always re-asks the server via Phase 3's own
  // refresh(), never assumes success from the tab having opened.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!checkoutInFlight) return;
    entitlements.refresh().then(renderReaderTier);
  });

  // A session appearing/disappearing (signed in elsewhere, or via
  // account.js while this tab is still open) should update this page too,
  // without waiting for a refocus.
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(self.ALCOIA_CONFIG.SESSION_STORAGE_KEY in changes)) return;
    renderReaderTier();
  });

  setPeriod('annual');
  renderReaderTier();
});
