/**
 * Optional QZ Tray request signing. DISABLED by default.
 *
 * Disabled (anonymous): QZ Tray shows an "Untrusted website" Allow/Block prompt.
 * That is fine for this test page; click "Allow".
 *
 * Enabled: requests are signed so QZ Tray can trust this site and stop prompting
 * (once the certificate is trusted by QZ Tray, see README "Optional: signing").
 *   - The PUBLIC certificate goes in `certificate` (inline PEM) or is served from `certificateUrl`.
 *   - The PRIVATE key must never be in the browser. `signatureUrl` points at a backend
 *     endpoint you run. It is called as
 *       GET <signatureUrl>?request=<url-encoded string to sign>
 *     and must return the base64 RSA signature of that string (SHA512 by default) as plain text.
 *
 * Nothing else needs to change: js/qz-client.js reads this file before connecting.
 */
window.signingConfig = {
  enabled: false,

  /** Inline PEM text ("-----BEGIN CERTIFICATE-----..."). Takes precedence over certificateUrl. */
  certificate: '',

  /** URL that returns the PEM certificate as text, e.g. 'certs/digital-certificate.txt'. */
  certificateUrl: '',

  /** Your signing endpoint, e.g. 'https://pos.example.com/qz/sign'. */
  signatureUrl: '',

  /** Must match the hash your endpoint signs with: 'SHA512' (recommended), 'SHA256' or 'SHA1'. */
  algorithm: 'SHA512',
};
