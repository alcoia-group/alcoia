import { defineConfig } from 'vitest/config';

// Run 6 (19 November 2026) saw two 5-second timeouts (host.test.js, upgrade.test.js) while six heavy jobs shared one
// machine; both passed alone. Fifteen seconds leaves a loaded CI runner room without hiding a real hang.
export default defineConfig({ test: { testTimeout: 15000 } });
