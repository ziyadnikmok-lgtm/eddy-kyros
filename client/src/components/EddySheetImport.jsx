import { useState, useMemo } from 'react';
import { Card, Btn, Spinner } from './UI';
import { useApp } from '../context/AppContext';
import { postClone } from '../services/api';
import { createEddyCollection } from '../lib/eddyCollectionStore';

/**
 * Bulk-imports a Google Sheet export into an Eddy collection: one row = one image + its prompt.
 *
 * The images live on Instagram's CDN, which blocks cross-origin reads, so they are pulled
 * through the server's existing /post-clone/proxy-image endpoint rather than fetched directly.
 */

/** Full CSV parse — quoted fields, embedded newlines and "" escapes all appear in Sheets exports. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

const isUrl = (s) => /^https?:\/\//i.test(s.trim());

/**
 * A video sheet lays each row out as repeating (idea, prompt) pairs — "Video Idea",
 * "Video Prompt variation 1", "Video Idea", "Video Prompt variation 2", and so on — with one
 * image for the whole row.
 *
 * Returns the column index pairs, or null when the header does not look like that layout, in
 * which case the caller falls back to one-row-one-prompt.
 */
function findVariationPairs(header) {
  if (!header) return null;
  const cols = header.map((h) => (h || '').trim().toLowerCase());
  const promptCols = [];
  cols.forEach((h, i) => { if (/prompt/.test(h)) promptCols.push(i); });
  if (promptCols.length < 2) return null;   // one prompt column is just a normal sheet

  return promptCols.map((promptAt) => {
    // The idea belongs to the nearest labelled column to the LEFT of its prompt. Falling back
    // to promptAt - 1 covers a sheet whose description header is worded differently.
    let ideaAt = -1;
    for (let i = promptAt - 1; i >= 0; i -= 1) {
      if (/idea|description|concept|title/.test(cols[i])) { ideaAt = i; break; }
      if (/prompt/.test(cols[i])) break;    // ran into the previous pair — this one has no idea
    }
    return { ideaAt, promptAt };
  });
}

/** Description first, then the prompt — reading order matches how the sheet is written. */
function joinIdeaAndPrompt(idea, prompt) {
  const a = (idea || '').trim();
  const b = (prompt || '').trim();
  if (a && b) return `${a}

${b}`;
  return a || b;
}


/** Prefer a direct CDN image over an instagram.com/p/ post page, which is HTML, not an image. */
function pickImageUrl(cells) {
  const urls = cells.map((c) => c.trim()).filter(isUrl);
  return urls.find((u) => /cdninstagram\.com|fbcdn\.net/i.test(u)) || urls[0] || '';
}

/**
 * The sheet's prompt cell is a JSON block whose pose_action.description is the actual pose —
 * the rest pins the reference image, which Eddy already does. Anything that isn't parseable
 * JSON is kept verbatim.
 */
function pickPrompt(cells) {
  const candidates = cells.filter((c) => !isUrl(c) && c.trim().length > 20);
  const raw = candidates.sort((a, b) => b.length - a.length)[0] || '';
  try {
    const obj = JSON.parse(raw);
    const desc = obj?.pose_action?.description;
    if (typeof desc === 'string' && desc.trim()) return desc.trim();
  } catch {
    // Not JSON — the cell is already a plain prompt.
  }
  return raw.trim();
}

