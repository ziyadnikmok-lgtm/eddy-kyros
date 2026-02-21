// server/services/autoPlanStore.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middleware/errorHandler');

const DATA_FILE = path.join(__dirname, '..', 'data', 'auto-plans.json');
const MAX_PLANS = 50;

class AutoPlanStore {
  constructor() {
    this._ensureDataDir();
    this._store = this._load();
  }

  list() {
    return this._store
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((p) => this._toSummary(p));
  }

  get(id) {
    const plan = this._store.find((p) => p.id === id);
    if (!plan) throw new AppError('Plan not found', 404, 'NOT_FOUND');
    return plan;
  }

  save(data) {
    if (this._store.length >= MAX_PLANS) {
      this._store.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      this._store.shift();
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

    this._store.push(plan);
    this._persist();
    return plan;
  }

  update(id, data) {
    const plan = this._store.find((p) => p.id === id);
    if (!plan) throw new AppError('Plan not found', 404, 'NOT_FOUND');

    if (data.name !== undefined) plan.name = String(data.name).trim().slice(0, 100);
    if (data.startDate !== undefined) plan.startDate = data.startDate;
    if (data.days !== undefined) plan.days = data.days;
    if (data.status !== undefined) plan.status = data.status;

    this._persist();
    return plan;
  }

  markDayExecuted(id, dayNumber, jobIds) {
    const plan = this._store.find((p) => p.id === id);
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

    this._persist();
    return plan;
  }

  remove(id) {
    const idx = this._store.findIndex((p) => p.id === id);
    if (idx === -1) throw new AppError('Plan not found', 404, 'NOT_FOUND');
    this._store.splice(idx, 1);
    this._persist();
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
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* corrupt — start fresh */ }
    return [];
  }

  _persist() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(this._store, null, 2), 'utf8');
  }
}

module.exports = new AutoPlanStore();
