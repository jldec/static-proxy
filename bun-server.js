// Simple hello world bun server
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/hello') {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Bun Server</title>
</head>
<body>
  <h1>hello from bun in container 🚀</h1>
</body>
</html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

console.log(`Bun server running on http://localhost:${server.port}`);

