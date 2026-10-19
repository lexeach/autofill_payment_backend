// CORS allowlist. Add each real Chrome Extension ID below.
// Format: 'chrome-extension://YOUR_REAL_EXTENSION_ID'
// Replace the example values; do not leave placeholders as real origins.
const extensionOrigins = [
  // 'chrome-extension://PASTE_EXTENSION_ID_01',
  // 'chrome-extension://PASTE_EXTENSION_ID_02',
  // 'chrome-extension://PASTE_EXTENSION_ID_03',
  // 'chrome-extension://PASTE_EXTENSION_ID_04',
  // 'chrome-extension://PASTE_EXTENSION_ID_05',
  // 'chrome-extension://PASTE_EXTENSION_ID_06',
  // 'chrome-extension://PASTE_EXTENSION_ID_07',
  // 'chrome-extension://PASTE_EXTENSION_ID_08',
  // 'chrome-extension://PASTE_EXTENSION_ID_09',
  // 'chrome-extension://PASTE_EXTENSION_ID_10',
  // 'chrome-extension://PASTE_EXTENSION_ID_11',
  // 'chrome-extension://PASTE_EXTENSION_ID_12',
  // 'chrome-extension://PASTE_EXTENSION_ID_13',
  // 'chrome-extension://PASTE_EXTENSION_ID_14',
  // 'chrome-extension://PASTE_EXTENSION_ID_15',
  // 'chrome-extension://PASTE_EXTENSION_ID_16',
  // 'chrome-extension://PASTE_EXTENSION_ID_17',
  // 'chrome-extension://PASTE_EXTENSION_ID_18',
  // 'chrome-extension://PASTE_EXTENSION_ID_19',
  // 'chrome-extension://PASTE_EXTENSION_ID_20',
];

// Dashboard origin is needed for browser requests from the web dashboard.
const webOrigins = [
  'https://autofil.netlify.app',
];

module.exports = [...new Set([...webOrigins, ...extensionOrigins])];
