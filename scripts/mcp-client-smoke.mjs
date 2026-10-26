import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/mcp/forreyra-server.ts'],
});
const client = new Client({ name: 'forge-smoke', version: '1.0.0' });
await client.connect(transport);
console.log('connected to:', client.getServerVersion()?.name);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const res = await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com' } });
console.log('open ok:', !res.isError);
console.log(res.content[0].text.split('\ntext:')[0]);
await client.callTool({ name: 'browser_close', arguments: {} });
await client.close();
console.log('OFFICIAL CLIENT OK');
