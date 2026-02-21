// server/utils/sse.js
// Shared Server-Sent Events helpers.

/**
 * Write SSE headers and return a typed send function.
 *
 * @param {import('express').Response} res
 * @returns {(event: string, data: object) => void} send – writes one SSE frame
 */
function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return (event, data) => {
    if (event) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };
}

module.exports = { initSSE };
