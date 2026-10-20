# Privacy

The privacy policy is at [alcoia.app/legal/privacy-policy](https://alcoia.app/legal/privacy-policy). It is the authoritative statement.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) describes what the code does with data: what stays on the device, what is sent to the server and why.

## Ideas noticed on web pages

On ordinary web pages the extension keeps a list of ideas that came up repeatedly (at most 400 labels), with counts of questions you answered right and wrong about them. It uses the list to ask less about what you know and to explain what you keep missing. The list is stored in the browser's local storage. It is never sent anywhere, is not synced, contains no page address, title or text, and can be cleared from the diagnostics page.
