"""极简静态服务：带 CORS，供在线页面 fetch 本地测试资产。

用法：python cors_server.py 8778
"""
import http.server
import os
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".bin": "application/octet-stream",
    ".ttf": "font/ttf",
}


def say(msg):
    # stdout 被宿主关掉时不要炸：日志写失败不能反过来把请求搞挂
    try:
        print(msg, flush=True)
    except Exception:
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path).lstrip("/")
        fp = os.path.join(ROOT, path)
        if not os.path.isfile(fp):
            self._send(404, b"not found")
            return
        ctype = TYPES.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
        with open(fp, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        name = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", ["x"])[0]
        name = "".join(c for c in name if c.isalnum() or c in "._-") or "x"
        out = os.path.join(ROOT, "captured")
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, name + ".txt"), "wb") as f:
            f.write(body)
        say(f"[post] {name}: {len(body)}B")
        self._send(200, b"ok")

    def log_message(self, fmt, *args):
        say("[http] " + (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8778
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler) as srv:
        say(f"cors server on http://127.0.0.1:{port}  root={ROOT}")
        srv.serve_forever()
