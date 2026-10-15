/**
 * UI for the Test Print page: QZ Tray connection, printer selection,
 * receipt preview, printing and the log panel.
 */
(function () {
'use strict';
const signingConfig = window.signingConfig;

const qzClient = window.QzClient;
const {
  CASH_DRAWER_KICK,
  DEFAULT_MERCHANT_NAME,
  RECEIPT_LINE_WIDTH,
  buildOrderReceiptBytes,
  buildTestReceiptPayload,
  decodeEscPos,
  rowPadding,
} = window.Receipt;

const STORAGE_KEYS = {
  printer: 'web-browser-printer.printer',
  merchant: 'web-browser-printer.merchant',
  forceRaw: 'web-browser-printer.forceRaw',
};

/** Printer names that look like receipt printers get preselected. */
const RECEIPT_PRINTER_PATTERN = /pos|receipt|thermal|tm-|epson|star|xprinter|rongta|80mm|58mm/i;

const MERCHANT_DEFAULTS = Object.freeze({
  merchantName: DEFAULT_MERCHANT_NAME,
  merchantAddress: '',
  merchantPhone: '',
  merchantEmail: '',
});

const MAX_LOG_ENTRIES = 200;

const $ = (id) => document.getElementById(id);
const els = {
  pill: $('status-pill'),
  statusText: $('status-text'),
  connect: $('connect-btn'),
  disconnect: $('disconnect-btn'),
  help: $('connect-help'),
  securityMode: $('security-mode'),
  select: $('printer-select'),
  refresh: $('refresh-btn'),
  forceRaw: $('force-raw'),
  print: $('print-btn'),
  drawer: $('drawer-btn'),
  form: $('merchant-form'),
  resetMerchant: $('reset-merchant'),
  paper: $('paper'),
  previewMeta: $('preview-meta'),
  log: $('log'),
  clearLog: $('clear-log'),
};

const state = {
  busy: false,
  securityMode: 'anonymous',
  printers: [],
};

// ---------------------------------------------------------------------------
// Storage (per-browser conveniences; the page works without it)
// ---------------------------------------------------------------------------

function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, blocked site data): ignore.
  }
}

// ---------------------------------------------------------------------------
// Log panel
// ---------------------------------------------------------------------------

function errorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function log(message, level = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const item = document.createElement('li');
  item.className = `log-entry log-${level}`;
  const stamp = document.createElement('time');
  stamp.textContent = time;
  const text = document.createElement('span');
  text.textContent = message;
  item.append(stamp, text);
  els.log.append(item);
  while (els.log.children.length > MAX_LOG_ENTRIES) {
    els.log.firstElementChild.remove();
  }
  els.log.scrollTop = els.log.scrollHeight;

  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[consoleMethod](`[${time}] ${message}`);
}

// ---------------------------------------------------------------------------
// Status + buttons
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
  els.pill.dataset.state = kind;
  els.statusText.textContent = text;
  updateControls();
}

function updateControls() {
  const connected = qzClient.isConnected();
  els.connect.disabled = state.busy || connected;
  els.disconnect.disabled = state.busy || !connected;
  els.refresh.disabled = state.busy || !connected;
  els.select.disabled = !connected || state.printers.length === 0;
  const canPrint = connected && !state.busy && Boolean(els.select.value);
  els.print.disabled = !canPrint;
  els.drawer.disabled = !canPrint;
}