async function urlToDataUrl(url) {
  const resp = await fetch(postClone.proxyImageUrl(url), { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  if (!blob.type.startsWith('image/')) throw new Error('not an image');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function EddySheetImport({ dbName, label = 'poses', onImported }) {
  const { notify } = useApp();
  const store = useMemo(() => createEddyCollection(dbName), [dbName]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState(null);

  // A prepared .json file ([{prompt, image}]) skips the network entirely: its pictures are
  // already embedded. This is the reliable path for a sheet whose images are pasted INTO the
  // cells, because those never appear in a CSV export -- only an .xlsx carries them.
  const handleJson = async (text) => {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Expected a JSON array');
    // An entry may carry several prompt variations that all belong to one picture, either as
    // {variations:[...]} or {prompts:[...]}. Each becomes its own item, image included.
    const added = data.flatMap((d, i) => {
      const image = d.image || '';
      const folder = (d.folder || '').trim();
      const list = Array.isArray(d.variations) ? d.variations
        : Array.isArray(d.prompts) ? d.prompts
        : null;
      if (list && list.length) {
        return list
          .map((v) => (typeof v === 'string' ? { prompt: v } : v || {}))
          // A title names the shot; the prompt is the instruction. Keeping them apart means the
          // card can show the title and still send only the prompt.
          .map((v) => ({
            title: (v.title || v.idea || v.description || d.title || '').trim(),
            prompt: (v.prompt || '').trim(),
          }))
          .filter((v) => v.prompt || v.title)
          .map((v, vi) => ({
            dataUrl: image,
            prompt: v.prompt || v.title,
            folder,
            name: v.title || `import-${i + 1}-v${vi + 1}`,
          }));
      }
      // A title stays a title. Only an `idea` — the sheet's combined title+prompt cell — gets
      // folded into the prompt, so an export from this app round-trips unchanged.
      return [{
        dataUrl: image,
        prompt: (d.title || '').trim()
          ? (d.prompt || '').trim()
          : joinIdeaAndPrompt(d.idea || d.description || '', d.prompt || ''),
        folder,
        name: (d.title || '').trim() || `import-${i + 1}`,
      }];
    }).filter((d) => d.dataUrl || d.prompt);
    if (!added.length) throw new Error('No usable entries in that file');

    // Recreate the folders the export came from, so a shared set does not arrive as one flat
    // pile. ensureFolder is atomic, so repeated names resolve to a single folder.
    const byFolder = new Map();
    for (const d of added) {
      if (!d.folder) continue;
      if (!byFolder.has(d.folder)) byFolder.set(d.folder, (await store.ensureFolder(d.folder))?.id || null);
    }

    const stored = [];
    for (const [folderName, folderId] of [...byFolder, ['', null]]) {
      const group = added.filter((d) => (d.folder || '') === folderName);
      if (group.length) stored.push(...await store.addItems(group, folderId));
    }
    const missing = added.length - stored.length;
    const skipped = missing > 0 ? [`${missing} item(s) could not be saved`] : [];
    // Stored items keep the name they were given, so counting pictures means looking back at
    // the input by name rather than at the index (which never holds the bytes).
    const withImage = stored.filter((a) => added.find((x) => x.name === a.name)?.dataUrl).length;
    return { count: stored.length, withImage, skipped };
  };

  const handleFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setReport(null);
    try {
      if (/\.json$/i.test(file.name)) {
        setProgress('Reading file…');
        const res = await handleJson(await file.text());
        setReport(res);
        notify(`Imported ${res.count} ${label}`, 'success');
        onImported?.();
        return;
      }
      const rows = parseCsv(await file.text());
      // Drop a header row only if it has no prompt-length cell of its own.
      const hasHeader = rows.length > 1 && !pickPrompt(rows[0]);
      const body = hasHeader ? rows.slice(1) : rows;
      // A video sheet carries several prompt variations per row, all sharing one image. Each
      // variation becomes its own item so it can be picked independently later.
      const pairs = hasHeader ? findVariationPairs(rows[0]) : null;

      const added = [];
      const skipped = [];
      for (let i = 0; i < body.length; i += 1) {
        setProgress(`Row ${i + 1} of ${body.length}`);
        const url = pickImageUrl(body[i]);
        // Every variation in this row reuses the row's single image.
        const rowPrompts = pairs
          ? pairs
            .map(({ ideaAt, promptAt }) => joinIdeaAndPrompt(ideaAt >= 0 ? body[i][ideaAt] : '', body[i][promptAt]))
            .filter((t) => t.trim())
          : [pickPrompt(body[i])].filter((t) => t.trim());
        if (!rowPrompts.length && !url) continue;

        let dataUrl = '';
        if (url) {
          try {
            dataUrl = await urlToDataUrl(url);
          } catch (err) {
            // Instagram CDN links are signed and expire. A dead image should not cost you the
            // prompt on that row, so the row is still imported, just without its picture.
            skipped.push(`row ${i + 1}: image (${err.message})`);
          }
        }
        if (!rowPrompts.length) {
          if (dataUrl) added.push({ dataUrl, prompt: '', name: `sheet-${i + 1}` });
          continue;
        }
        // Three variations become three items sharing one picture — that is the point of the
        // layout: pick a variation later without losing which shot it belongs to.
        rowPrompts.forEach((text, v) => {
          added.push({
            dataUrl,
            prompt: text,
            name: rowPrompts.length > 1 ? `sheet-${i + 1}-v${v + 1}` : `sheet-${i + 1}`,
          });
        });
      }

      if (!added.length) throw new Error('No usable rows found in that file');
      await store.addItems(added);
      setReport({ count: added.length, withImage: added.filter((a) => a.dataUrl).length, skipped });
      notify(`Imported ${added.length} ${label}`, 'success');
      onImported?.();
    } catch (err) {
      notify(err.message || 'Import failed', 'error');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-zinc-300">Import from a sheet</p>
          <p className="text-xs text-zinc-600">
            A prepared .json (images included), or a Sheets CSV export where each row carries an image URL and its prompt.
          </p>
        </div>
        <label className={`inline-flex cursor-pointer items-center rounded-lg border border-white/[0.06] bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-white/[0.07] ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {busy ? <><Spinner size={14} /><span className="ml-2">{progress || 'Importing…'}</span></> : 'Choose file'}
          <input type="file" accept=".csv,.json,text/csv,application/json" className="hidden"
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>

      {report && (
        <div className="space-y-1 rounded-lg bg-white/[0.02] p-3 text-xs">
          <p className="text-zinc-300">
            Imported {report.count} — {report.withImage} with an image, {report.count - report.withImage} prompt-only.
          </p>
          {report.skipped.length > 0 && (
            <details className="text-zinc-600">
              <summary className="cursor-pointer text-amber-400/80">{report.skipped.length} image(s) could not be fetched</summary>
              <ul className="mt-1 space-y-0.5">{report.skipped.map((sk) => <li key={sk}>{sk}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
