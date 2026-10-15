# web-browser-printer

A standalone "Test Print" page that prints the Atom mPOS test receipt to an ESC/POS
thermal receipt printer from the browser, through [QZ Tray](https://qz.io).
Plain HTML + vanilla JS (classic scripts, no ES modules). No build step, and the libraries are vendored, so it works offline.

## Run it

Just open `index.html` in a browser (double-click it). There is no server or build step: the app uses classic
`<script>` tags, not ES modules, so it works from `file://`. Serving it over http also works.

With `file://` the page origin is `null`; QZ Tray may ask you to Allow on each connection, and signing
(below) may not work.

## Install QZ Tray (once)

The 2.3.0 installer is already in `~/Downloads`:

```sh
sudo installer -pkg ~/Downloads/qz-tray-2.3.0-arm64.pkg -target /
open -a "QZ Tray"
```

QZ Tray runs in the menu bar and listens on `ws://localhost:8182` (and `wss://localhost:8181` for https pages).
The page connects automatically on load. If QZ Tray isn't running yet, start it and click **Connect**.

### The "Allow" prompt

This page doesn't sign its requests by default, so QZ Tray treats it as an untrusted (anonymous) site
and asks whether to **Allow** or **Block** it. Click **Allow**. Without a trusted certificate,
QZ Tray can't remember an Allow, so expect the prompt again when you reconnect.
To make it silent, set up signing (see below).

If you click Block and tick "Remember this decision", undo it in **QZ Tray > Advanced > Site Manager**.

## Using the page

| Control | What it does |
| --- | --- |
| Status pill | Disconnected / Connecting / Connected, plus the QZ Tray version (`qz.api.getVersion()`). |
| Connect / Disconnect | Opens or closes the QZ Tray websocket. |
| Printer + Refresh | Lists every printer QZ Tray can see (`qz.printers.find()`). It preselects your last choice, then any name matching `/pos\|receipt\|thermal\|tm-\|epson\|star\|xprinter\|rongta\|80mm\|58mm/i`, then the system default. The choice is saved in `localStorage`. |
| Force raw | Sends the job with QZ's `forceRaw: true`, which bypasses the printer driver. On by default (except on Windows, where QZ doesn't support it). |
| Print test receipt | Builds the mPOS test receipt and sends it as raw ESC/POS (`{type:'raw', format:'command', flavor:'base64'}`). |
| Open cash drawer | Sends `ESC p 0 25 250` (`1B 70 00 19 FA`). |
| Receipt header | Merchant name, address, phone and email for the header. Leave optional fields empty to omit them, as mPOS does. Values are saved in `localStorage`. |
| Preview | A 44-column rendering of exactly what is printed (see below). |
| Log | Timestamped connection, printer and print messages. |

### This Mac's POS80 queue

The CUPS queue `STMicroelectronics_POS80_Printer_USB` is set up with the **"Generic PostScript Printer"** driver.
If raw ESC/POS goes through that driver, it can come out as garbage or not at all, so keep **Force raw** on.
If printing still fails, recreate the queue as a raw queue (no driver) in System Settings > Printers & Scanners,
or with `lpadmin`. The device URI is `usb://STMicroelectronics/POS80%20Printer%20USB?serial=Printer`.

## Receipt format

`js/receipt.js` is a straight port of atom-mpos `src/printers/receiptBuilder.ts` (`buildOrderReceiptBytes` and
`buildTestReceiptBytes`). It uses the same encoder build, the same options
(`{ columns: 44, feedBeforeCut: 5, imageMode: 'raster' }`), the same helpers (`sanitize`, `truncate`,
`createAlignedLine`, `formatCurrency`) and the same call sequence. The output was checked byte-for-byte against
the mPOS source in Node and is identical. The one part not ported is the logo header, which the test receipt doesn't use.

The preview isn't a separate layout. It is produced by **decoding the exact ESC/POS bytes** that are sent
to the printer (`decodeEscPos`), so preview and print can't drift apart.

### Two layout quirks inherited from mPOS

The preview shows these on purpose, because that's what the printer receives:

1. **The merchant name prints left-aligned.** encoder 3.x adds the centering spaces for the first line in front
   of the `ESC @` initialize command. `ESC @` clears the printer's line buffer, so those spaces are dropped.
   The other centered lines are fine.
2. **The `@ $0.00` unit-price line prints left-aligned.** `createAlignedLine('', '@ $0.00')` produces leading
   spaces, and the encoder's word-wrapper drops leading whitespace at the start of a line.

To fix them, change mPOS first, then port the change here.