function setPrinterPlaceholder(text) {
  state.printers = [];
  const option = new Option(text, '');
  els.select.replaceChildren(option);
  updateControls();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connect() {
  if (!qzClient.isLibraryLoaded()) {
    setStatus('disconnected', 'Disconnected');
    els.help.hidden = false;
    log('qz-tray.js failed to load; check that vendor/qz-tray-2.3.0/qz-tray.js is being served.', 'error');
    return;
  }
  if (qzClient.isConnected() || state.busy) return;

  state.busy = true;
  els.help.hidden = true;
  setStatus('connecting', 'Connecting…');
  log(state.securityMode === 'anonymous'
    ? 'Connecting to QZ Tray… (if QZ Tray asks whether to trust this site, click Allow)'
    : 'Connecting to QZ Tray with signed requests…');

  try {
    const version = await qzClient.connect();
    setStatus('connected', `Connected · QZ Tray ${version}`);
    log(`Connected to QZ Tray ${version}.`, 'ok');
  } catch (err) {
    const message = errorMessage(err);
    setStatus('disconnected', 'Disconnected');
    els.help.hidden = false;
    log(`Could not connect to QZ Tray: ${message}`, 'error');
    if (/block/i.test(message)) {
      log('QZ Tray blocked this site. Reconnect and choose Allow. If you ticked "Remember", remove the block in QZ Tray > Advanced > Site Manager.', 'warn');
    }
    return;
  } finally {
    state.busy = false;
    updateControls();
  }

  await refreshPrinters();
}

async function disconnect() {
  if (!qzClient.isConnected() || state.busy) return;
  state.busy = true;
  updateControls();
  log('Disconnecting from QZ Tray…');
  try {
    await qzClient.disconnect();
  } catch (err) {
    log(`Disconnect failed: ${errorMessage(err)}`, 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}

function handleConnectionClosed(event) {
  const code = event && typeof event.code === 'number' ? ` (code ${event.code})` : '';
  setStatus('disconnected', 'Disconnected');
  setPrinterPlaceholder('Connect to load printers');
  log(`Connection to QZ Tray closed${code}.`, event && event.code === 1000 ? 'info' : 'warn');
}

function handleConnectionError(event) {
  log(`QZ Tray connection error: ${errorMessage(event && (event.message || event.type))}`, 'error');
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

function choosePrinter(printers, saved, systemDefault) {
  if (saved && printers.includes(saved)) return saved;
  const receiptPrinter = printers.find((name) => RECEIPT_PRINTER_PATTERN.test(name));
  if (receiptPrinter) return receiptPrinter;
  if (systemDefault && printers.includes(systemDefault)) return systemDefault;
  return printers[0] || '';
}

async function refreshPrinters() {
  if (!qzClient.isConnected() || state.busy) return;
  state.busy = true;
  updateControls();
  try {
    const printers = await qzClient.listPrinters();
    const systemDefault = await qzClient.getDefaultPrinter();

    if (printers.length === 0) {
      setPrinterPlaceholder('No printers found');
      log('QZ Tray did not report any printers.', 'warn');
      return;
    }

    state.printers = printers;
    const selected = choosePrinter(printers, loadSetting(STORAGE_KEYS.printer, ''), systemDefault);
    const options = printers.map((name) => {
      const label = name === systemDefault ? `${name} (system default)` : name;
      return new Option(label, name, false, name === selected);
    });
    els.select.replaceChildren(...options);
    saveSetting(STORAGE_KEYS.printer, selected);

    log(`Found ${printers.length} printer${printers.length === 1 ? '' : 's'}: ${printers.join(', ')}.`);
    log(`Selected printer: ${selected}`);
  } catch (err) {
    log(`Could not list printers: ${errorMessage(err)}`, 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}

// ---------------------------------------------------------------------------
// Receipt preview
// ---------------------------------------------------------------------------

function readMerchant() {
  const data = new FormData(els.form);
  return {
    merchantName: String(data.get('merchantName') ?? ''),
    merchantAddress: String(data.get('merchantAddress') ?? ''),
    merchantPhone: String(data.get('merchantPhone') ?? ''),
    merchantEmail: String(data.get('merchantEmail') ?? ''),
  };
}

function writeMerchant(merchant) {
  const values = { ...MERCHANT_DEFAULTS, ...(merchant && typeof merchant === 'object' ? merchant : {}) };
  for (const key of Object.keys(MERCHANT_DEFAULTS)) {
    const input = els.form.elements.namedItem(key);
    if (input) input.value = typeof values[key] === 'string' ? values[key] : '';
  }
}

/** Build the receipt bytes for "now" and render the preview from those same bytes. */
function buildReceipt() {
  const payload = buildTestReceiptPayload(readMerchant(), new Date());
  const bytes = buildOrderReceiptBytes(payload);
  renderPreview(bytes);
  return bytes;
}

function renderPreview(bytes) {
  const { rows, warnings } = decodeEscPos(bytes);

  // The encoder sends a line feed after the cut; it belongs to the next receipt.
  const lastCut = rows.map((row) => row.type).lastIndexOf('cut');
  const visibleRows = lastCut >= 0 ? rows.slice(0, lastCut + 1) : rows;

  const fragment = document.createDocumentFragment();
  for (const row of visibleRows) {
    if (row.type === 'cut') {
      const cut = document.createElement('div');
      cut.className = 'paper-cut';
      cut.textContent = 'cut';
      fragment.append(cut);
      continue;
    }
    if (row.type !== 'line') continue;

    const line = document.createElement('div');
    line.className = 'paper-line';
    const padding = rowPadding(row);
    if (padding) line.append(' '.repeat(padding));
    for (const segment of row.segments) {
      if (segment.bold) {
        const bold = document.createElement('b');
        bold.textContent = segment.text;
        line.append(bold);
      } else {
        line.append(segment.text);
      }
    }
    fragment.append(line);
  }
  els.paper.replaceChildren(fragment);
  els.previewMeta.textContent = `${RECEIPT_LINE_WIDTH} columns · ${bytes.length} bytes`;

  for (const warning of warnings) {
    log(`Preview decoder: ${warning}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

async function sendToPrinter(bytes, jobName, description) {
  const printer = els.select.value;
  if (!printer || !qzClient.isConnected()) return;

  const forceRaw = els.forceRaw.checked;
  state.busy = true;
  updateControls();
  log(`${description} → "${printer}" (${bytes.length} bytes${forceRaw ? ', force raw' : ''})…`);
  try {
    await qzClient.printRaw(printer, bytes, { forceRaw, jobName });
    log(`${description}: sent to "${printer}".`, 'ok');
  } catch (err) {
    log(`${description} failed: ${errorMessage(err)}`, 'error');
  } finally {
    state.busy = false;
    updateControls();
  }
}

function printTestReceipt() {
  const bytes = buildReceipt(); // re-render so the preview shows exactly this job
  return sendToPrinter(bytes, 'Atom test receipt', 'Test receipt');
}

function openCashDrawer() {
  return sendToPrinter(CASH_DRAWER_KICK, 'Open cash drawer', 'Cash drawer kick');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function init() {
  // Settings
  writeMerchant(loadSetting(STORAGE_KEYS.merchant, MERCHANT_DEFAULTS));
  // forceRaw is not supported by QZ Tray on Windows; default it on elsewhere.
  els.forceRaw.checked = loadSetting(STORAGE_KEYS.forceRaw, !/Windows/i.test(navigator.userAgent));

  // Preview
  buildReceipt();
  setInterval(buildReceipt, 30_000); // keep the date line current

  // Events
  els.connect.addEventListener('click', connect);
  els.disconnect.addEventListener('click', disconnect);
  els.refresh.addEventListener('click', refreshPrinters);
  els.print.addEventListener('click', printTestReceipt);
  els.drawer.addEventListener('click', openCashDrawer);
  els.select.addEventListener('change', () => {
    saveSetting(STORAGE_KEYS.printer, els.select.value);
    log(`Selected printer: ${els.select.value}`);
    updateControls();
  });
  els.forceRaw.addEventListener('change', () => saveSetting(STORAGE_KEYS.forceRaw, els.forceRaw.checked));
  const onMerchantInput = debounce(() => {
    saveSetting(STORAGE_KEYS.merchant, readMerchant());
    buildReceipt();
  }, 120);
  els.form.addEventListener('input', onMerchantInput);
  els.form.addEventListener('submit', (event) => event.preventDefault());
  els.resetMerchant.addEventListener('click', () => {
    writeMerchant(MERCHANT_DEFAULTS);
    saveSetting(STORAGE_KEYS.merchant, MERCHANT_DEFAULTS);
    buildReceipt();
  });
  els.clearLog.addEventListener('click', () => els.log.replaceChildren());

  // QZ Tray
  if (!qzClient.isLibraryLoaded()) {
    els.securityMode.textContent = '';
    connect(); // reports the load failure
    return;
  }
  try {
    state.securityMode = qzClient.configureSecurity(signingConfig, (message) => log(message, 'warn'));
  } catch (err) {
    log(`Could not configure QZ Tray security: ${errorMessage(err)}`, 'error');
  }
  els.securityMode.textContent = state.securityMode === 'signed'
    ? `Requests are signed (${signingConfig.algorithm || 'SHA512'}). See js/signing.js.`
    : 'Unsigned requests: QZ Tray will ask you to Allow this site. Optional signing: js/signing.js.';
  qzClient.onConnectionEvents({ onClosed: handleConnectionClosed, onError: handleConnectionError });

  updateControls();
  connect();
}

init();

})();
