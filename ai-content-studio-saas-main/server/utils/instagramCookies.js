const { asText } = require('./helpers');
const apiKeyManager = require('../services/apiKeyManager');

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