## Optional: signing (stops the prompts)

Signing is configured in `js/signing.js` and is **disabled by default**. When it's enabled, `js/qz-client.js` calls
`qz.security.setCertificatePromise`, `qz.security.setSignatureAlgorithm('SHA512')` and
`qz.security.setSignaturePromise` before connecting. When it's disabled, the certificate and signature both resolve
empty (anonymous).

1. **Get a certificate and private key.** For development, use **QZ Tray > Advanced > Site Manager > + > Create New**
   and answer Yes to the prompts. This writes `digital-certificate.txt` and `private-key.pem` to a
   "QZ Tray Demo Cert" folder on the Desktop, and adds the certificate to QZ Tray's `override.crt` so that
   QZ Tray trusts it on this machine. For production, use a certificate issued by QZ.
2. **Serve the public certificate.** Paste its PEM into `certificate`, or put the file in this folder and set
   `certificateUrl` (for example `'digital-certificate.txt'`).
3. **Run a signing endpoint.** The private key must stay on a server, never in the page. `signatureUrl` is
   called as `GET <signatureUrl>?request=<url-encoded string>` and must return the base64 RSA-SHA512 signature
   of that string as plain text. With CORS, if it's on another origin. In Node:

   ```js
   const crypto = require('crypto');
   // request = the decoded ?request= query parameter
   const signature = crypto.createSign('SHA512').update(request).sign(privateKeyPem, 'base64');
   ```

   QZ has examples in other languages: <https://qz.io/docs/signing>.
4. Set `enabled: true` and reload. The page notes "Requests are signed (SHA512)". After the first approval,
   QZ Tray lets you "Allow" and "Remember this decision".

If signing is enabled but misconfigured, the page logs a warning and falls back to anonymous.

## Files

```
index.html                 page markup; loads vendor/qz-tray, the encoder, then js/*.js as classic scripts (order matters)
css/styles.css             all styles (light/dark, responsive)
js/app.js                  UI: connection, printer list, preview, print buttons, log
js/receipt.js              receipt line building (mPOS port), ESC/POS encoding, byte decoder for the preview
js/qz-client.js            QZ Tray wrappers: security setup, connect, list printers, raw print
js/signing.js              optional signing config (disabled)
vendor/                    third-party libraries (see below)
```

## Vendored libraries

| Library | Version | File | Source | sha256 | License |
| --- | --- | --- | --- | --- | --- |
| qz-tray (QZ Tray JS API) | 2.3.0 | `vendor/qz-tray-2.3.0/qz-tray.js` | `https://cdn.jsdelivr.net/npm/qz-tray@2.3.0/qz-tray.js` (same as the npm tarball, integrity checked) | `2516fe196e7b7db0ae10a6c90f6210f08d8bc52a65d203d70795637d2c4340be` | LGPL-2.1-only (file header) |
| @point-of-sale/receipt-printer-encoder | 3.0.3 | `vendor/receipt-printer-encoder-3.0.3/receipt-printer-encoder.esm.js` (+ `.map`, `LICENSE`); `receipt-printer-encoder.js` is the same code wrapped as a classic script (`export` replaced by `window.ReceiptPrinterEncoder`) | `https://cdn.jsdelivr.net/npm/@point-of-sale/receipt-printer-encoder@3.0.3/dist/receipt-printer-encoder.esm.js` | `7402ce3b105f071a476ba6f284622e762c8c537447d0e7ecf5ea79b89af979f4` | MIT |

Notes:

- The encoder is pinned to **3.0.3** because that's what atom-mpos has installed (its `package-lock.json`
  resolves `^3.0.0` to 3.0.3). The file is the package's self-contained browser ESM build, byte-identical to
  `atom-mpos/node_modules/@point-of-sale/receipt-printer-encoder/dist/receipt-printer-encoder.esm.js`.
  4.x exists, but output may differ, so don't upgrade it unless mPOS does.
- qz-tray.js 2.3.0 has an upstream oddity: its internal `qz.version` constant says `2.2.6`. The page shows the
  version reported by the running QZ Tray app (`qz.api.getVersion()`) instead.

## Troubleshooting

- **"Unable to establish connection with QZ Tray"**: QZ Tray isn't running or isn't installed. Start it with `open -a "QZ Tray"`.
- **Nothing in the printer list**: click Refresh, and check that the printer appears in System Settings > Printers & Scanners.
- **Job sent but nothing prints, or garbage prints**: turn on Force raw, and check the job in the CUPS queue (`lpstat -o`).
- **The browser console** shows the same messages as the Log panel.
