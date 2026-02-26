#!/usr/bin/env python3
import os
import json
import base64
import subprocess
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler

WORKSPACE = "/Users/admin/.openclaw/workspace"
UPLOAD_DIR = "/Users/admin/Downloads/IG POST SOFIA"
QUEUE_FILE = os.path.join(WORKSPACE, "social-reply-queue.json")
CRON_TRIGGER_JOB = "b3058028-9070-4a65-baf6-9485d6e11adb"

os.makedirs(UPLOAD_DIR, exist_ok=True)


def load_queue():
    if not os.path.exists(QUEUE_FILE):
        return []
    try:
        with open(QUEUE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def save_queue(items):
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split('?', 1)[0].split('#', 1)[0]
        rel = path.lstrip('/') or 'dashboard.html'
        return os.path.join(WORKSPACE, rel)

    def _json(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/api/list-images'):
            try:
                files = []
                for name in sorted(os.listdir(UPLOAD_DIR)):
                    p = os.path.join(UPLOAD_DIR, name)
                    if os.path.isfile(p) and name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
                        files.append({"name": name, "size": os.path.getsize(p)})
                return self._json(200, {"ok": True, "dir": UPLOAD_DIR, "files": files})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        if self.path.startswith('/api/list-queue'):
            return self._json(200, {"ok": True, "items": load_queue()})

        if self.path.startswith('/uploads/'):
            name = self.path[len('/uploads/'):].split('?', 1)[0]
            safe = os.path.basename(name)
            self.path = '/' + os.path.relpath(os.path.join(UPLOAD_DIR, safe), WORKSPACE)
            return super().do_GET()

        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/upload-images'):
            try:
                n = int(self.headers.get('Content-Length', '0'))
                body = self.rfile.read(n).decode('utf-8') if n > 0 else '{}'
                payload = json.loads(body or '{}')
                files = payload.get('files', [])
                uploaded = []
                for item in files:
                    name = os.path.basename(str(item.get('name', '')))
                    data = str(item.get('data', ''))
                    if not name.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
                        continue
                    if ',' in data:
                        data = data.split(',', 1)[1]  # data URL
                    raw = base64.b64decode(data)
                    with open(os.path.join(UPLOAD_DIR, name), 'wb') as f:
                        f.write(raw)
                    uploaded.append(name)
                return self._json(200, {"ok": True, "uploaded": uploaded, "dir": UPLOAD_DIR})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        if self.path.startswith('/api/reply-now'):
            try:
                n = int(self.headers.get('Content-Length', '0'))
                body = self.rfile.read(n).decode('utf-8') if n > 0 else '{}'
                payload = json.loads(body or '{}')
                url = (payload.get('url') or '').strip()
                if not (url.startswith('https://x.com/') or url.startswith('http://x.com/')):
                    return self._json(400, {"ok": False, "error": "Please provide a valid x.com post URL"})

                items = load_queue()
                item = {"url": url, "createdAt": datetime.now(timezone.utc).isoformat(), "status": "queued"}
                items.append(item)
                save_queue(items)

                run = subprocess.run(
                    ["openclaw", "cron", "run", CRON_TRIGGER_JOB],
                    cwd=WORKSPACE,
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                return self._json(200, {
                    "ok": True,
                    "queued": item,
                    "triggeredJob": CRON_TRIGGER_JOB,
                    "cronExit": run.returncode,
                    "cronOut": (run.stdout or '')[-1200:],
                    "cronErr": (run.stderr or '')[-1200:]
                })
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        return self._json(404, {"ok": False, "error": "not found"})


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', 8765), Handler)
    print('Dashboard server running at http://127.0.0.1:8765')
    server.serve_forever()
