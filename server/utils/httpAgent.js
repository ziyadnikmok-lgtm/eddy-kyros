// server/utils/httpAgent.js
// Shared HTTP/HTTPS agents with connection pooling for external requests.
// Reuses TCP connections instead of opening new ones per request.

const http = require('node:http');
const https = require('node:https');

const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60_000,
  scheduling: 'lifo',
});

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60_000,
  scheduling: 'lifo',
});

module.exports = { sharedHttpAgent, sharedHttpsAgent };
