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
