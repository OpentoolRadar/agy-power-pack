/**
 * @fileoverview Core Office Preview engine (zero external npm dependencies; Linux/macOS/Windows).
 *
 * Responsibilities:
 * - Scan workspaces for Office/PDF files (skipping lock files and build/dependency directories)
 * - Fingerprint cache by (absolute path + mtime + file size) so edits auto-invalidate
 * - Convert Office docs to high-fidelity PDF via LibreOffice (or Windows Office COM fallback)
 * - Invoke sibling `inspector.py` to extract comments, speaker notes, revisions, sheets, and PNG pages
 * - Maintain shared state between the sidecar UI and MCP server for chat-driven navigation
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const INSPECTOR_PATH = path.join(PANEL_DIR, 'inspector.py');
const IS_WIN = process.platform === 'win32';

export const SUPPORTED_EXTENSIONS = new Map([
  ['.pptx', 'pptx'],
  ['.ppt', 'pptx'],
  ['.odp', 'pptx'],
  ['.docx', 'docx'],
  ['.doc', 'docx'],
  ['.odt', 'docx'],
  ['.rtf', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.xls', 'xlsx'],
  ['.ods', 'xlsx'],
  ['.csv', 'csv'],
  ['.tsv', 'csv'],
  ['.pdf', 'pdf'],
]);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.preview-cache',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
]);

export function getPluginDataDir() {
  const fromEnv = String(process.env.OFFICE_PREVIEW_PLUGIN_DATA || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'office-preview');
}

export function getCacheRoot() {
  return path.join(getPluginDataDir(), 'cache');
}

export function getStateFilePath() {
  return path.join(getPluginDataDir(), 'state.json');
}

export function uriToFsPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return fileURLToPath(s);
    } catch {
      // Fallback for non-standard file:// URIs
      let decoded = decodeURIComponent(s.replace(/^file:\/\//i, ''));
      if (IS_WIN && /^\/[A-Za-z]:/.test(decoded)) {
        decoded = decoded.slice(1);
      }
      return path.resolve(decoded);
    }
  }
  return path.resolve(s);
}

function execFileAsync(cmd, args, { timeout = 60000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout,
        cwd,
        env,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim().slice(0, 600);
          reject(new Error(`${path.basename(cmd)} failed: ${detail}`));
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Host tool detection (Python / LibreOffice)
// ---------------------------------------------------------------------------

let cachedPythonCmd = null;
let cachedSofficeCmd = undefined;

async function canRun(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args, { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

export async function findPythonCmd() {
  if (cachedPythonCmd) return cachedPythonCmd;
  const candidates = IS_WIN
    ? ['python', 'python3', 'py']
    : ['python3', '/usr/bin/python3', 'python'];
  for (const cmd of candidates) {
    const testArgs = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    if (await canRun(cmd, testArgs)) {
      cachedPythonCmd = cmd;
      return cmd;
    }
  }
  throw new Error('No working Python 3 interpreter found; cannot parse Office documents.');
}

export async function findSofficeCmd() {
  if (cachedSofficeCmd !== undefined) return cachedSofficeCmd;
  const candidates = IS_WIN
    ? [
        'soffice.exe',
        'soffice',
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      ]
    : [
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        'soffice',
        'libreoffice',
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      ];
  for (const cmd of candidates) {
    if (cmd.includes(path.sep) && !existsSync(cmd)) continue;
    if (await canRun(cmd, ['--version'])) {
      cachedSofficeCmd = cmd;
      return cmd;
    }
  }
  cachedSofficeCmd = null;
  return null;
}

export async function getEnvironmentInfo() {
  const [pythonCmd, sofficeCmd] = await Promise.all([
    findPythonCmd().catch(() => null),
    findSofficeCmd().catch(() => null),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    python: pythonCmd,
    libreOffice: sofficeCmd,
    windowsOfficeComFallback: IS_WIN && !sofficeCmd,
    cacheRoot: getCacheRoot(),
  };
}

// ---------------------------------------------------------------------------
// Shared state (MCP <-> Sidecar sync and recent files list)
// ---------------------------------------------------------------------------

export async function readSharedState() {
  const statePath = getStateFilePath();
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      target: parsed?.target || null,
      recentFiles: Array.isArray(parsed?.recentFiles) ? parsed.recentFiles : [],
    };
  } catch {
    return { target: null, recentFiles: [] };
  }
}

async function writeSharedState(state) {
  const statePath = getStateFilePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath);
}

export async function setTargetDocument({ filePath, page = null, tab = null, source = 'mcp' }) {
  const absPath = uriToFsPath(filePath);
  if (!absPath || !existsSync(absPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const st = await fs.stat(absPath);
  if (!st.isFile()) {
    throw new Error(`Target path is not a file: ${absPath}`);
  }
  const cur = await readSharedState();
  const nextSeq = Number(cur.target?.seq || 0) + 1;
  const recent = [absPath, ...cur.recentFiles.filter((p) => p !== absPath)].slice(0, 20);
  const nextState = {
    target: {
      seq: nextSeq,
      filePath: absPath,
      page: page ? Math.max(1, Number(page)) : null,
      tab: tab || null,
      source,
      updatedAt: new Date().toISOString(),
    },
    recentFiles: recent,
  };
  await writeSharedState(nextState);
  return nextState.target;
}

export async function recordRecentFile(filePath) {
  const absPath = uriToFsPath(filePath);
  if (!absPath) return;
  const cur = await readSharedState();
  const recent = [absPath, ...cur.recentFiles.filter((p) => p !== absPath)].slice(0, 20);
  await writeSharedState({ ...cur, recentFiles: recent });
}

// ---------------------------------------------------------------------------
// Workspace file scanner
// ---------------------------------------------------------------------------

export async function listOfficeFiles(rawRoots = [], { query = '', kind = 'all', maxDepth = 5, limit = 250 } = {}) {
  const roots = [];
  const seenRoots = new Set();
  for (const r of Array.isArray(rawRoots) ? rawRoots : [rawRoots]) {
    const resolved = uriToFsPath(r);
    if (resolved && !seenRoots.has(resolved) && existsSync(resolved)) {
      seenRoots.add(resolved);
      roots.push(resolved);
    }
  }

  const results = [];
  const qLower = String(query || '').trim().toLowerCase();
  const wantKind = String(kind || 'all').trim().toLowerCase();

  async function walk(dir, rootDir, depth) {
    if (depth > maxDepth || results.length >= limit * 2) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (!name) continue;
      if (ent.isDirectory()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        await walk(path.join(dir, name), rootDir, depth + 1);
      } else if (ent.isFile()) {
        // Skip temporary Office lock files (~$document.docx, .~lock.*)
        if (name.startsWith('~$') || name.startsWith('.~lock.')) continue;
        const ext = path.extname(name).toLowerCase();
        const fileKind = SUPPORTED_EXTENSIONS.get(ext);
        if (!fileKind) continue;
        if (wantKind !== 'all' && fileKind !== wantKind) continue;
        const fullPath = path.join(dir, name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        if (qLower && !relPath.toLowerCase().includes(qLower) && !name.toLowerCase().includes(qLower)) {
          continue;
        }
        try {
          const st = await fs.stat(fullPath);
          results.push({
            path: fullPath,
            name,
            relPath,
            rootName: path.basename(rootDir),
            ext,
            kind: fileKind,
            size: st.size,
            mtimeMs: st.mtimeMs,
            mtimeIso: new Date(st.mtimeMs).toISOString(),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  for (const rootDir of roots) {
    await walk(rootDir, rootDir, 0);
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    roots,
    total: results.length,
    files: results.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Document-to-PDF conversion (LibreOffice + Windows Office COM fallback)
// ---------------------------------------------------------------------------

async function convertViaLibreOffice(inputPath, outDir) {
  const soffice = await findSofficeCmd();
  if (!soffice) return null;

  await fs.mkdir(outDir, { recursive: true });
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-lo-profile-'));
  const profileUri = pathToFileURL(profileDir).href;

  try {
    await execFileAsync(
      soffice,
      [
        `-env:UserInstallation=${profileUri}`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ],
      { timeout: 90000 }
    );
    const stem = path.basename(inputPath, path.extname(inputPath));
    const expectedPdf = path.join(outDir, `${stem}.pdf`);
    if (existsSync(expectedPdf)) {
      return expectedPdf;
    }
    const files = await fs.readdir(outDir);
    const anyPdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
    return anyPdf ? path.join(outDir, anyPdf) : null;
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertViaWindowsOfficeCom(inputPath, outPdfPath) {
  if (!IS_WIN) return null;
  const ext = path.extname(inputPath).toLowerCase();
  let psScript = '';

  if (['.docx', '.doc', '.rtf', '.odt'].includes(ext)) {
    psScript = `
      $word = New-Object -ComObject Word.Application
      $word.Visible = $false
      $word.DisplayAlerts = 0
      try {
        $doc = $word.Documents.Open($env:OFFICE_PREVIEW_INPUT, $false, $true)
        $doc.ExportAsFixedFormat($env:OFFICE_PREVIEW_OUTPUT, 17)
        $doc.Close($false)
      } finally {
        $word.Quit()
      }
    `;
  } else if (['.pptx', '.ppt', '.odp'].includes(ext)) {
    psScript = `
      $ppt = New-Object -ComObject PowerPoint.Application
      try {
        $pres = $ppt.Presentations.Open($env:OFFICE_PREVIEW_INPUT, -1, 0, 0)
        $pres.SaveAs($env:OFFICE_PREVIEW_OUTPUT, 32)
        $pres.Close()
      } finally {
        $ppt.Quit()
      }
    `;
  } else if (['.xlsx', '.xls', '.ods'].includes(ext)) {
    psScript = `
      $xl = New-Object -ComObject Excel.Application
      $xl.Visible = $false
      $xl.DisplayAlerts = $false
      try {
        $wb = $xl.Workbooks.Open($env:OFFICE_PREVIEW_INPUT, 0, $true)
        $wb.ExportAsFixedFormat(0, $env:OFFICE_PREVIEW_OUTPUT)
        $wb.Close($false)
      } finally {
        $xl.Quit()
      }
    `;
  } else {
    return null;
  }

  await fs.mkdir(path.dirname(outPdfPath), { recursive: true });
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    {
      timeout: 90000,
      env: {
        ...process.env,
        OFFICE_PREVIEW_INPUT: inputPath,
        OFFICE_PREVIEW_OUTPUT: outPdfPath,
      },
    }
  );
  return existsSync(outPdfPath) ? outPdfPath : null;
}

async function runInspector(args, timeout = 45000) {
  const py = await findPythonCmd();
  const fullArgs = py === 'py' ? ['-3', INSPECTOR_PATH, ...args] : [INSPECTOR_PATH, ...args];
  const { stdout } = await execFileAsync(py, fullArgs, { timeout });
  const parsed = JSON.parse(stdout);
  if (!parsed || parsed.ok === false) {
    throw new Error(parsed?.error || 'Document inspection failed.');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Document open pipeline & cache lifecycle
// ---------------------------------------------------------------------------

const docRegistry = new Map(); // docId -> { filePath, cacheDir, pdfPath, ext, kind, mtimeMs, size }
const inFlightOpen = new Map();
const inFlightPage = new Map();

export function computeDocId(absPath, mtimeMs, size) {
  return createHash('sha256')
    .update(`${absPath}|${Math.floor(mtimeMs)}|${size}`)
    .digest('hex')
    .slice(0, 16);
}

async function pruneOldCaches(maxKeep = 25) {
  try {
    const cacheRoot = getCacheRoot();
    if (!existsSync(cacheRoot)) return;
    const dirs = await fs.readdir(cacheRoot, { withFileTypes: true });
    const entries = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const full = path.join(cacheRoot, d.name);
      try {
        const st = await fs.stat(full);
        entries.push({ full, mtimeMs: st.mtimeMs });
      } catch {
        // Ignore stat failures during pruning
      }
    }
    if (entries.length <= maxKeep) return;
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(maxKeep)) {
      await fs.rm(stale.full, { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Cache pruning is best-effort
  }
}

/**
 * Open and parse a document.
 * - PPTX/DOCX auto-convert to PDF for high-fidelity page rendering;
 * - XLSX/CSV open immediately in the native spreadsheet table unless `needPdf: true`.
 */
