/**
 * @fileoverview Office Preview sidecar HTTP server entry point.
 *
 * Routes:
 * - GET  /                 Single-page frontend app
 * - GET  /app.js           Frontend controller script
 * - GET  /styles.css       Stylesheet
 * - GET  /api/env          Host capabilities (LibreOffice / Python / platform) and shared state
 * - GET  /api/state        Lightweight polling endpoint for MCP open targets and recent files
 * - POST /api/files        Scan workspace roots for Office/PDF documents
 * - POST /api/open         Open and parse a document (PDF conversion on demand + comments/notes/sheets)
 * - GET  /api/page-image   Serve rendered HD or thumbnail PNG bytes for a page
 * - GET  /api/pdf          Serve converted or source PDF bytes for embedded viewer fallback
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  getEnvironmentInfo,
  listOfficeFiles,
  openDocument,
  readRenderedPdfBuffer,
  readSharedState,
  renderPagePng,
} from './engine.mjs';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const IMMUTABLE_CACHE_HEADERS = { 'Cache-Control': 'private, max-age=3600' };

async function readAsset(relPath) {
  return fs.readFile(join(PANEL_DIR, relPath), 'utf8');
}

function jsonResp(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    contentType: 'application/json; charset=utf-8',
    headers: NO_STORE_HEADERS,
  });
}

function safeJson(handler) {
  return async (data) => {
    try {
      const result = await handler(data || {});
      return jsonResp(result, 200);
    } catch (err) {
      return jsonResp({ ok: false, error: err?.message || 'Internal Server Error' }, 500);
    }
  };
}

const app = new SidecarApp();

// ---------------------------------------------------------------------------
// Frontend static assets
// ---------------------------------------------------------------------------

app.page(
  '/',
  async () =>
    new Response(await readAsset('index.html'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/app.js',
  async () =>
    new Response(await readAsset('app.js'), {
      contentType: 'application/javascript; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/styles.css',
  async () =>
    new Response(await readAsset('styles.css'), {
      contentType: 'text/css; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.api(
  '/api/env',
  safeJson(async () => {
    const [env, state] = await Promise.all([getEnvironmentInfo(), readSharedState()]);
    return { ok: true, env, state };
  }),
  'GET'
);

app.api(
  '/api/state',
  safeJson(async () => {
    const state = await readSharedState();
    return { ok: true, state };
  }),
  'GET'
);

app.api(
  '/api/files',
  safeJson(async (data) => {
    const roots = Array.isArray(data.roots) ? data.roots : [];
    const fallbackRoots = roots.length > 0 ? roots : [process.cwd()];
    const listing = await listOfficeFiles(fallbackRoots, {
      query: data.query || '',
      kind: data.kind || 'all',
      limit: Number(data.limit) || 250,
    });
    const state = await readSharedState();
    return { ok: true, ...listing, recentFiles: state.recentFiles };
  }),
  'POST'
);

app.api(
  '/api/open',
  safeJson(async (data) => {
    const filePath = String(data.path || '').trim();
    if (!filePath) {
      throw new Error('Please provide a file path to preview.');
    }
    const meta = await openDocument(filePath, {
      force: Boolean(data.force),
      needPdf: Boolean(data.needPdf),
    });
    return meta;
  }),
  'POST'
);

app.api(
  '/api/page-image',
  async (data) => {
    try {
      const docId = String(data?.id || '').trim();
      const page = Number(data?.page || 1);
      const quality = String(data?.q || 'hd').trim();
      const pngBuffer = await renderPagePng(docId, page, quality);
      return new Response(pngBuffer, {
        status: 200,
        contentType: 'image/png',
        headers: IMMUTABLE_CACHE_HEADERS,
      });
    } catch (err) {
      return jsonResp({ ok: false, error: err?.message || 'Failed to render page image.' }, 500);
    }
  },
  'GET'
);

app.api(
  '/api/pdf',
  async (data) => {
    try {
      const docId = String(data?.id || '').trim();
      const pdfBuffer = await readRenderedPdfBuffer(docId);
      return new Response(pdfBuffer, {
        status: 200,
        contentType: 'application/pdf',
        headers: {
          ...IMMUTABLE_CACHE_HEADERS,
          'Content-Disposition': 'inline; filename="preview.pdf"',
        },
      });
    } catch (err) {
      return jsonResp({ ok: false, error: err?.message || 'Unable to read PDF.' }, 404);
    }
  },
  'GET'
);

app.run();
