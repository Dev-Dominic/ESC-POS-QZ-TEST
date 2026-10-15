/**
 * Thin wrappers around the QZ Tray JS API.
 *
 * `window.qz` comes from vendor/qz-tray-2.3.0/qz-tray.js, loaded as a classic
 * <script> before the app module. QZ Tray itself listens on wss://localhost:8181
 * (https pages) or ws://localhost:8182 (http pages); qz-tray.js picks the right one.
 */
(function () {
'use strict';

const { bytesToBase64 } = window.Receipt;

function api() {
  const qz = globalThis.qz;
  if (!qz) {
    throw new Error('qz-tray.js did not load (expected vendor/qz-tray-2.3.0/qz-tray.js).');
  }
  return qz;
}

function isLibraryLoaded() {
  return typeof globalThis.qz !== 'undefined';
}

/**
 * Install certificate/signature handlers. Call once, before the first connect.
 * Returns 'signed' or 'anonymous'.
 *
 * @param {object} config  see js/signing.js
 * @param {(message: string) => void} [onWarning]
 */
function configureSecurity(config, onWarning = () => {}) {
  const qz = api();
  const wantsSigning = Boolean(config && config.enabled);
  const hasCertificate = Boolean(config && (config.certificate || config.certificateUrl));
  const hasSigner = Boolean(config && config.signatureUrl);

  if (wantsSigning && !(hasCertificate && hasSigner)) {
    onWarning('Signing is enabled in js/signing.js but certificate/certificateUrl or signatureUrl is missing. Continuing anonymously.');
  }

  if (!wantsSigning || !hasCertificate || !hasSigner) {
    // Anonymous: no certificate and empty signatures. QZ Tray shows an Allow/Block prompt.
    qz.security.setCertificatePromise((resolve) => resolve());
    qz.security.setSignaturePromise(() => (resolve) => resolve());
    return 'anonymous';
  }

  qz.security.setCertificatePromise((resolve, reject) => {
    if (config.certificate) {
      resolve(config.certificate);
      return;
    }
    fetch(config.certificateUrl, { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(resolve)
      .catch((err) => {
        // QZ falls back to an anonymous connection when the certificate promise rejects.
        onWarning(`Could not load the signing certificate from ${config.certificateUrl} (${err.message}). Continuing anonymously.`);
        reject(err);
      });
  });

  qz.security.setSignatureAlgorithm(config.algorithm || 'SHA512');

  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    const separator = config.signatureUrl.includes('?') ? '&' : '?';
    fetch(`${config.signatureUrl}${separator}request=${encodeURIComponent(toSign)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`Signing endpoint returned HTTP ${res.status}`))))
      .then((signature) => resolve(signature.trim()))
      .catch(reject);
  });

  return 'signed';
}

/** Register connection lifecycle callbacks (replaces any previous ones). */
function onConnectionEvents({ onClosed, onError } = {}) {
  const qz = api();
  if (onClosed) qz.websocket.setClosedCallbacks(onClosed);
  if (onError) qz.websocket.setErrorCallbacks(onError);
}

function isConnected() {
  return isLibraryLoaded() && globalThis.qz.websocket.isActive();
}

/** Connect (no-op if already connected). Resolves with the QZ Tray version string. */
async function connect() {
  const qz = api();
  if (!qz.websocket.isActive()) {
    await qz.websocket.connect({ retries: 0, delay: 0 });
  }
  return qz.api.getVersion();
}

async function disconnect() {
  const qz = api();
  if (qz.websocket.isActive()) {
    await qz.websocket.disconnect();
  }
}

/** All printer names QZ Tray can see. */
async function listPrinters() {
  const result = await api().printers.find();
  return Array.isArray(result) ? result : [result].filter(Boolean);
}

async function getDefaultPrinter() {
  try {
    return (await api().printers.getDefault()) || null;
  } catch {
    return null;
  }
}

/**
 * Send raw ESC/POS bytes to a printer.
 *
 * @param {string} printerName
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {boolean} [options.forceRaw]  Bypass the OS driver (on macOS/Linux QZ hands the job to CUPS as raw).
 *                                      Needed when the CUPS queue has a non-raw driver such as "Generic PostScript Printer".
 * @param {string} [options.jobName]
 */
function printRaw(printerName, bytes, { forceRaw = false, jobName = 'Test print' } = {}) {
  const qz = api();
  const config = qz.configs.create(printerName, { forceRaw, jobName });
  const data = [{ type: 'raw', format: 'command', flavor: 'base64', data: bytesToBase64(bytes) }];
  return qz.print(config, data);
}

  window.QzClient = { isLibraryLoaded, configureSecurity, onConnectionEvents, isConnected, connect, disconnect, listPrinters, getDefaultPrinter, printRaw };
})();
