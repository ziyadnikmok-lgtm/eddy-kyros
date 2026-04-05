/**
 * AsyncLocalStorage-based user context.
 * Set once in requireAuth middleware, readable from any service
 * without passing userId through every function call.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const _store = new AsyncLocalStorage();

function runWithUser(userId, fn) {
  return _store.run({ userId }, fn);
}

function getUserId() {
  return _store.getStore()?.userId ?? null;
}

module.exports = { runWithUser, getUserId };
