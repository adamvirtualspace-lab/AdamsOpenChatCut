// Minimal MCP-over-HTTP client for the local OpenChatCut server.
// Usage: node mcp.mjs '<toolName>' '<jsonArgs>' [more tool/args pairs...]
const URL_ = 'http://localhost:5199/api/external-mcp/mcp';
let sid = '';
let id = 0;

async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sid) headers['mcp-session-id'] = sid;
  const res = await fetch(URL_, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (!sid && res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  // Responses come back as SSE frames; pull the data payload out.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) return { raw: text };
  return JSON.parse(line.slice(6));
}

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-code', version: '1.0' },
  });
  // notifications/initialized carries no id and expects no body back.
  await fetch(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const args = JSON.parse(argv[i + 1] ?? '{}');
    const out = await rpc('tools/call', { name, arguments: args });
    const content = out.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(out);
    console.log(`\n===== ${name} =====`);
    console.log(content.slice(0, 2500));
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
