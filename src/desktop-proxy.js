import http from 'node:http';

function headersFor(request, port) {
  const headers = { ...request.headers, host: `127.0.0.1:${port}` };
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-login-') || name.startsWith('x-forwarded-') ||
      ['cookie', 'authorization', 'x-csrf-token'].includes(name)) delete headers[name];
  }
  return headers;
}

export function proxyDesktop(request, response, { port, path }) {
  const upstream = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: headersFor(request, port) }, incoming => {
    if (response.destroyed) { incoming.destroy(); return; }
    response.writeHead(incoming.statusCode, { ...incoming.headers, 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff' });
    incoming.pipe(response);
  });
  upstream.setTimeout(10_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (response.destroyed) return;
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('Remote screen unavailable. Return to the login page and start a session.');
  });
  response.on('close', () => upstream.destroy());
  upstream.end();
}

export function proxyDesktopSocket(request, socket, head, { port, path, sockets }) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  const upstream = http.request({ hostname: '127.0.0.1', port, path, headers: headersFor(request, port) });
  upstream.setTimeout(10_000, () => upstream.destroy());
  socket.on('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  upstream.on('response', () => { upstream.destroy(); socket.destroy(); });
  upstream.on('upgrade', (response, remote, remoteHead) => {
    if (socket.destroyed) { remote.destroy(); return; }
    upstream.setTimeout(0);
    sockets.add(remote);
    remote.once('close', () => { sockets.delete(remote); socket.destroy(); });
    remote.on('error', () => socket.destroy());
    socket.once('close', () => remote.destroy());
    const headers = [];
    for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) remote.write(head);
    if (remoteHead.length) socket.write(remoteHead);
    remote.pipe(socket); socket.pipe(remote);
  });
  upstream.end();
}
