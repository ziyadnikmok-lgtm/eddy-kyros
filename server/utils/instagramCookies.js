// server/utils/instagramCookies.js
// Shared Instagram login-cookie builder — extracted from 4 duplicated copies.

const { asText } = require('./helpers');
const apiKeyManager = require('../services/apiKeyManager');

/**
 * Build an Apify-compatible login cookies array for Instagram scraping.
 *
 * @param {string} [sessionid]  Explicit session ID. When omitted, auto-resolves
 *                               from apiKeyManager → env fallback.
 * @returns {object[]|null}     Array with one cookie object, or null if no session.
 */
function buildLoginCookies(sessionid) {
  const sid = sessionid !== undefined
    ? asText(sessionid)
    : (asText(apiKeyManager.getInstagramSessionId()) || asText(process.env.INSTAGRAM_SESSIONID));

  if (!sid) return null;

  return [
    {
      name: 'sessionid',
      value: sid,
      domain: '.instagram.com',
      path: '/',
      secure: true,
      httpOnly: true,
    },
  ];
}

module.exports = { buildLoginCookies };
