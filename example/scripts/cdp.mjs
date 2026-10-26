// Drives the example's JS runtime through Metro's debugger proxy, for tests and comparisons without tapping.
// Usage: node example/scripts/cdp.mjs <file.js | -e code> [appFilter]   (appFilter: 'iPhone', 'Xiaomi', ...)
// Runs the code as the body of an async function and prints console output and the result. Debug builds expose
// `ble` (the library), `compare` (the ble-plx comparison), `peripheralTests` (the test peripheral's suite) and
// `scanFilterTests`: node example/scripts/cdp.mjs -e "return await compare.run('<id>')"
// Hermes ignores awaitPromise, so the result is stored in a global and polled. TIMEOUT (ms) bounds the wait.
import { readFileSync } from 'node:fs';

const [, , arg, ...rest] = process.argv;
const code2 = arg === '-e' ? rest.shift() : undefined;
const filter = rest[0] ?? 'iPhone';
const body = arg === '-e' ? code2 : readFileSync(arg, 'utf8');
const targets = await (await fetch('http://localhost:8081/json/list')).json();
const target = targets.filter((t) => t.title.includes(filter)).at(-1);
if (!target)
  throw new Error(`no target ${JSON.stringify(targets.map((t) => t.title))}`);
const ws = new WebSocket(
  target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'),
  { headers: { Origin: 'http://127.0.0.1:8081' } }
);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) return pending.get(msg.id)(msg);
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    console.log(`[${msg.params.type}]`, text);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
const token = `__cdp${Date.now()}`;
const expression = `globalThis.${token} = undefined; (async () => { ${body} })().then(v => JSON.stringify(v ?? null, (k, x) => x instanceof Uint8Array ? Array.from(x) : x), e => 'ERROR ' + (e && (e.code ? e.code + ': ' : '') + (e && e.message))).then(r => { globalThis.${token} = r; }); 'started'`;
const started = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
});
if (started.result?.exceptionDetails) {
  console.log(
    'THROW',
    JSON.stringify(started.result.exceptionDetails).slice(0, 500)
  );
  process.exit(1);
}
const timeout = Number(process.env.TIMEOUT ?? 60000);
const begin = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 150));
  const res = await send('Runtime.evaluate', {
    expression: `globalThis.${token}`,
    returnByValue: true,
  });
  const value = res.result?.result?.value;
  if (value !== undefined) {
    console.log('RESULT', value);
    break;
  }
  if (Date.now() - begin > timeout) {
    console.log('TIMEOUT');
    break;
  }
}
ws.close();
process.exit(0);
