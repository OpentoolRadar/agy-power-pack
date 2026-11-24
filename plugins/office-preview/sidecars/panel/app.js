/**
 * @fileoverview Office Preview sidecar frontend controller (zero external dependencies).
 */

(() => {
  const state = {
    env: null,
    workspaceUris: [],
    files: [],
    recentFiles: [],
    fileQuery: '',
    fileKind: 'all', // all | pptx | docx | xlsx | pdf
    manualPath: '',
    loadingFiles: false,

    doc: null,
    loadingDoc: false,
    docError: '',
    currentPage: 1,
    viewMode: 'single', // single | scroll
    excelMode: 'table', // table | print
    activeSheetIdx: 0,
    sheetQuery: '',
    highlightCellKey: '',
    zoom: 100, // percentage; ignored while fitWidth is true
    fitWidth: true,
    showThumbs: true,
    showSpeakerDock: true,

    showFilesDrawer: true,
    showInspector: false,
    inspectorTab: 'comments', // comments | notes | revisions | outline
    commentFilter: 'all', // all | page | open
    lastTargetSeq: 0,
  };

  let statePollTimer = null;

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 2400);
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const val = n / Math.pow(1024, idx);
    return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
  }

  function formatDate(raw) {
    if (!raw) return '';
    // Support PDF date strings like D:20261122120000...
    const pdfMatch = String(raw).match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
    if (pdfMatch) {
      return `${pdfMatch[1]}-${pdfMatch[2]}-${pdfMatch[3]}${pdfMatch[4] ? ` ${pdfMatch[4]}:${pdfMatch[5] || '00'}` : ''}`;
    }
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts)) return String(raw).slice(0, 16);
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function colIndexToLetter(idx) {
    let n = idx + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function getInitials(name, fallback) {
    if (fallback && fallback.trim()) return fallback.trim().slice(0, 2).toUpperCase();
    const clean = String(name || 'R').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'pptx': return 'PPT';
      case 'docx': return 'WORD';
      case 'xlsx': return 'EXCEL';
      case 'csv': return 'CSV';
      case 'pdf': return 'PDF';
      default: return 'DOC';
    }
  }

  function toFileUri(absPath) {
    const p = String(absPath || '');
    if (p.startsWith('file://')) return p;
    if (/^[A-Za-z]:\\/.test(p)) {
      return 'file:///' + p.replace(/\\/g, '/');
    }
    return 'file://' + p;
  }

  async function apiFetch(url, options = {}) {
    const fetcher = window.sidecar?.fetch || fetch;
    const res = await fetcher(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function copyText(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast(label);
    }
  }

  function sendToChatContext({ title, text, selection }) {
    if (!state.doc) return;
    if (window.sidecar?.ui?.addArtifactComment) {
      try {
        window.sidecar.ui.addArtifactComment({
          uri: toFileUri(state.doc.filePath),
          pageTitle: title || `${state.doc.fileName} - Page ${state.currentPage}`,
          selection: selection || '',
          comment: text || '',
        });
        showToast('Attached to chat context');
        return;
      } catch {
        // Fall back to clipboard copy
      }
    }
    void copyText(
      `[${state.doc.fileName} - ${title || ''}]\n${selection ? `Quote: ${selection}\n` : ''}${text || ''}`,
      'Copied context (paste into chat)'
    );
  }

  // -------------------------------------------------------------------------
  // Data Loading
  // -------------------------------------------------------------------------

  async function loadFiles() {
    state.loadingFiles = true;
    render();
    try {
      const data = await apiFetch('/api/files', {
        method: 'POST',
        body: JSON.stringify({
          roots: state.workspaceUris,
          query: state.fileQuery,
          kind: state.fileKind,
        }),
      });
      state.files = data.files || [];
      state.recentFiles = data.recentFiles || [];
    } catch (err) {
      showToast(`Workspace scan failed: ${err.message}`);
    } finally {
      state.loadingFiles = false;
      render();
    }
  }

  async function openFile(filePath, { force = false, needPdf = false, page = null, tab = null } = {}) {
    const cleanPath = String(filePath || '').trim();
    if (!cleanPath) return;
    state.loadingDoc = true;
    state.docError = '';
    state.showFilesDrawer = false;
    render();

    try {
      const meta = await apiFetch('/api/open', {
        method: 'POST',
        body: JSON.stringify({ path: cleanPath, force, needPdf }),
      });
      state.doc = meta;
      state.manualPath = meta.filePath;
      state.currentPage = Math.min(
        Math.max(1, Number(page || 1)),
        Math.max(1, Number(meta.pageCount || 1))
      );
      state.activeSheetIdx = 0;
      state.highlightCellKey = '';
      state.sheetQuery = '';
      state.excelMode = (meta.kind === 'xlsx' || meta.kind === 'csv')
        ? (needPdf && meta.canRenderPages ? 'print' : 'table')
        : 'print';

      const commentsLen = (meta.comments || []).length;
      const notesLen = (meta.notes || []).length;
      const revisionsLen = (meta.revisions || []).length;

      if (tab && ['comments', 'notes', 'revisions', 'outline'].includes(tab)) {
        state.inspectorTab = tab;
        state.showInspector = true;
      } else if (commentsLen > 0) {
        state.inspectorTab = 'comments';
        // Auto-expand inspector on wide viewports; keep collapsed on narrow panes with badge count
        if (window.innerWidth >= 860) state.showInspector = true;
      } else if (notesLen > 0) {
        state.inspectorTab = 'notes';
      } else if (revisionsLen > 0) {
        state.inspectorTab = 'revisions';
      } else {
        state.inspectorTab = 'outline';
      }

      if (force) showToast('Re-rendered latest document');
    } catch (err) {
      state.docError = err.message || 'Failed to open document';
      showToast(state.docError);
    } finally {
      state.loadingDoc = false;
      render();
    }
  }

  async function pollSharedState() {
    try {
      const res = await apiFetch('/api/state', { method: 'GET' });
      const target = res?.state?.target;
      if (target && Number(target.seq || 0) > state.lastTargetSeq) {
        state.lastTargetSeq = Number(target.seq);
        if (target.filePath) {
          await openFile(target.filePath, {
            page: target.page,
            tab: target.tab,
          });
        }
      }
    } catch {
      // Ignore transient poll errors
    }
  }

  // -------------------------------------------------------------------------
  // Navigation & View Controls
  // -------------------------------------------------------------------------

  function goToPage(pageNum) {
    if (!state.doc) return;
    const total = Math.max(1, Number(state.doc.pageCount || 1));
    const clamped = Math.min(total, Math.max(1, Number(pageNum) || 1));
    state.currentPage = clamped;
    render();
    if (state.viewMode === 'scroll') {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-scroll-page="${clamped}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    const thumb = document.querySelector(`[data-thumb-page="${clamped}"]`);
    if (thumb) thumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  function jumpToComment(cm) {
    if (!state.doc || !cm) return;
    if ((state.doc.kind === 'xlsx' || state.doc.kind === 'csv') && state.excelMode === 'table') {
      if (typeof cm.sheetIndex === 'number') {
        state.activeSheetIdx = cm.sheetIndex;
      }
      if (cm.row !== null && cm.row !== undefined && cm.col !== null && cm.col !== undefined) {
        state.highlightCellKey = `${cm.row}:${cm.col}`;
      }
      render();
      requestAnimationFrame(() => {
        const cell = document.querySelector(`[data-cell-key="${state.highlightCellKey}"]`);
        if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      });
      return;
    }
    if (cm.page) {
      goToPage(cm.page);
    }
  }

  function setZoom(nextZoom) {
    if (nextZoom === 'fit') {
      state.fitWidth = true;
      state.zoom = 100;
    } else {
      state.fitWidth = false;
      state.zoom = Math.min(240, Math.max(40, nextZoom));
    }
    render();
  }

  // -------------------------------------------------------------------------
  // View Rendering
  // -------------------------------------------------------------------------

  function pageImageUrl(docId, page, quality = 'hd') {
    return `/api/page-image?id=${encodeURIComponent(docId)}&page=${page}&q=${quality}`;
  }

  function renderTopbar() {
    const doc = state.doc;
    const isSpreadsheet = doc && (doc.kind === 'xlsx' || doc.kind === 'csv');
    const isPageBased = doc && (!isSpreadsheet || state.excelMode === 'print');
    const commentsCount = doc ? (doc.comments || []).length : 0;
    const notesCount = doc ? (doc.notes || []).length : 0;
    const revisionsCount = doc ? (doc.revisions || []).length : 0;
    const totalAnnotations = commentsCount + notesCount + revisionsCount;

    return `
      <header class="topbar">
        <div class="topbar-left">
          <button class="btn ${state.showFilesDrawer ? 'active' : ''}" data-action="toggle-files" title="Toggle file browser">
            &#9776; Files
          </button>
          ${doc ? `
            <div class="doc-title-wrap" title="${escapeHtml(doc.filePath)}">
              <span class="kind-badge ${escapeHtml(doc.kind)}">${escapeHtml(kindLabel(doc.kind))}</span>
              <span class="doc-title">${escapeHtml(doc.fileName)}</span>
            </div>
          ` : `
            <div class="doc-title-wrap">
              <span class="doc-title">Office Preview</span>
            </div>
          `}
        </div>

        <div class="topbar-right">
          ${doc && isSpreadsheet ? `
            <button class="btn ${state.excelMode === 'table' ? 'active' : ''}" data-action="excel-mode-table">Table</button>
            <button class="btn ${state.excelMode === 'print' ? 'active' : ''}" data-action="excel-mode-print">Print Layout</button>
          ` : ''}

          ${doc && isPageBased && doc.pageCount > 0 ? `
            <div class="page-nav">
              <button class="btn xs icon-only" data-action="prev-page" ${state.currentPage <= 1 ? 'disabled' : ''} title="Previous page (Left Arrow)">&#8249;</button>
              <input class="page-input" type="number" min="1" max="${doc.pageCount}" value="${state.currentPage}" data-role="page-jump" aria-label="Page number">
              <span class="page-total">/ ${doc.pageCount}</span>
              <button class="btn xs icon-only" data-action="next-page" ${state.currentPage >= doc.pageCount ? 'disabled' : ''} title="Next page (Right Arrow)">&#8250;</button>
            </div>
          ` : ''}

          ${doc && isPageBased && doc.canRenderPages ? `
            <div class="zoom-group">
              <button class="btn xs icon-only" data-action="zoom-out" title="Zoom out (-)">&minus;</button>
              <button class="btn xs" data-action="zoom-fit" title="Fit to width (0)">${state.fitWidth ? 'Fit' : `${state.zoom}%`}</button>
              <button class="btn xs icon-only" data-action="zoom-in" title="Zoom in (+)">+</button>
            </div>
            <button class="btn" data-action="toggle-view-mode" title="Switch between single-page and continuous scroll">
              ${state.viewMode === 'single' ? 'Single' : 'Scroll'}
            </button>
          ` : ''}

          ${doc ? `
            <button class="btn ${state.showInspector ? 'active' : ''}" data-action="toggle-inspector" title="View comments, speaker notes, revisions, and outline">
              Inspector
              ${totalAnnotations > 0 ? `<span class="pill-count">${totalAnnotations}</span>` : ''}
            </button>
            <button class="btn icon-only" data-action="reload-doc" title="Force reload and re-render">&#8635;</button>
          ` : ''}
        </div>
      </header>
    `;
  }

  function renderFileDrawer() {
    if (!state.showFilesDrawer && state.doc) return '';
    const fullMode = !state.doc && !state.loadingDoc;
    const kinds = [
      { id: 'all', label: 'All' },
      { id: 'pptx', label: 'PPT' },
      { id: 'docx', label: 'Word' },
      { id: 'xlsx', label: 'Excel' },
      { id: 'pdf', label: 'PDF' },
    ];

    const recentHtml = state.recentFiles.length > 0 ? `
      <div class="file-section-label">Recent</div>
      ${state.recentFiles.slice(0, 5).map((p) => {
        const name = p.split(/[/\\]/).pop() || p;
        const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        const k = ext.includes('pp') || ext === '.odp' ? 'pptx'
          : ext.includes('doc') || ext === '.odt' || ext === '.rtf' ? 'docx'
          : ext.includes('xl') || ext === '.csv' || ext === '.tsv' || ext === '.ods' ? 'xlsx'
          : 'pdf';
        const active = state.doc?.filePath === p;
        return `
          <button class="file-item ${active ? 'active' : ''}" data-open-file="${escapeHtml(p)}">
            <span class="kind-badge ${k}">${kindLabel(k)}</span>
            <div class="file-item-body">
              <div class="file-item-name">${escapeHtml(name)}</div>
              <div class="file-item-meta">${escapeHtml(p)}</div>
            </div>
          </button>
        `;
      }).join('')}
    ` : '';

    const filesHtml = state.loadingFiles
      ? `<div class="empty-box"><div class="spinner"></div>Scanning workspace documents...</div>`
      : state.files.length === 0
        ? `<div class="empty-box">
             <div class="empty-title">No matching documents in workspace</div>
             <div>Paste an absolute path above to open any local file, or ask the agent in chat to preview a document.</div>
           </div>`
        : state.files.map((f) => {
            const active = state.doc?.filePath === f.path;
            return `
              <button class="file-item ${active ? 'active' : ''}" data-open-file="${escapeHtml(f.path)}">
                <span class="kind-badge ${escapeHtml(f.kind)}">${escapeHtml(kindLabel(f.kind))}</span>
                <div class="file-item-body">
                  <div class="file-item-name">${escapeHtml(f.name)}</div>
                  <div class="file-item-meta">${escapeHtml(f.relPath)} &middot; ${formatBytes(f.size)} &middot; ${formatDate(f.mtimeIso)}</div>
                </div>
              </button>
            `;
          }).join('');

    return `
      <aside class="file-drawer ${fullMode ? 'full-mode' : ''}">
        <div class="drawer-head">
          <div class="path-open-row">
            <input class="text-input" type="text" placeholder="Paste absolute path and press Enter (.pptx/.docx/.xlsx/.pdf)" value="${escapeHtml(state.manualPath)}" data-role="manual-path">
            <button class="btn primary" data-action="open-manual-path">Open</button>
          </div>
          <div class="path-open-row">
            <input class="text-input" type="search" placeholder="Filter workspace documents..." value="${escapeHtml(state.fileQuery)}" data-role="file-search">
            <button class="btn icon-only" data-action="refresh-files" title="Rescan workspace">&#8635;</button>
          </div>
          <div class="filter-pills">
            ${kinds.map((k) => `
              <button class="filter-pill ${state.fileKind === k.id ? 'active' : ''}" data-file-kind="${k.id}">${k.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="file-list">
          ${recentHtml}
          <div class="file-section-label">Workspace Files (${state.files.length})</div>
          ${filesHtml}
        </div>
      </aside>
    `;
  }

  function renderSpreadsheetView(doc) {
    const sheets = doc.sheets || [];
    if (sheets.length === 0) {
      return `<div class="empty-box"><div class="empty-title">No worksheet data found</div></div>`;
    }
    const idx = Math.min(state.activeSheetIdx, sheets.length - 1);
    const sheet = sheets[idx];
    const rows = sheet.rows || [];
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const q = state.sheetQuery.trim().toLowerCase();
    const commentsMap = sheet.comments || {};

    return `
      <div class="sheet-shell">
        <div class="sheet-toolbar">
          <div class="sheet-tabs">
            ${sheets.map((s, i) => {
              const cCount = Object.keys(s.comments || {}).length;
              return `
                <button class="sheet-tab ${i === idx ? 'active' : ''}" data-sheet-idx="${i}">
                  ${escapeHtml(s.name)}
                  ${cCount > 0 ? `<span class="pill-count">${cCount}</span>` : ''}
                </button>
              `;
            }).join('')}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input class="text-input" style="width:160px;height:24px;" type="search" placeholder="Filter cell text..." value="${escapeHtml(state.sheetQuery)}" data-role="sheet-search">
            <span style="font-size:11px;color:var(--text-muted);">${sheet.rowCount} rows &times; ${sheet.colCount} cols${sheet.truncated ? ' (truncated)' : ''}</span>
          </div>
        </div>
        <div class="sheet-table-wrap">
          <table class="sheet-table">
            <thead>
              <tr>
                <th style="width:36px;">#</th>
                ${Array.from({ length: maxCols }, (_, c) => `<th>${colIndexToLetter(c)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${rows.map((row, rIdx) => `
                <tr>
                  <th class="row-num">${rIdx + 1}</th>
                  ${Array.from({ length: maxCols }, (_, cIdx) => {
                    const val = row[cIdx] ?? '';
                    const key = `${rIdx}:${cIdx}`;
                    const cm = commentsMap[key];
                    const hit = q && String(val).toLowerCase().includes(q);
                    const hl = state.highlightCellKey === key;
                    const cls = [
                      cm ? 'has-comment' : '',
                      hit ? 'match-hit' : '',
                      hl ? 'cell-highlight' : '',
                    ].filter(Boolean).join(' ');
                    const titleAttr = cm ? `${cm.author}: ${cm.text}` : '';
                    return `<td class="${cls}" data-cell-key="${key}" ${cm ? `data-cell-comment-id="${escapeHtml(cm.id)}"` : ''} title="${escapeHtml(titleAttr)}">${escapeHtml(val)}</td>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderPageStage(doc) {
    const pageComments = (doc.comments || []).filter((c) => c.page === state.currentPage);
    const currentNotes = (doc.notes || []).filter((n) => n.kind === 'speaker_note' && n.page === state.currentPage);
    const widthStyle = state.fitWidth ? 'width: 100%; max-width: 980px;' : `width: ${Math.round(7.6 * state.zoom)}px;`;

    let canvasHtml = '';
    if (doc.canRenderPages && doc.pageCount > 0) {
      if (state.viewMode === 'single') {
        const pInfo = (doc.pages || []).find((p) => p.page === state.currentPage);
        canvasHtml = `
          <div class="stage-scroll">
            <div class="page-frame" style="${widthStyle}">
              <img src="${pageImageUrl(doc.docId, state.currentPage, state.zoom > 150 ? 'uhd' : 'hd')}" alt="Page ${state.currentPage}">
              <div class="page-caption">
                <span>Page ${state.currentPage} / ${doc.pageCount}${pInfo?.title ? ` &middot; ${escapeHtml(pInfo.title)}` : ''}</span>
                <button class="btn xs" data-action="cite-current-page">Cite Page to Chat</button>
              </div>
            </div>
          </div>
        `;
      } else {
        const pagesArr = Array.from({ length: doc.pageCount }, (_, i) => i + 1);
        canvasHtml = `
          <div class="stage-scroll">
            ${pagesArr.map((p) => {
              const pInfo = (doc.pages || []).find((x) => x.page === p);
              const pCmCount = (doc.comments || []).filter((c) => c.page === p).length;
              return `
                <div class="page-frame" style="${widthStyle}" data-scroll-page="${p}">
                  <img loading="lazy" src="${pageImageUrl(doc.docId, p, 'hd')}" alt="Page ${p}">
                  <div class="page-caption">
                    <span>Page ${p} / ${doc.pageCount}${pInfo?.title ? ` &middot; ${escapeHtml(pInfo.title)}` : ''}</span>
                    <span style="display:flex;gap:6px;align-items:center;">
                      ${pCmCount > 0 ? `<span class="pill-count">${pCmCount} ${pCmCount === 1 ? 'comment' : 'comments'}</span>` : ''}
                      <button class="btn xs" data-cite-page="${p}">Cite Page</button>
                    </span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    } else if (doc.hasPdf) {
      // Embedded PDF fallback when PyMuPDF is not installed
      canvasHtml = `
        <iframe class="pdf-fallback-frame" src="/api/pdf?id=${encodeURIComponent(doc.docId)}#page=${state.currentPage}"></iframe>
      `;
    } else {
      canvasHtml = `
        <div class="empty-box">
          <div class="empty-title">Page Rendering Unavailable</div>
          <div>${escapeHtml(doc.warning || 'No page renderer is available in this environment, but comments, notes, and document structure have been extracted in the Inspector drawer.')}</div>
        </div>
      `;
    }

    // Current-page comment notice banner
    const pageCommentBanner = pageComments.length > 0 ? `
      <div class="notice-banner info">
        <span>Page ${state.currentPage} has <strong>${pageComments.length}</strong> ${pageComments.length === 1 ? 'comment' : 'comments'}</span>
        <button class="btn xs" data-action="open-page-comments">View Page Comments</button>
      </div>
    ` : '';

    // Warning banner
    const warnBanner = doc.warning ? `
      <div class="notice-banner warn">
        <span>Warning: ${escapeHtml(doc.warning)}</span>
      </div>
    ` : '';

    // Speaker notes dock for current PPTX slide
    const speakerDock = (doc.kind === 'pptx' && currentNotes.length > 0) ? `
      <div class="speaker-note-dock">
        <div class="speaker-note-head">
          <span class="speaker-note-title">Speaker Notes &middot; Slide ${state.currentPage}</span>
          <div style="display:flex;gap:5px;">
            <button class="btn xs" data-action="copy-speaker-note">Copy</button>
            <button class="btn xs" data-action="cite-speaker-note">Cite to Chat</button>
            <button class="btn xs" data-action="toggle-speaker-dock">${state.showSpeakerDock ? 'Collapse' : 'Expand'}</button>
          </div>
        </div>
        ${state.showSpeakerDock ? `<div class="speaker-note-body">${escapeHtml(currentNotes.map((n) => n.text).join('\n\n'))}</div>` : ''}
      </div>
    ` : '';

    // Bottom thumbnail strip
    const thumbStrip = (doc.canRenderPages && doc.pageCount > 1 && state.showThumbs && state.viewMode === 'single') ? `
      <div class="thumb-strip">
        ${Array.from({ length: doc.pageCount }, (_, i) => {
          const p = i + 1;
          const hasCm = (doc.comments || []).some((c) => c.page === p);
          const hasNote = (doc.notes || []).some((n) => n.page === p);
          return `
            <button class="thumb-item ${p === state.currentPage ? 'active' : ''}" data-thumb-page="${p}" title="Page ${p}">
              ${(hasCm || hasNote) ? `
                <div class="thumb-badges">
                  ${hasCm ? '<span class="mini-dot comment" title="Has comments"></span>' : ''}
                  ${hasNote ? '<span class="mini-dot note" title="Has speaker notes or footnotes"></span>' : ''}
                </div>
              ` : ''}
              <img loading="lazy" src="${pageImageUrl(doc.docId, p, 'thumb')}" alt="${p}">
              <span class="thumb-label">${p}</span>
            </button>
          `;
        }).join('')}
      </div>
    ` : '';

    return `${warnBanner}${pageCommentBanner}${canvasHtml}${speakerDock}${thumbStrip}`;
  }

  function renderInspectorDrawer() {
    if (!state.doc || !state.showInspector) return '';
    const doc = state.doc;
    const comments = doc.comments || [];
    const notes = doc.notes || [];
    const revisions = doc.revisions || [];
    const outline = doc.outline || [];

    const tabs = [
      { id: 'comments', label: 'Comments', count: comments.length },
      { id: 'notes', label: doc.kind === 'pptx' ? 'Notes' : 'Footnotes', count: notes.length },
      ...(revisions.length > 0 || doc.kind === 'docx' ? [{ id: 'revisions', label: 'Changes', count: revisions.length }] : []),
      { id: 'outline', label: 'Outline', count: outline.length },
    ];

    let bodyHtml = '';

    if (state.inspectorTab === 'comments') {
      const filtered = comments.filter((c) => {
        if (state.commentFilter === 'page') return c.page === state.currentPage;
        if (state.commentFilter === 'open') return !c.resolved;
        return true;
      });
      bodyHtml = `
        <div class="inspector-subbar">
          <div class="filter-pills">
            <button class="filter-pill ${state.commentFilter === 'all' ? 'active' : ''}" data-cm-filter="all">All (${comments.length})</button>
            <button class="filter-pill ${state.commentFilter === 'page' ? 'active' : ''}" data-cm-filter="page">This Page</button>
            <button class="filter-pill ${state.commentFilter === 'open' ? 'active' : ''}" data-cm-filter="open">Open</button>
          </div>
        </div>
        <div class="inspector-list">
          ${filtered.length === 0 ? `
            <div class="empty-box">
              <div class="empty-title">No comments</div>
              <div>${state.commentFilter === 'page' ? 'No comments on this page. Switch to "All" to view the full list.' : 'This document contains no review comments.'}</div>
            </div>
          ` : filtered.map((c, idx) => {
            const isCur = c.page && c.page === state.currentPage;
            return `
              <div class="card-item ${isCur ? 'current-page' : ''} ${c.resolved ? 'resolved' : ''}" data-jump-comment="${escapeHtml(c.id)}">
                <div class="card-head">
                  <div class="author-wrap">
                    <span class="avatar">${escapeHtml(getInitials(c.author, c.initials))}</span>
                    <div style="min-width:0;">
                      <div class="author-name">${escapeHtml(c.author || 'Reviewer')}</div>
                      ${c.date ? `<div class="card-time">${escapeHtml(formatDate(c.date))}</div>` : ''}
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:4px;">
                    ${c.resolved ? '<span class="resolved-chip">Resolved</span>' : ''}
                    <span class="loc-chip">${escapeHtml(c.location || (c.page ? `Page ${c.page}` : `#${idx + 1}`))}</span>
                  </div>
                </div>
                ${c.anchorText ? `<div class="anchor-quote">&ldquo;${escapeHtml(c.anchorText)}&rdquo;</div>` : ''}
                <div class="card-body">${escapeHtml(c.text)}</div>
                ${(c.replies || []).length > 0 ? `
                  <div class="reply-list">
                    ${c.replies.map((r) => `
                      <div class="reply-item">
                        <div class="reply-meta"><strong>${escapeHtml(r.author)}</strong>${r.date ? ` &middot; ${escapeHtml(formatDate(r.date))}` : ''}</div>
                        <div class="card-body">${escapeHtml(r.text)}</div>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
                <div class="card-actions">
                  <button class="btn xs" data-copy-comment="${escapeHtml(c.id)}">Copy</button>
                  <button class="btn xs" data-cite-comment="${escapeHtml(c.id)}">Cite to Chat</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (state.inspectorTab === 'notes') {
      bodyHtml = `
        <div class="inspector-list">
          ${notes.length === 0 ? `
            <div class="empty-box">
              <div class="empty-title">${doc.kind === 'pptx' ? 'No speaker notes' : 'No footnotes or endnotes'}</div>
              <div>${doc.kind === 'pptx' ? 'None of the slides in this deck contain speaker notes.' : 'This document contains no footnotes or endnotes.'}</div>
            </div>
          ` : notes.map((n) => {
            const isCur = n.page && n.page === state.currentPage;
            return `
              <div class="card-item ${isCur ? 'current-page' : ''}" data-jump-page="${n.page || ''}">
                <div class="card-head">
                  <span class="author-name">${escapeHtml(n.label || 'Note')}</span>
                  ${n.page ? `<span class="loc-chip">Page ${n.page}</span>` : ''}
                </div>
                ${n.slideTitle ? `<div class="card-time">${escapeHtml(n.slideTitle)}</div>` : ''}
                <div class="card-body">${escapeHtml(n.text)}</div>
                <div class="card-actions">
                  <button class="btn xs" data-copy-note="${escapeHtml(n.id)}">Copy</button>
                  <button class="btn xs" data-cite-note="${escapeHtml(n.id)}">Cite to Chat</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (state.inspectorTab === 'revisions') {
      bodyHtml = `
        <div class="inspector-list">
          ${revisions.length === 0 ? `
            <div class="empty-box">
              <div class="empty-title">No tracked changes</div>
              <div>This document contains no pending insertions or deletions.</div>
            </div>
          ` : revisions.map((r) => `
            <div class="card-item" data-jump-page="${r.page || ''}">
              <div class="card-head">
                <div class="author-wrap">
                  <span class="rev-tag ${r.type === 'insert' ? 'insert' : 'delete'}">${r.type === 'insert' ? '+ Insert' : '- Delete'}</span>
                  <span class="author-name">${escapeHtml(r.author)}</span>
                </div>
                ${r.page ? `<span class="loc-chip">Page ${r.page}</span>` : ''}
              </div>
              ${r.date ? `<div class="card-time">${escapeHtml(formatDate(r.date))}</div>` : ''}
              <div class="card-body ${r.type === 'delete' ? 'rev-del-text' : ''}">${escapeHtml(r.text)}</div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="inspector-list">
          ${outline.length === 0 ? `
            <div class="empty-box">
              <div class="empty-title">No outline entries</div>
              <div>No headings, slides, sheets, or PDF bookmarks were detected.</div>
            </div>
          ` : outline.map((o) => {
            const padLeft = 8 + (Math.max(1, Number(o.level || 1)) - 1) * 14;
            const active = o.page && o.page === state.currentPage;
            return `
              <button class="outline-item ${active ? 'active' : ''}" style="padding-left:${padLeft}px" data-outline-page="${o.page || ''}" data-outline-sheet="${o.sheetIndex ?? ''}">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(o.title)}</span>
                ${o.page ? `<span class="card-time">${o.page}</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      `;
    }

    return `
      <aside class="inspector-drawer">
        <div class="inspector-tabs">
          ${tabs.map((t) => `
            <button class="inspector-tab ${state.inspectorTab === t.id ? 'active' : ''}" data-inspector-tab="${t.id}">
              ${t.label}
              <span class="tab-badge">${t.count}</span>
            </button>
          `).join('')}
          <button class="btn xs icon-only" style="margin-left:auto;margin-bottom:4px;" data-action="toggle-inspector" title="Close inspector">&times;</button>
        </div>
        ${bodyHtml}
      </aside>
    `;
  }

  function renderViewerMain() {
    if (state.loadingDoc) {
      return `
        <main class="viewer-main">
          <div class="empty-box">
            <div class="spinner"></div>
            <div class="empty-title">Parsing and rendering document...</div>
            <div>First open converts and caches PPTX/DOCX pages; subsequent turns load instantly.</div>
          </div>
        </main>
      `;
    }
    if (state.docError) {
      return `
        <main class="viewer-main">
          <div class="empty-box">
            <div class="empty-title">Failed to open document</div>
            <div>${escapeHtml(state.docError)}</div>
          </div>
        </main>
      `;
    }
    if (!state.doc) return '';

    const isSpreadsheet = state.doc.kind === 'xlsx' || state.doc.kind === 'csv';
    const mainInner = (isSpreadsheet && state.excelMode === 'table')
      ? renderSpreadsheetView(state.doc)
      : renderPageStage(state.doc);

    return `<main class="viewer-main">${mainInner}</main>`;
  }

  function render() {
    const root = document.getElementById('app-root');
    if (!root) return;
    // Preserve input focus and caret offset across re-renders
    const activeEl = document.activeElement;
    const activeRole = activeEl?.dataset?.role || '';
    const selStart = typeof activeEl?.selectionStart === 'number' ? activeEl.selectionStart : null;

    root.innerHTML = `
      ${renderTopbar()}
      <div class="workspace-body">
        ${renderFileDrawer()}
        ${renderViewerMain()}
        ${renderInspectorDrawer()}
      </div>
    `;

    if (activeRole) {
      const nextInput = root.querySelector(`[data-role="${activeRole}"]`);
      if (nextInput) {
        nextInput.focus();
        if (selStart !== null && typeof nextInput.setSelectionRange === 'function') {
          try {
            nextInput.setSelectionRange(selStart, selStart);
          } catch {
            // Number inputs do not support setSelectionRange
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event Delegation
  // -------------------------------------------------------------------------

  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, [data-open-file], [data-jump-comment], [data-jump-page], [data-cell-comment-id], [data-thumb-page], [data-sheet-idx], [data-outline-page]');
    if (!target) return;

    // Handle copy/cite buttons inside cards before bubbling to card navigation
    if (target.dataset.copyComment) {
      e.stopPropagation();
      const cm = (state.doc?.comments || []).find((c) => c.id === target.dataset.copyComment);
      if (cm) {
        const lines = [
          `[${cm.location || 'Comment'}] ${cm.author}${cm.date ? ` (${formatDate(cm.date)})` : ''}`,
          cm.anchorText ? `Quote: ${cm.anchorText}` : '',
          `Comment: ${cm.text}`,
          ...(cm.replies || []).map((r) => `  Reply (${r.author}): ${r.text}`),
        ].filter(Boolean).join('\n');
        void copyText(lines, 'Copied comment thread');
      }
      return;
    }

    if (target.dataset.citeComment) {
      e.stopPropagation();
      const cm = (state.doc?.comments || []).find((c) => c.id === target.dataset.citeComment);
      if (cm) {
        const replyStr = (cm.replies || []).map((r) => `\nReply (${r.author}): ${r.text}`).join('');
        sendToChatContext({
          title: `${state.doc.fileName} - ${cm.location || 'Comment'}`,
          selection: cm.anchorText || '',
          text: `Comment (${cm.author}): ${cm.text}${replyStr}`,
        });
      }
      return;
    }

    if (target.dataset.copyNote) {
      e.stopPropagation();
      const note = (state.doc?.notes || []).find((n) => n.id === target.dataset.copyNote);
      if (note) void copyText(note.text, 'Copied note text');
      return;
    }

    if (target.dataset.citeNote) {
      e.stopPropagation();
      const note = (state.doc?.notes || []).find((n) => n.id === target.dataset.citeNote);
      if (note) {
        sendToChatContext({
          title: `${state.doc.fileName} - ${note.label}`,
          text: note.text,
        });
      }
      return;
    }

    if (target.dataset.citePage) {
      e.stopPropagation();
      const p = Number(target.dataset.citePage);
      sendToChatContext({
        title: `${state.doc.fileName} - Page ${p}`,
        text: `Reference: ${state.doc.filePath} (Page ${p})`,
      });
      return;
    }

    const action = target.dataset.action;
    if (action) {
      switch (action) {
        case 'toggle-files':
          state.showFilesDrawer = !state.showFilesDrawer;
          render();
          if (state.showFilesDrawer && state.files.length === 0) void loadFiles();
          return;
        case 'refresh-files':
          void loadFiles();
          return;
        case 'open-manual-path':
          void openFile(state.manualPath);
          return;
        case 'prev-page':
          goToPage(state.currentPage - 1);
          return;
        case 'next-page':
          goToPage(state.currentPage + 1);
          return;
        case 'zoom-in':
          setZoom(state.zoom + 20);
          return;
        case 'zoom-out':
          setZoom(state.zoom - 20);
          return;
        case 'zoom-fit':
          setZoom('fit');
          return;
        case 'toggle-view-mode':
          state.viewMode = state.viewMode === 'single' ? 'scroll' : 'single';
          render();
          return;
        case 'toggle-inspector':
          state.showInspector = !state.showInspector;
          render();
          return;
        case 'open-page-comments':
          state.showInspector = true;
          state.inspectorTab = 'comments';
          state.commentFilter = 'page';
          render();
          return;
        case 'reload-doc':
          if (state.doc) {
            void openFile(state.doc.filePath, {
              force: true,
              needPdf: state.excelMode === 'print',
              page: state.currentPage,
            });
          }
          return;
        case 'excel-mode-table':
          state.excelMode = 'table';
          render();
          return;
        case 'excel-mode-print':
          if (state.doc) {
            if (state.doc.canRenderPages || state.doc.hasPdf) {
              state.excelMode = 'print';
              render();
            } else {
              void openFile(state.doc.filePath, { needPdf: true });
            }
          }
          return;
        case 'cite-current-page':
          sendToChatContext({
            title: `${state.doc.fileName} - Page ${state.currentPage}`,
            text: `Reference: ${state.doc.filePath} (Page ${state.currentPage})`,
          });
          return;
        case 'toggle-speaker-dock':
          state.showSpeakerDock = !state.showSpeakerDock;
          render();
          return;
        case 'copy-speaker-note': {
          const notes = (state.doc?.notes || []).filter((n) => n.kind === 'speaker_note' && n.page === state.currentPage);
          void copyText(notes.map((n) => n.text).join('\n\n'), 'Copied slide speaker notes');
          return;
        }
        case 'cite-speaker-note': {
          const notes = (state.doc?.notes || []).filter((n) => n.kind === 'speaker_note' && n.page === state.currentPage);
          sendToChatContext({
            title: `${state.doc.fileName} - Slide ${state.currentPage} Speaker Notes`,
            text: notes.map((n) => n.text).join('\n\n'),
          });
          return;
        }
      }
    }

    if (target.dataset.openFile) {
      void openFile(target.dataset.openFile);
      return;
    }
    if (target.dataset.fileKind) {
      state.fileKind = target.dataset.fileKind;
      void loadFiles();
      return;
    }
    if (target.dataset.thumbPage) {
      goToPage(Number(target.dataset.thumbPage));
      return;
    }
    if (target.dataset.sheetIdx !== undefined) {
      state.activeSheetIdx = Number(target.dataset.sheetIdx);
      state.highlightCellKey = '';
      render();
      return;
    }
    if (target.dataset.cellCommentId) {
      state.showInspector = true;
      state.inspectorTab = 'comments';
      state.commentFilter = 'all';
      state.highlightCellKey = target.dataset.cellKey || '';
      render();
      return;
    }
    if (target.dataset.inspectorTab) {
      state.inspectorTab = target.dataset.inspectorTab;
      render();
      return;
    }
    if (target.dataset.cmFilter) {
      state.commentFilter = target.dataset.cmFilter;
      render();
      return;
    }
    if (target.dataset.jumpComment) {
      const cm = (state.doc?.comments || []).find((c) => c.id === target.dataset.jumpComment);
      if (cm) jumpToComment(cm);
      return;
    }
    if (target.dataset.jumpPage) {
      const p = Number(target.dataset.jumpPage);
      if (p > 0) goToPage(p);
      return;
    }
    if (target.dataset.outlineSheet !== undefined && target.dataset.outlineSheet !== '') {
      state.activeSheetIdx = Number(target.dataset.outlineSheet);
      render();
      return;
    }
    if (target.dataset.outlinePage) {
      const p = Number(target.dataset.outlinePage);
      if (p > 0) goToPage(p);
    }
  });

  let searchDebounce = null;
  document.addEventListener('input', (e) => {
    const role = e.target?.dataset?.role;
    if (role === 'manual-path') {
      state.manualPath = e.target.value;
    } else if (role === 'file-search') {
      state.fileQuery = e.target.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        void loadFiles();
      }, 220);
    } else if (role === 'sheet-search') {
      state.sheetQuery = e.target.value;
      render();
    }
  });

  document.addEventListener('keydown', (e) => {
    const role = e.target?.dataset?.role;
    if (e.key === 'Enter') {
      if (role === 'manual-path') {
        e.preventDefault();
        void openFile(state.manualPath);
        return;
      }
      if (role === 'page-jump') {
        e.preventDefault();
        goToPage(Number(e.target.value));
        return;
      }
    }

    // Do not hijack global shortcuts while typing in inputs
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!state.doc || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      goToPage(state.currentPage - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      goToPage(state.currentPage + 1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(state.zoom + 20);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(state.zoom - 20);
    } else if (e.key === '0') {
      e.preventDefault();
      setZoom('fit');
    }
  });

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  async function bootstrap() {
    render();
    try {
      const envRes = await apiFetch('/api/env', { method: 'GET' });
      state.env = envRes.env;
      state.recentFiles = envRes.state?.recentFiles || [];
      const target = envRes.state?.target;
      if (target?.seq) {
        state.lastTargetSeq = Number(target.seq);
      }
      if (target?.filePath) {
        void openFile(target.filePath, { page: target.page, tab: target.tab });
      }
    } catch {
      // Ignore initial environment lookup errors
    }

    if (window.sidecar?.onWorkspaceChange) {
      window.sidecar.onWorkspaceChange((uris) => {
        state.workspaceUris = Array.isArray(uris) ? uris : [];
        void loadFiles();
      });
    } else {
      void loadFiles();
    }

    if (statePollTimer) clearInterval(statePollTimer);
    statePollTimer = setInterval(() => {
      void pollSharedState();
    }, 1800);
  }

  void bootstrap();
})();
