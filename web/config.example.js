/*
 * Copy to config.js and fill in. config.js is git-ignored.
 *
 * Both values come from `pass`:
 *   pass show projets/presence-cours/apps-script-url
 *   pass show projets/presence-cours/kiosk-token
 *
 * The token reaches the tablet's browser, so anyone reading this page's source
 * can read it. It keeps the deployment from being stumbled upon; it is not
 * authentication. See README.md.
 *
 * Without config.js the kiosk runs on built-in demo data.
 */
window.KIOSK_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/XXXXXXXX/exec',
  token: 'XXXXXXXX'
};
