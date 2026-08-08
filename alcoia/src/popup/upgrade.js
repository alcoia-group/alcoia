/* upgrade.js — the plans page.
 *
 * MV3 blocks inline scripts on extension pages, so this exists to do two
 * small things: resolve the packaged logos and swap the Reader price between
 * billing periods.
 *
 * No checkout is wired up, deliberately. The figures are provisional (see the
 * TODO in upgrade.html) and every purchase button is disabled — a page that
 * looks like it can take money before it can is the one kind of bug here that
 * costs somebody else something.
 */

const PRICES = {
  annual:  { amount: '$4.92', unit: '/mo', note: '$59 billed annually' },
  monthly: { amount: '$9',    unit: '/mo', note: 'Billed monthly, cancel any time' },
};

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  try {
    const light = $('logo-img');
    const dark = $('logo-img-dark');
    if (light) light.src = chrome.runtime.getURL('assets/alcoia-wordmark.png');
    if (dark) dark.src = chrome.runtime.getURL('assets/alcoia-wordmark-white.png');
  } catch (e) { /* opened outside an extension context */ }

  // Match whatever the reader set in the popup, so the page does not arrive in
  // a different theme from the panel that opened it.
  try {
    chrome.storage.local.get({ sra_dark_mode: false }, (res) => {
      document.body.classList.toggle('dark-mode', !!res.sra_dark_mode);
    });
  } catch (e) { /* no storage */ }

  const price = $('readerPrice');
  const note = $('readerNote');
  const annualBtn = $('annualBtn');
  const monthlyBtn = $('monthlyBtn');

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
});
