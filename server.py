#!/usr/bin/env python3
"""Local server for SDF CAD: serves app/ and keeps project files in progetti/, so Salva can overwrite
the same file from any browser. Usage: python3 server.py [port]"""
import json
import os
import re
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
PROJECTS = ROOT / 'progetti'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
NAME = re.compile(r'^[^./\\\x00-\x1f][^/\\\x00-\x1f]{0,150}\.json$', re.IGNORECASE)   # a plain file name, no folders
MAX_SIZE = 512 * 1024 * 1024
HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP), **kwargs)

    def log_message(self, *args):
        pass

    def allowed(self):
        # Only the editor's own page may use the API: refuse other websites (Origin) and DNS rebinding (Host).
        origin = self.headers.get('Origin')
        return self.headers.get('Host') in HOSTS and (origin is None or origin in {'http://' + h for h in HOSTS})

    def project_path(self):
        name = unquote(urlparse(self.path).path[len('/api/projects/'):])
        return PROJECTS / name if NAME.match(name) else None

    def reply(self, code, body=b'{}'):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return super().do_GET()
        if not self.allowed():
            return self.reply(403)
        if path == '/api/projects':
            PROJECTS.mkdir(exist_ok=True)
            files = [(p, p.stat()) for p in PROJECTS.glob('*.json') if p.is_file() and NAME.match(p.name)]
            files.sort(key=lambda f: f[1].st_mtime, reverse=True)
            listing = [{'name': p.name, 'modified': s.st_mtime, 'size': s.st_size} for p, s in files]
            return self.reply(200, json.dumps(listing).encode())
        if path.startswith('/api/projects/'):
            p = self.project_path()
            if p is None:
                return self.reply(400)
            return self.reply(200, p.read_bytes()) if p.is_file() else self.reply(404)
        self.reply(404)

    def do_PUT(self):
        if not urlparse(self.path).path.startswith('/api/projects/') or not self.allowed():
            return self.reply(403)
        p = self.project_path()
        length = int(self.headers.get('Content-Length') or 0)
        if p is None:
            return self.reply(400)
        if length > MAX_SIZE:
            return self.reply(413)
        data = self.rfile.read(length)
        try:
            json.loads(data)
        except ValueError:
            return self.reply(400)
        # Write a temporary file and swap it in, so a crash mid-save never leaves half a project.
        PROJECTS.mkdir(exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=PROJECTS, prefix='.salvataggio-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o644)   # mkstemp makes it private
            os.replace(tmp, p)
        except OSError:
            os.unlink(tmp)
            return self.reply(500)
        self.reply(200)


if __name__ == '__main__':
    print(f'SDF CAD su http://127.0.0.1:{PORT}/  (progetti in {PROJECTS})')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
