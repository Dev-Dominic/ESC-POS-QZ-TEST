/**
 * Receipt line building + ESC/POS encoding.
 *
 * The builder below is a straight port of atom-mpos `src/printers/receiptBuilder.ts`
 * (buildOrderReceiptBytes / buildTestReceiptBytes). It uses the same encoder
 * (@point-of-sale/receipt-printer-encoder 3.0.3, vendored, byte-identical to the
 * copy in atom-mpos/node_modules), the same options and the same call sequence, so
 * the bytes sent to the printer match what the mobile POS sends.
 * Keep it in sync with mPOS if the receipt layout there changes.
 *
 * Not ported: the logo header (`receiptHeaderType: 'logo'`), which needs image
 * decoding. The test receipt in mPOS never uses it.
 *
 * The on-screen preview is produced by decoding the exact bytes that are printed
 * (see decodeEscPos), so preview and print cannot drift apart.
 */
(function () {
'use strict';

const ReceiptPrinterEncoder = window.ReceiptPrinterEncoder;

const RECEIPT_LINE_WIDTH = 44;
const RECEIPT_DIVIDER = '-'.repeat(RECEIPT_LINE_WIDTH);
const ENCODER_OPTIONS = Object.freeze({ columns: 44, feedBeforeCut: 5, imageMode: 'raster' });

/** ESC p 0 25 250: pulse drawer kick pin 2 for 50 ms on / 500 ms off. */
const CASH_DRAWER_KICK = Uint8Array.of(0x1b, 0x70, 0x00, 0x19, 0xfa);

const DEFAULT_MERCHANT_NAME = 'Printer Test';

// ---------------------------------------------------------------------------
// Helpers (same semantics as mPOS)
// ---------------------------------------------------------------------------

function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

/** Replace anything outside printable ASCII (0x20-0x7E) with a space, collapse whitespace, trim. */
function sanitize(value) {
  return String(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function createAlignedLine(left, right, width = RECEIPT_LINE_WIDTH) {
  if (!right) return left;
  const availableLeft = Math.max(0, width - right.length - 1);
  const trimmedLeft = truncate(left, availableLeft);
  const gap = Math.max(1, width - trimmedLeft.length - right.length);
  return `${trimmedLeft}${' '.repeat(gap)}${right}`;
}

/** e.g. "10/14/2026, 01:43 PM" (newer ICU emits U+202F before AM/PM; sanitize() turns it into a space). */
function formatReceiptDate(date) {
  return date.toLocaleString('en-US', {
    hour12: true,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Receipt sections (ported from mPOS receiptBuilder.ts)
// ---------------------------------------------------------------------------

function appendMerchantHeader(encoder, payload) {
  encoder.align('center');
  encoder.bold(true).line(sanitize(payload.merchantName)).bold(false);

  if (payload.merchantAddress) {
    encoder.line(sanitize(payload.merchantAddress));
  }
  if (payload.merchantPhone) {
    encoder.line(sanitize(payload.merchantPhone));
  }
  if (payload.merchantEmail) {
    encoder.line(sanitize(payload.merchantEmail));
  }

  encoder.line(RECEIPT_DIVIDER);
  encoder.align('left');
}

function appendOrderMetadata(encoder, payload) {
  const createdAtLabel = formatReceiptDate(payload.createdAt);

  encoder.line(createAlignedLine('Receipt #', sanitize(payload.displayId)));
  encoder.line(createAlignedLine('Order ID', String(payload.orderId)));
  encoder.line(createAlignedLine('Date', sanitize(createdAtLabel)));

  if (payload.registerName) {
    encoder.line(createAlignedLine('Register', sanitize(payload.registerName)));
  } else if (payload.registerId != null) {
    encoder.line(createAlignedLine('Register', String(payload.registerId)));
  }

  if (payload.customerName) {
    encoder.line(createAlignedLine('Customer', sanitize(payload.customerName)));
  }

  encoder.line(createAlignedLine('Tender', sanitize(payload.paymentMethodLabel)));
  encoder.line(createAlignedLine('Currency', sanitize(payload.currency ?? 'JMD')));
  if (typeof payload.totalItems === 'number') {
    encoder.line(createAlignedLine('Items', String(payload.totalItems)));
  }
  encoder.line(RECEIPT_DIVIDER);
}

function appendItems(encoder, payload) {
  encoder.line(createAlignedLine('Item', 'Total'));

  payload.items.forEach((item) => {
    const quantityPrefix = `${item.quantity} x `;
    const lineTotal = formatCurrency(item.quantity * item.unitPrice);
    const itemName = truncate(
      sanitize(`${quantityPrefix}${item.name}`),
      Math.max(8, RECEIPT_LINE_WIDTH - lineTotal.length - 1)
    );

    encoder.line(createAlignedLine(itemName, lineTotal));

    const unitPriceLabel = `@ ${formatCurrency(item.unitPrice)}`;
    encoder.line(createAlignedLine('', unitPriceLabel));

    if (item.sku) {
      encoder.line(createAlignedLine('', `SKU: ${sanitize(item.sku)}`));
    }
  });

  encoder.line(RECEIPT_DIVIDER);
}

function appendTotals(encoder, payload) {
  encoder.line(createAlignedLine('Subtotal', formatCurrency(payload.subtotal)));
  if (payload.discount && payload.discount > 0) {
    encoder.line(createAlignedLine('Discount', `-${formatCurrency(payload.discount)}`));
  }
  if (payload.taxLines && payload.taxLines.length > 0) {
    payload.taxLines.forEach((line) => {
      const rateLabel = `${(line.rate * 100).toFixed(2)}%`;
      encoder.line(
        createAlignedLine(`Tax ${sanitize(line.name)} (${rateLabel})`, formatCurrency(line.amount))
      );
    });
  }
  encoder.line(createAlignedLine('Tax', formatCurrency(payload.tax)));
  encoder.bold(true).line(createAlignedLine('Total', formatCurrency(payload.total))).bold(false);

  if (payload.payments && payload.payments.length > 1) {
    payload.payments.forEach((tender) => {
      encoder.line(createAlignedLine(`Paid - ${sanitize(tender.name)}`, formatCurrency(tender.amount)));
    });
  }

  if (typeof payload.amountGiven === 'number') {
    encoder.line(createAlignedLine('Amount Given', formatCurrency(payload.amountGiven)));
  }

  if (typeof payload.change === 'number') {
    encoder.line(createAlignedLine('Change', formatCurrency(payload.change)));
  }

  encoder.line(RECEIPT_DIVIDER);
}

function appendFooter(encoder) {
  encoder
    .align('center')
    .line('Thank you for your purchase')
    .line('Please come again')
    .align('left');
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/** Same as mPOS buildOrderReceiptBytes (minus the logo header), synchronous. */
function buildOrderReceiptBytes(payload) {
  const encoder = new ReceiptPrinterEncoder({ ...ENCODER_OPTIONS });
  encoder.initialize();

  appendMerchantHeader(encoder, payload);
  appendOrderMetadata(encoder, payload);
  appendItems(encoder, payload);
  appendTotals(encoder, payload);
  appendFooter(encoder);

  encoder.cut();
  return encoder.encode();
}

function optional(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
}

/**
 * The mPOS test receipt payload (buildTestReceiptBytes), with the merchant
 * header fields taken from the page's form. Empty fields are omitted, as in mPOS.
 */
function buildTestReceiptPayload(merchant = {}, createdAt = new Date()) {
  return {
    merchantName: optional(merchant.merchantName) ?? DEFAULT_MERCHANT_NAME,
    merchantAddress: optional(merchant.merchantAddress),
    merchantPhone: optional(merchant.merchantPhone),
    merchantEmail: optional(merchant.merchantEmail),
    orderId: 0,
    displayId: 'TEST-RECEIPT',
    paymentMethodLabel: 'Test',
    createdAt,
    items: [
      {
        name: 'Sample Item',
        quantity: 1,
        unitPrice: 0,
      },
    ],
    totalItems: 1,
    subtotal: 0,
    tax: 0,
    total: 0,
  };
}

function buildTestReceiptBytes(merchant, createdAt) {
  return buildOrderReceiptBytes(buildTestReceiptPayload(merchant, createdAt));
}

// ---------------------------------------------------------------------------
// Byte utilities
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Decode an ESC/POS byte stream into the rows a printer would print, for the preview.
 * Handles the commands the encoder emits (plus a few common ones). Unknown commands
 * are skipped and reported in `warnings`.
 *
 * Returns { rows, warnings } where each row is
 *   { type: 'line', segments: [{ text, bold }], align }  or  { type: 'cut' } or { type: 'drawer' }.
 */
function decodeEscPos(bytes) {
  const rows = [];
  const warnings = [];
  let segments = [];
  let bold = false;
  let align = 'left';

  const hex = (b) => `0x${(b ?? 0).toString(16).padStart(2, '0')}`;
  const pushChar = (ch) => {
    const last = segments[segments.length - 1];
    if (last && last.bold === bold) {
      last.text += ch;
    } else {
      segments.push({ text: ch, bold });
    }
  };
  const endLine = () => {
    rows.push({ type: 'line', segments, align });
    segments = [];
  };
  const alignFrom = (n) => ['left', 'center', 'right'][n >= 0x30 ? n - 0x30 : n] ?? 'left';

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];

    if (b === 0x0a) { endLine(); continue; } // LF: print buffer and feed
    if (b === 0x0d) continue; // CR: no-op on ESC/POS printers with auto line feed off

    if (b === 0x1b) { // ESC
      const cmd = bytes[i + 1];
      const arg = bytes[i + 2];
      switch (cmd) {
        case 0x40: // ESC @  initialize: clears the print buffer, resets modes
          segments = []; bold = false; align = 'left'; i += 1; break;
        case 0x45: // ESC E n  emphasized
        case 0x47: // ESC G n  double-strike (looks bold)
          bold = (arg & 1) === 1; i += 2; break;
        case 0x21: // ESC ! n  print mode (bit 3 = emphasized)
          bold = (arg & 0x08) !== 0; i += 2; break;
        case 0x61: // ESC a n  justification
          align = alignFrom(arg); i += 2; break;
        case 0x64: // ESC d n  print and feed n lines
          endLine();
          for (let k = 1; k < arg; k++) rows.push({ type: 'line', segments: [], align });
          i += 2; break;
        case 0x4a: // ESC J n  print and feed n dots
          if (segments.length) endLine();
          i += 2; break;
        case 0x2d: // ESC - n  underline
        case 0x4d: // ESC M n  font
        case 0x74: // ESC t n  code table
        case 0x52: // ESC R n  international charset
        case 0x20: // ESC SP n right-side character spacing
        case 0x33: // ESC 3 n  line spacing
        case 0x7b: // ESC { n  upside-down
        case 0x56: // ESC V n  90 degree rotation
          i += 2; break;
        case 0x32: // ESC 2  default line spacing
          i += 1; break;
        case 0x70: // ESC p m t1 t2  drawer kick
          rows.push({ type: 'drawer' }); i += 4; break;
        default:
          warnings.push(`Unknown command ESC ${hex(cmd)} at byte ${i}`); i += 1;
      }
      continue;
    }

    if (b === 0x1d) { // GS
      const cmd = bytes[i + 1];
      const arg = bytes[i + 2];
      switch (cmd) {
        case 0x56: // GS V m [n]  cut (m = 65/66 take an extra feed argument)
          if (segments.length) endLine();
          rows.push({ type: 'cut' });
          i += arg === 0x41 || arg === 0x42 ? 3 : 2;
          break;
        case 0x21: // GS ! n  character size
        case 0x42: // GS B n  reverse
          i += 2; break;
        default:
          warnings.push(`Unknown command GS ${hex(cmd)} at byte ${i}`); i += 1;
      }
      continue;
    }

    if (b === 0x1c) { // FS
      const cmd = bytes[i + 1];
      if (cmd === 0x2e || cmd === 0x26) { i += 1; continue; } // FS . / FS &  Kanji mode off/on
      warnings.push(`Unknown command FS ${hex(cmd)} at byte ${i}`); i += 1;
      continue;
    }

    if (b >= 0x20 && b <= 0x7e) {
      pushChar(String.fromCharCode(b));
    } else if (b >= 0x80) {
      pushChar('?'); // code-page character; the builder only emits ASCII
    }
    // Other control bytes are ignored.
  }

  if (segments.length) {
    warnings.push('Data after the last line feed is never printed');
  }

  return { rows, warnings };
}

/**
 * Spaces to prepend for printer-side alignment (ESC a). The encoder pads lines
 * itself, so this is normally 0.
 */
function rowPadding(row, columns = RECEIPT_LINE_WIDTH) {
  const length = row.segments.reduce((sum, s) => sum + s.text.length, 0);
  if (row.align === 'left' || length >= columns) return 0;
  return row.align === 'center' ? (columns - length) >> 1 : columns - length;
}

/** Plain text of a decoded row, as it lands on paper. */
function rowText(row, columns = RECEIPT_LINE_WIDTH) {
  return ' '.repeat(rowPadding(row, columns)) + row.segments.map((s) => s.text).join('');
}

  window.Receipt = { RECEIPT_LINE_WIDTH, RECEIPT_DIVIDER, ENCODER_OPTIONS, CASH_DRAWER_KICK, DEFAULT_MERCHANT_NAME, formatCurrency, sanitize, truncate, createAlignedLine, formatReceiptDate, buildOrderReceiptBytes, buildTestReceiptPayload, buildTestReceiptBytes, bytesToBase64, decodeEscPos, rowPadding, rowText };
})();
