#!/usr/bin/env node
/**
 * @fileoverview Zero-dependency MCP stdio server for Office Preview.
 *
 * Exposes 3 lightweight tools linking chat agents with the sidecar viewer:
 * 1. office_preview_open    - Push an Office/PDF document into the sidecar preview pane
 * 2. office_preview_inspect - Extract structure, threaded comments, anchor quotes, speaker notes, and revisions
 * 3. office_preview_list    - List all Office/PDF files under a target directory
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOfficeFiles, openDocument, setTargetDocument } from './engine.mjs';

const PANEL_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_MANIFEST_PATH = join(dirname(dirname(PANEL_DIR)), 'plugin.json');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

function readVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (parsed?.version) return String(parsed.version);
    }
  } catch {
    // Ignore manifest read failure and fall back to default version
  }
  return '1.0.0';
}

const TOOL_DEFS = [
  {
    name: 'office_preview_open',
    description:
      'Open a PPTX/DOCX/XLSX/CSV/PDF file in the Office Preview sidecar panel, optionally jumping to a specific page and inspector tab (comments/notes/outline/revisions). Include the sidecar pill link [Office Preview](sidecar://office-preview/panel/) in your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the target Office or PDF file.',
        },
        page: {
          type: 'integer',
          description: 'Optional 1-based page or slide number to navigate to on open.',
        },
        tab: {
          type: 'string',
          enum: ['comments', 'notes', 'outline', 'revisions'],
          description: 'Optional right-hand inspector tab to open automatically.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'office_preview_inspect',
    description:
      'Inspect a PPTX/DOCX/XLSX/CSV/PDF file and return page count, outline, threaded comments (with authors, anchor quotes, and resolved state), PowerPoint speaker notes, Word footnotes/endnotes, and tracked changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the target document.',
        },
        needPdf: {
          type: 'boolean',
          description: 'Optional flag to force PDF conversion (e.g., to map Word comments to exact page numbers; enabled automatically for DOCX/PPTX).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'office_preview_list',
    description: 'List PowerPoint, Word, Excel, CSV, and PDF files under a directory sorted by descending modification time.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Absolute directory path to scan (defaults to current working directory).',
        },
        query: {
          type: 'string',
          description: 'Optional filename or relative path keyword filter.',
        },
        kind: {
          type: 'string',
          enum: ['all', 'pptx', 'docx', 'xlsx', 'csv', 'pdf'],
          description: 'Optional document type filter.',
        },
      },
    },
  },
];

async function runTool(name, args = {}) {
  if (name === 'office_preview_open') {
    const target = await setTargetDocument({
      filePath: args.path,
      page: args.page || null,
      tab: args.tab || null,
      source: 'mcp',
    });
    // Warm metadata cache so the sidecar panel opens immediately
    const meta = await openDocument(target.filePath, { needPdf: false });
    const summary = {
      ok: true,
      target,
      fileName: meta.fileName,
      kind: meta.kind,
      pageCount: meta.pageCount,
      commentsCount: (meta.comments || []).length,
      notesCount: (meta.notes || []).length,
      revisionsCount: (meta.revisions || []).length,
      sheetsCount: (meta.sheets || []).length,
      sidecarPill: '[Office Preview](sidecar://office-preview/panel/)',
    };
    return {
      content: [
        {
          type: 'text',
          text:
            `Loaded into Office Preview: ${meta.fileName} (${meta.pageCount} pages, ${summary.commentsCount} comments, ${summary.notesCount} notes/footnotes).\n` +
            `Include this sidecar link so the user can jump straight to the panel: ${summary.sidecarPill}\n\n` +
            JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  if (name === 'office_preview_inspect') {
    const meta = await openDocument(args.path, { needPdf: Boolean(args.needPdf) });
    const compact = {
      fileName: meta.fileName,
      filePath: meta.filePath,
      kind: meta.kind,
      title: meta.title,
      author: meta.author,
      pageCount: meta.pageCount,
      outline: (meta.outline || []).slice(0, 80),
      comments: meta.comments || [],
      notes: meta.notes || [],
      revisions: (meta.revisions || []).slice(0, 100),
      sheets: (meta.sheets || []).map((s) => ({
        name: s.name,
        rowCount: s.rowCount,
        colCount: s.colCount,
        commentsCount: Object.keys(s.comments || {}).length,
      })),
      warning: meta.warning || '',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }],
    };
  }

  if (name === 'office_preview_list') {
    const root = args.root || process.cwd();
    const res = await listOfficeFiles([root], {
      query: args.query || '',
      kind: args.kind || 'all',
      limit: 100,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

const serverVersion = readVersion();

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) return null;

  const id = msg.id;
  const method = String(msg.method || '');

  try {
    if (method === 'initialize') {
      const requested = String(msg.params?.protocolVersion || '').trim();
      const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
        ? requested
        : DEFAULT_MCP_VERSION;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'office-preview-viewer', version: serverVersion },
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS } };
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };

    if (method === 'tools/call') {
      const toolName = String(msg.params?.name || '');
      const toolArgs = msg.params?.arguments || {};
      const result = await runTool(toolName, toolArgs);
      return { jsonrpc: '2.0', id, result };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (err) {
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: err?.message || String(err) }],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err?.message || String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Stdio JSON-RPC transport (supports both newline-delimited JSON and LSP Content-Length frames)
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

function writeMessage(obj) {
  if (!obj) return;
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function drainBuffer() {
  while (buffer.length > 0) {
    // Skip leading whitespace
    let start = 0;
    while (start < buffer.length && (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0d || buffer[start] === 0x0a)) {
      start += 1;
    }
    if (start > 0) {
      buffer = buffer.subarray(start);
    }
    if (buffer.length === 0) break;

    const headStr = buffer.subarray(0, Math.min(32, buffer.length)).toString('ascii');
    if (headStr.toLowerCase().startsWith('content-length:')) {
      const sepIdx = buffer.indexOf('\r\n\r\n');
      if (sepIdx === -1) break;
      const header = buffer.subarray(0, sepIdx).toString('ascii');
      const m = header.match(/content-length:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.subarray(sepIdx + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const total = sepIdx + 4 + len;
      if (buffer.length < total) break;
      const body = buffer.subarray(sepIdx + 4, total).toString('utf8');
      buffer = buffer.subarray(total);
      processRawJson(body);
    } else {
      const nlIdx = buffer.indexOf(0x0a);
      if (nlIdx === -1) break;
      const line = buffer.subarray(0, nlIdx).toString('utf8').trim();
      buffer = buffer.subarray(nlIdx + 1);
      if (line) processRawJson(line);
    }
  }
}

function processRawJson(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  Promise.resolve(handleMessage(msg))
    .then((resp) => {
      if (resp) writeMessage(resp);
    })
    .catch(() => {});
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});
