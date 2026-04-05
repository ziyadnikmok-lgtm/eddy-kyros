import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-dataset-store-'));

vi.mock('../paths', () => ({
  getDataDir: () => tempRoot,
}));

vi.mock('../userContext', () => ({
  getUserId: () => 'test-user',
}));

const storePath = path.join(tempRoot, 'lora-datasets.json');
const { default: loraDatasetStore } = await import('../services/loraDatasetStore');

describe('loraDatasetStore', () => {
  beforeEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  afterEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  it('creates and lists datasets newest-first', async () => {
    const first = loraDatasetStore.create({ name: 'first', status: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = loraDatasetStore.create({ name: 'second', status: 'completed' });
    const list = loraDatasetStore.list();

    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second.id);
    expect(list[1].id).toBe(first.id);
  });

  it('updates persisted dataset fields', () => {
    const created = loraDatasetStore.create({
      name: 'demo',
      status: 'running',
      progress: { generated: 0, captioned: 0, failed: 0, total: 2 },
      items: [],
      failures: [],
    });

    const updated = loraDatasetStore.update(created.id, {
      status: 'partial',
      stage: 'completed',
      progress: { generated: 1, captioned: 1, failed: 1, total: 2 },
      items: [{ galleryId: 'g1' }],
    });

    expect(updated.status).toBe('partial');
    expect(updated.stage).toBe('completed');
    expect(updated.progress.generated).toBe(1);
    expect(updated.items).toHaveLength(1);

    const loaded = loraDatasetStore.get(created.id);
    expect(loaded.status).toBe('partial');
    expect(loaded.items[0].galleryId).toBe('g1');
  });
});
