#!/usr/bin/env python3
import os
import json
import cgi
from http.server import HTTPServer, SimpleHTTPRequestHandler

WORKSPACE = "/Users/admin/.openclaw/workspace"
UPLOAD_DIR = "/Users/admin/Downloads/IG POST SOFIA"

os.makedirs(UPLOAD_DIR, exist_ok=True)

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Serve files from workspace root
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

        if self.path.startswith('/uploads/'):
            name = self.path[len('/uploads/'):].split('?',1)[0]
            safe = os.path.basename(name)
            self.path = '/' + os.path.relpath(os.path.join(UPLOAD_DIR, safe), WORKSPACE)
            return super().do_GET()

        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/upload-images'):
            ctype, pdict = cgi.parse_header(self.headers.get('content-type'))
            if ctype != 'multipart/form-data':
                return self._json(400, {"ok": False, "error": "multipart/form-data required"})
            pdict['boundary'] = bytes(pdict['boundary'], 'utf-8')
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={'REQUEST_METHOD':'POST'}, keep_blank_values=True)

            uploaded = []
            fields = form['files'] if 'files' in form else []
            if not isinstance(fields, list):
                fields = [fields]

            for item in fields:
                if not getattr(item, 'filename', None):
                    continue
                filename = os.path.basename(item.filename)
                if not filename.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
                    continue
                dst = os.path.join(UPLOAD_DIR, filename)
                with open(dst, 'wb') as f:
                    f.write(item.file.read())
                uploaded.append(filename)

            return self._json(200, {"ok": True, "uploaded": uploaded, "dir": UPLOAD_DIR})

        return self._json(404, {"ok": False, "error": "not found"})

if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', 8765), Handler)
    print('Dashboard server running at http://127.0.0.1:8765')
    server.serve_forever()
