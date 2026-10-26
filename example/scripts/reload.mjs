// Reloads JS in every app connected to Metro.
const ws = new WebSocket('ws://127.0.0.1:8081/message', {
  headers: { Origin: 'http://127.0.0.1:8081' },
});
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ version: 2, method: 'reload' }));
await new Promise((r) => setTimeout(r, 500));
ws.close();
