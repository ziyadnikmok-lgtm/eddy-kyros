const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');
const { atomicWriteJSON } = require('../utils/helpers');

const { getDataDir } = require('../paths');

const MAX_PLANS = 50;

class AutoPlanStore {
  get _dataFile() { return path.join(getDataDir(), 'auto-plans.json'); }

  constructor() {
    // no eager load — all reads happen per-request
  }

  list() {
    this._ensureDataDir();
    return this._load()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((p) => this._toSummary(p));
  }

  get(id) {
    this._ensureDataDir();
    const store = this._load();
    const plan = store.find((p) => p.id === id);
    if (!plan) throw new AppError('Plan not found', 404, 'NOT_FOUND');
    return plan;
  }

  save(data) {
    this._ensureDataDir();
    const store = this._load();

    if (store.length >= MAX_PLANS) {
      store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      store.shift();
    }

    const plan = {
      id: crypto.randomUUID(),
      name: String(data.name || 'Untitled Plan').trim().slice(0, 100),
      theme: data.theme || '',
      personaMode: data.personaMode || 'luxury',
      characterId: data.characterId || '',
      duration: data.duration || 7,
      startDate: data.startDate || new Date().toISOString().split('T')[0],
      days: Array.isArray(data.days) ? data.days : [],
      config: data.config || {},
      status: 'draft',
      executedDays: [],
      createdAt: new Date().toISOString(),
    };

    store.push(plan);
    this._persist(store);
    return plan;
  }

  update(id, data) {
    this._ensureDataDir();
    const store = this._load();
    const plan = store.find((p) => p.id === id);
    if (!plan) throw new AppError('Plan not found', 404, 'NOT_FOUND');

    if (data.name !== undefined) plan.name = String(data.name).trim().slice(0, 100);
    if (data.startDate !== undefined) plan.startDate = data.startDate;
    if (data.days !== undefined) plan.days = data.days;
    if (data.status !== undefined) plan.status = data.status;

    this._persist(store);
    return plan;
  }

  markDayExecuted(id, dayNumber, jobIds) {
    this._ensureDataDir();
    const store = this._load();
    const plan = store.find((p) => p.id === id);
    if (!plan) throw new AppError('Plan not found', 404, 'NOT_FOUND');

    if (!plan.executedDays) plan.executedDays = [];
    plan.executedDays.push({
      day: dayNumber,
      jobIds,
      executedAt: new Date().toISOString(),
    });

    const totalDays = plan.days.length;
    const executedCount = new Set(plan.executedDays.map((d) => d.day)).size;
    plan.status = executedCount >= totalDays ? 'completed' : 'partial';

    this._persist(store);
    return plan;
  }

  remove(id) {
    this._ensureDataDir();
    const store = this._load();
    const idx = store.findIndex((p) => p.id === id);
    if (idx === -1) throw new AppError('Plan not found', 404, 'NOT_FOUND');
    store.splice(idx, 1);
    this._persist(store);
    return { removed: true };
  }

  _toSummary(plan) {
    return {
      id: plan.id,
      name: plan.name,
      theme: plan.theme,
      personaMode: plan.personaMode,
      duration: plan.duration,
      startDate: plan.startDate,
      status: plan.status,
      totalDays: plan.days.length,
      executedDayCount: new Set((plan.executedDays || []).map((d) => d.day)).size,
      createdAt: plan.createdAt,
    };
  }

  _ensureDataDir() {
    const dir = path.dirname(this._dataFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(this._dataFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { }
    return [];
  }

  _persist(data) {
    atomicWriteJSON(this._dataFile, data);
  }
}

module.exports = new AutoPlanStore();
