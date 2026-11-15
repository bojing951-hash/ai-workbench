/**
 * Notes API 占位实现（阶段二验收项目）。
 * 需要实现 createServer() 与 startServer(port)。
 */
import http from 'node:http';

export function createServer() {
  return http.createServer((req, res) => {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_implemented' }));
  });
}

export async function startServer(port = 0) {
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
