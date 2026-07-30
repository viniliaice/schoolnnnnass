/**
 * Print any DOM node as a PDF using the browser's native "Save as PDF" dialog.
 *
 * The node's HTML is cloned into a hidden same-origin iframe together with every
 * stylesheet currently applied to the document, so the printed output looks
 * exactly like what the user sees on screen (this is the "PDF export of the HTML").
 */
export function printElementAsPdf(element: HTMLElement | null, documentTitle: string): boolean {
  if (!element) return false;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    document.body.removeChild(iframe);
    return false;
  }

  // Copy every <style> and stylesheet <link> from the host document.
  const headStyles = Array.from(
    document.querySelectorAll('style, link[rel="stylesheet"]')
  )
    .map((n) => n.outerHTML)
    .join('\n');

  doc.open();
  doc.write(`<!doctype html>
<html data-mode="light" style="color-scheme: light !important;">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(documentTitle)}</title>
    ${headStyles}
    <style>
      @page { size: A4 landscape; margin: 12mm; }
      html { color-scheme: light !important; }
      html, body {
        background: #ffffff !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      body { padding: 0; margin: 0; color: #0f172a !important; }
      .print-root { padding: 0; }
      table { page-break-inside: auto; }
      tr, .avoid-break { page-break-inside: avoid; break-inside: avoid; }
      thead { display: table-header-group; }
      .no-print { display: none !important; }
      input, textarea, select {
        border: 0 !important;
        background: transparent !important;
        padding: 0 !important;
        color: #0f172a !important;
      }
    </style>
  </head>
  <body><div class="print-root">${element.innerHTML}</div></body>
</html>`);
  doc.close();

  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 500);
  };

  const run = () => {
    try {
      win.focus();
      win.print();
    } finally {
      cleanup();
    }
  };

  // Give the cloned stylesheets a tick to apply before printing.
  if (doc.readyState === 'complete') {
    setTimeout(run, 250);
  } else {
    iframe.onload = () => setTimeout(run, 250);
  }
  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