export async function openDocument(rawPath, { force = false, needPdf = false } = {}) {
  const absPath = uriToFsPath(rawPath);
  if (!absPath || !existsSync(absPath)) {
    throw new Error(`File not found: ${rawPath}`);
  }
  const st = await fs.stat(absPath);
  if (!st.isFile()) {
    throw new Error(`Target path is not a file: ${absPath}`);
  }
  const ext = path.extname(absPath).toLowerCase();
  const kind = SUPPORTED_EXTENSIONS.get(ext);
  if (!kind) {
    throw new Error(`Unsupported file format: ${ext || '(no extension)'}`);
  }

  const docId = computeDocId(absPath, st.mtimeMs, st.size);
  const cacheDir = path.join(getCacheRoot(), docId);
  const metaPath = path.join(cacheDir, 'meta.json');
  const cachedPdfPath = path.join(cacheDir, 'rendered.pdf');
  const shouldConvertPdf =
    ext !== '.pdf' &&
    ext !== '.csv' &&
    ext !== '.tsv' &&
    (kind === 'pptx' || kind === 'docx' || needPdf);

  const lockKey = `${docId}:${shouldConvertPdf ? 'pdf' : 'fast'}:${force ? 'force' : 'cached'}`;
  if (inFlightOpen.has(lockKey)) {
    return inFlightOpen.get(lockKey);
  }

  const task = (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    if (force) {
      await fs.rm(metaPath, { force: true }).catch(() => {});
      await fs.rm(path.join(cacheDir, 'pages'), { recursive: true, force: true }).catch(() => {});
      if (shouldConvertPdf) {
        await fs.rm(cachedPdfPath, { force: true }).catch(() => {});
      }
    }

    let pdfPath = ext === '.pdf' ? absPath : (existsSync(cachedPdfPath) ? cachedPdfPath : '');
    let convertWarning = '';

    // Return cached metadata directly on hit
    if (!force && existsSync(metaPath)) {
      try {
        const cachedMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        const pdfReady = !shouldConvertPdf || Boolean(pdfPath && existsSync(pdfPath));
        if (pdfReady && cachedMeta?.docId === docId) {
          docRegistry.set(docId, {
            filePath: absPath,
            cacheDir,
            pdfPath,
            ext,
            kind,
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
          await recordRecentFile(absPath).catch(() => {});
          return cachedMeta;
        }
      } catch {
        // Rebuild on corrupted cache
      }
    }

    // Convert to PDF on demand
    if (shouldConvertPdf && !pdfPath) {
      try {
        const converted = await convertViaLibreOffice(absPath, cacheDir);
        if (converted && existsSync(converted)) {
          if (path.resolve(converted) !== path.resolve(cachedPdfPath)) {
            await fs.rename(converted, cachedPdfPath);
          }
          pdfPath = cachedPdfPath;
        } else if (IS_WIN) {
          const comPdf = await convertViaWindowsOfficeCom(absPath, cachedPdfPath);
          if (comPdf && existsSync(comPdf)) {
            pdfPath = comPdf;
          } else {
            convertWarning = 'Neither LibreOffice nor local Microsoft Office was detected; showing extracted comments and document structure only.';
          }
        } else if (kind === 'xlsx') {
          convertWarning = 'LibreOffice Calc is not installed on this host; print-layout PDF is unavailable. Use the interactive table view for sheets and cell comments.';
        } else {
          convertWarning = 'LibreOffice Writer/Impress was not detected on this host; page images are unavailable, but comments, notes, and structure were extracted.';
        }
      } catch (err) {
        convertWarning = `PDF conversion failed (comments and notes were still extracted): ${err.message}`;
      }
    }

    const inspectArgs = ['inspect', absPath];
    if (pdfPath) {
      inspectArgs.push('--pdf', pdfPath);
    }
    const inspected = await runInspector(inspectArgs);

    const meta = {
      ...inspected,
      docId,
      filePath: absPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      mtimeIso: new Date(st.mtimeMs).toISOString(),
      hasPdf: Boolean(pdfPath && existsSync(pdfPath)),
      canRenderPages: Boolean(pdfPath && existsSync(pdfPath) && inspected.capabilities?.hasFitz),
      warning: convertWarning,
      cachedAt: new Date().toISOString(),
    };

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    docRegistry.set(docId, {
      filePath: absPath,
      cacheDir,
      pdfPath,
      ext,
      kind,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
    await recordRecentFile(absPath).catch(() => {});
    void pruneOldCaches(25);
    return meta;
  })();

  inFlightOpen.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlightOpen.delete(lockKey);
  }
}

export async function resolveDocEntry(docId) {
  const safeId = String(docId || '').replace(/[^a-f0-9]/gi, '');
  if (!safeId) throw new Error('Invalid document ID.');
  if (docRegistry.has(safeId)) {
    return docRegistry.get(safeId);
  }
  const cacheDir = path.join(getCacheRoot(), safeId);
  const metaPath = path.join(cacheDir, 'meta.json');
  if (!existsSync(metaPath)) {
    throw new Error('Document cache expired; please reopen the file.');
  }
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const cachedPdfPath = path.join(cacheDir, 'rendered.pdf');
  const pdfPath = meta.ext === '.pdf' ? meta.filePath : (existsSync(cachedPdfPath) ? cachedPdfPath : '');
  const entry = {
    filePath: meta.filePath,
    cacheDir,
    pdfPath,
    ext: meta.ext,
    kind: meta.kind,
    mtimeMs: meta.mtimeMs,
    size: meta.size,
  };
  docRegistry.set(safeId, entry);
  return entry;
}

export async function renderPagePng(docId, pageNum, quality = 'hd') {
  const entry = await resolveDocEntry(docId);
  if (!entry.pdfPath || !existsSync(entry.pdfPath)) {
    throw new Error('No rendered PDF source is available for this document.');
  }
  const page = Math.max(1, parseInt(pageNum, 10) || 1);
  const q = quality === 'thumb' ? 'thumb' : (quality === 'uhd' ? 'uhd' : 'hd');
  const scaleMap = { thumb: 0.45, hd: 1.85, uhd: 2.6 };
  const scale = scaleMap[q];

  const pagesDir = path.join(entry.cacheDir, 'pages');
  const pngPath = path.join(pagesDir, `p${page}_${q}.png`);
  if (existsSync(pngPath)) {
    return fs.readFile(pngPath);
  }

  const key = `${docId}:${page}:${q}`;
  if (inFlightPage.has(key)) {
    return inFlightPage.get(key);
  }

  const task = (async () => {
    await fs.mkdir(pagesDir, { recursive: true });
    await runInspector(['render', entry.pdfPath, String(page), pngPath, '--scale', String(scale)], 30000);
    return fs.readFile(pngPath);
  })();

  inFlightPage.set(key, task);
  try {
    return await task;
  } finally {
    inFlightPage.delete(key);
  }
}

export async function readRenderedPdfBuffer(docId) {
  const entry = await resolveDocEntry(docId);
  if (!entry.pdfPath || !existsSync(entry.pdfPath)) {
    throw new Error('No PDF has been generated for this document yet.');
  }
  return fs.readFile(entry.pdfPath);
}
