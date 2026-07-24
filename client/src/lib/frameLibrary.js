/**
 * Auto-save frames extracted anywhere (the Instagram/TikTok/X link import on Photo Match /
 * Scene Recreate / Pose Remix) into the Frame Library — now backed by IndexedDB so big
 * batches don't blow the old localStorage cap.
 */

import { appendFrames } from './frameLibraryStore';

/**
 * @param {Array<{dataUrl:string,name?:string,type?:string,source?:string}>} frames
 * @returns {Promise<number>} how many were saved
 */
export async function addFramesToLibrary(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return 0;
  const now = Date.now();
  const items = frames
    .filter((f) => f && typeof f.dataUrl === 'string' && f.dataUrl)
    .map((f, i) => ({
      id: `frame-${now}-${i}-${Math.random().toString(36).slice(2, 10)}`,
      name: f.name || `frame_${i + 1}.jpg`,
      type: f.type || 'image/jpeg',
      size: 0,
      createdAt: now,
      source: f.source || 'Imported Frames',
      dataUrl: f.dataUrl,
      usage: [],
    }));
  return appendFrames(items);
}
