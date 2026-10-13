/* Serves this folder (calibrate.html) on http://localhost:3199 — and on the Mac's LAN address for a phone. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const port = Number(process.env.PORT || 3199);
http
  .createServer((req, res) => {
    const file = path.join(HERE, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "calibrate.html");
    if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    const type = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp4": "video/mp4" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "0.0.0.0", () => console.log(`serving ${HERE} on :${port}`));
