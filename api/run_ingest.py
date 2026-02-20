"""
Vercel serverless function: run transcript ingest for strategy videos.
Triggered when user adds videos — no auto-trader needed.

Env (set in Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY, GROQ_API_KEY
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Project root (parent of api/)
ROOT = Path(__file__).resolve().parent.parent


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
            supabase_key = (
                os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
                or os.environ.get("SUPABASE_ANON_KEY")
                or os.environ.get("VITE_SUPABASE_ANON_KEY")
            )
            if not supabase_url or not supabase_key:
                self._send(400, {"error": "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or ANON_KEY) in Vercel env"})
                return

            script = ROOT / "scripts" / "ingest_video.py"
            if not script.exists():
                self._send(500, {"error": "ingest_video.py not found"})
                return

            env = {**os.environ, "SUPABASE_URL": supabase_url, "SUPABASE_ANON_KEY": supabase_key}
            if os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
                env["SUPABASE_SERVICE_ROLE_KEY"] = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

            result = subprocess.run(
                [sys.executable, str(script), "--from-strategy-videos"],
                env=env,
                capture_output=True,
                text=True,
                timeout=55,
                cwd=str(ROOT),
            )
            if result.returncode != 0:
                self._send(200, {"ok": True, "ran": True, "stderr": (result.stderr or "")[:500]})
            else:
                self._send(200, {"ok": True, "ran": True})
        except subprocess.TimeoutExpired:
            self._send(200, {"ok": True, "ran": True, "timeout": True})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def _send(self, status, body):
        self.send_response(status)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))
