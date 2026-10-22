# Privacy

The privacy policy is at [alcoia.app/legal/privacy-policy](https://alcoia.app/legal/privacy-policy). It is the authoritative statement.

In short: passage text goes to the server only to make questions, explanations and other help while you read. If you do not trust our server, this client is open source and works with a backend you run yourself (set a Backend URL under developer tools).

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes what the code does with data: what stays on the device, what is sent to the server and why.

## Ideas noticed on web pages

On ordinary web pages the extension keeps a list of ideas that came up repeatedly (at most 400 labels), with counts of questions you answered right and wrong about them. It uses the list to ask less about what you know and to explain what you keep missing. The list is stored in the browser's local storage. It is never sent anywhere, is not synced, contains no page address, title or text, and can be cleared from the diagnostics page.

## Which sites alcoia runs on

alcoia asks for no access to ordinary websites when you install it. You switch it on for a site from the toolbar popup ("Use alcoia on this site"), or for every website from Settings, "Where alcoia runs". The browser shows its own permission prompt each time, and you can take access back from the same place. alcoia's own sites are always covered.

alcoia never runs, reads or sends text from banking, tax, health-record, webmail, government sign-in and similar pages, even where you have switched everywhere on. It also steps back from any page that shows a password or card-number field. The built-in list is in `alcoia/src/shared/sensitive-sites.js`; Settings lets you add your own sites, which are stored in this browser only (`sra_sensitive_sites`). The extension does not ask for the browser's `tabs` or `webNavigation` permissions.

## Documents on your account

Signed in, the ideas found in your readings and files (`sra_doc_concepts_cache`) are cached in this browser to suggest connections between them. They are labels, with no page text. Settings and your reading speed follow your account when account-based learning is on (see `docs/ARCHITECTURE.md`, Statefulness).

## Reading pace

To tell a slow paragraph from a hard one, the extension keeps, in this browser, a few numbers: your usual words per minute per language and three fitted coefficients per language that say how much slower you read text with rarer words and longer clauses (`sra_baseline_wpm_by_lang`, `sra_time_model_by_lang`). Numbers only, no text, no page addresses. When you are signed in with account-based learning on, the words-per-minute figure also follows your account; the coefficients stay in the browser. No time spent on any paragraph or screen is sent anywhere.
