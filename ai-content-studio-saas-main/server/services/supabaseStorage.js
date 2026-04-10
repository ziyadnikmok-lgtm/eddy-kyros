'use strict';
/**
 * Supabase backend for gallery images + metadata.
 *
 * Activated when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.
 * Falls back to local filesystem automatically when those vars are absent.
 *
 * Supabase setup (one-time):
 *  1. Create a project at https://supabase.com
 *  2. Storage → New bucket → name: "gallery" → Public: ON
 *  3. SQL Editor → run the CREATE TABLE block below
 *  4. Add to .env:
 *       SUPABASE_URL=https://xxxx.supabase.co
 *       SUPABASE_SERVICE_ROLE_KEY=eyJ...
 *
 * SQL (run once in Supabase SQL Editor):
 * ─────────────────────────────────────
 * create table if not exists gallery (
 *   id            text primary key,
 *   filename      text,
 *   mime_type     text not null,
 *   prompt        text,
 *   source        text default 'generate',
 *   character_id  text,
 *   aspect_ratio  text,
 *   seed          text,
 *   tags          text[] default '{}',
 *   file_size     int default 0,
 *   is_favorite   boolean default false,
 *   quality_score float,
 *   quality_reasons text[],
 *   parent_id     text,
 *   session_id    text,
 *   persona_mode  text,
 *   storage_url   text,
 *   created_at    timestamptz default now()
 * );
 * ─────────────────────────────────────
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'gallery';

let _client = null;

function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

function getClient() {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _client;
}

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * Upload an image buffer to Supabase Storage.
 * Returns the public URL string.
 */
async function uploadImage(filename, buffer, mimeType) {
  const sb = getClient();
  const { error } = await sb.storage.from(BUCKET).upload(filename, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data } = sb.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

/**
 * Download an image from Supabase Storage.
 * Returns a Buffer.
 */
async function downloadImage(filename) {
  const sb = getClient();
  const { data, error } = await sb.storage.from(BUCKET).download(filename);
  if (error) throw new Error(`Supabase download failed: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Delete an image from Supabase Storage.
 */
async function deleteImage(filename) {
  if (!filename) return;
  try {
    const sb = getClient();
    const { error } = await sb.storage.from(BUCKET).remove([filename]);
    if (error) console.warn('[supabase] storage delete error:', error.message);
  } catch (err) {
    console.warn('[supabase] deleteImage error:', err.message);
  }
}

// ── Database ─────────────────────────────────────────────────────────────────

async function dbInsert(entry) {
  const sb = getClient();
  const row = _entryToRow(entry);
  const { data, error } = await sb.from('gallery').insert(row).select().single();
  if (error) throw new Error(`Supabase db insert failed: ${error.message}`);
  return _rowToEntry(data);
}

async function dbList({ tag } = {}) {
  const sb = getClient();
  let query = sb.from('gallery').select('*').order('created_at', { ascending: false });
  if (tag) {
    query = query.contains('tags', [tag.toLowerCase()]);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Supabase db list failed: ${error.message}`);
  return (data || []).map(_rowToEntry);
}

async function dbGet(id) {
  const sb = getClient();
  const { data, error } = await sb.from('gallery').select('*').eq('id', id).single();
  if (error) throw new Error(`Supabase db get failed: ${error.message}`);
  return _rowToEntry(data);
}

async function dbUpdate(id, patch) {
  const sb = getClient();
  const row = {};
  if (patch.isFavorite !== undefined) row.is_favorite = patch.isFavorite;
  if (patch.tags !== undefined) row.tags = patch.tags;
  if (patch.qualityScore !== undefined) row.quality_score = patch.qualityScore;
  if (patch.qualityReasons !== undefined) row.quality_reasons = patch.qualityReasons;
  if (patch.parentId !== undefined) row.parent_id = patch.parentId;
  if (patch.sessionId !== undefined) row.session_id = patch.sessionId;
  if (patch.personaMode !== undefined) row.persona_mode = patch.personaMode;
  const { data, error } = await sb.from('gallery').update(row).eq('id', id).select().single();
  if (error) throw new Error(`Supabase db update failed: ${error.message}`);
  return _rowToEntry(data);
}

async function dbDelete(id) {
  const sb = getClient();
  const { error } = await sb.from('gallery').delete().eq('id', id);
  if (error) throw new Error(`Supabase db delete failed: ${error.message}`);
}

async function dbDeleteMany(ids) {
  if (!ids || ids.length === 0) return;
  const sb = getClient();
  const { error } = await sb.from('gallery').delete().in('id', ids);
  if (error) throw new Error(`Supabase db deleteMany failed: ${error.message}`);
}

async function dbGetAllTags() {
  const sb = getClient();
  const { data, error } = await sb.from('gallery').select('tags');
  if (error) throw new Error(`Supabase db getTags failed: ${error.message}`);
  const tagSet = new Set();
  for (const row of data || []) {
    for (const t of row.tags || []) tagSet.add(t);
  }
  return [...tagSet].sort();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _entryToRow(entry) {
  return {
    id: entry.id,
    filename: entry.filename || null,
    mime_type: entry.mimeType,
    prompt: (entry.prompt || '').slice(0, 4000),
    source: entry.source || 'generate',
    character_id: entry.characterId || null,
    aspect_ratio: entry.aspectRatio || null,
    seed: entry.seed || null,
    tags: entry.tags || [],
    file_size: entry.fileSize || 0,
    is_favorite: entry.isFavorite || false,
    storage_url: entry.storageUrl || null,
    created_at: entry.createdAt || new Date().toISOString(),
  };
}

function _rowToEntry(row) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    prompt: row.prompt,
    source: row.source,
    characterId: row.character_id,
    aspectRatio: row.aspect_ratio,
    seed: row.seed,
    tags: row.tags || [],
    fileSize: row.file_size || 0,
    isFavorite: row.is_favorite || false,
    qualityScore: row.quality_score,
    qualityReasons: row.quality_reasons,
    parentId: row.parent_id,
    sessionId: row.session_id,
    personaMode: row.persona_mode,
    storageUrl: row.storage_url,
    createdAt: row.created_at,
  };
}

module.exports = {
  isConfigured,
  uploadImage,
  downloadImage,
  deleteImage,
  dbInsert,
  dbList,
  dbGet,
  dbUpdate,
  dbDelete,
  dbDeleteMany,
  dbGetAllTags,
};
