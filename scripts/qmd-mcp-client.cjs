// QMD MCP client - bridges stdio to TCP MCP bridge on host
const net = require("net");
const c = net.createConnection(7334, "host.docker.internal", () => {
  process.stdin.pipe(c);
  c.pipe(process.stdout);
});
c.on("error", (e) => {
  process.stderr.write("qmd-mcp-client error: " + e.message + "\n");
  process.exit(1);
});
c.on("close", () => process.exit(0));
