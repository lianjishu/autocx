"""本地收集器：接收浏览器页面 POST 过来的抓包结果，落盘为文件。

用法：python server.py 8777
页面侧：fetch('http://127.0.0.1:8777/up?name=xxx', {method:'POST', mode:'no-cors', body: text})
"""
import http.server
import socketserver
import sys
import urllib.parse
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "captured")
os.makedirs(OUT, exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        name = (qs.get("name") or ["unnamed"])[0]
        name = "".join(c for c in name if c.isalnum() or c in "._-") or "unnamed"
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        path = os.path.join(OUT, name + ".txt")
        with open(path, "wb") as f:
            f.write(body)
        print(f"[up] {name}: {len(body)} bytes -> {path}", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/plain;charset=utf-8")
        self.end_headers()
        self.wfile.write(b"ok " + str(len(body)).encode())

    def log_message(self, fmt, *args):
        print("[http] " + (fmt % args), flush=True)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
        print(f"collector on http://127.0.0.1:{port}  (POST /up?name=xxx)", flush=True)
        httpd.serve_forever()