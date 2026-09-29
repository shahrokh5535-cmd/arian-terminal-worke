import http from "node:http";

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200);
    return res.end(JSON.stringify({
      service: "arian-terminal-worker",
      status: "ok",
      version: "0.1.0",
      started_at: startedAt,
      now: new Date().toISOString()
    }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`ARIAN TERMINAL worker listening on :${port}`);
});
