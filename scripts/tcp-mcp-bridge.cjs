// TCP -> stdio bridge for QMD MCP server
// Each TCP connection spawns a fresh qmd process and pipes stdio
// NOTE: default index is symlinked to confidential index
const net = require("net");
const { spawn } = require("child_process");

const PORT = 7334;
const QMD = "/opt/homebrew/bin/qmd";

const server = net.createServer((socket) => {
  const child = spawn(QMD, ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("close", () => socket.end());
  child.on("error", () => socket.end());
  socket.on("close", () => { try { child.kill(); } catch {} });
  socket.on("error", () => { try { child.kill(); } catch {} });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TCP MCP bridge on port ${PORT} (default index -> confidential)`);
});
