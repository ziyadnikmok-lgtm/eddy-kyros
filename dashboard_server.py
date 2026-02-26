#!/usr/bin/env python3
import os, json, base64, subprocess, uuid
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler

WORKSPACE = "/Users/admin/.openclaw/workspace"
UPLOAD_DIR = "/Users/admin/Downloads/IG POST SOFIA"
QUEUE_FILE = os.path.join(WORKSPACE, "social-reply-queue.json")
CONFIG_FILE = os.path.join(WORKSPACE, "social-reply-config.json")
CRON_TRIGGER_JOB = "b3058028-9070-4a65-baf6-9485d6e11adb"
CRON_JOBS = ["b3058028-9070-4a65-baf6-9485d6e11adb", "c31705b8-4d7e-4c1b-bf67-5d9fc69c5859"]
VIRAL_STATE = os.path.join(WORKSPACE, "viral-session.json")

os.makedirs(UPLOAD_DIR, exist_ok=True)


def jload(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, type(default)) else default
    except Exception:
        return default


def jsave(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_queue(): return jload(QUEUE_FILE, [])
def save_queue(items): jsave(QUEUE_FILE, items)


def sync_queue(items):
    by_url = {i.get("url"): i for i in items if i.get("url")}
    for job_id in CRON_JOBS:
        try:
            r = subprocess.run(["openclaw", "cron", "runs", "--id", job_id, "--limit", "20"], cwd=WORKSPACE, capture_output=True, text=True, timeout=30)
            if r.returncode != 0: continue
            data = json.loads(r.stdout or "{}")
            for e in data.get("entries", []):
                summary = e.get("summary") or ""
                src = rep = None
                for line in summary.splitlines():
                    line = line.strip()
                    if line.lower().startswith("- source url:"): src = line.split(":",1)[1].strip()
                    if line.lower().startswith("- reply url:"): rep = line.split(":",1)[1].strip()
                if src and src in by_url:
                    q = by_url[src]
                    q["lastRunAt"] = e.get("runAtMs")
                    if e.get("status") == "ok" and rep:
                        q["status"] = "done"; q["replyUrl"] = rep
                    elif e.get("status") != "ok":
                        q["status"] = q.get("status") or "queued"
                        q["lastError"] = e.get("error") or "run_error"
        except Exception:
            pass
    return items


class H(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        rel = path.split('?',1)[0].split('#',1)[0].lstrip('/') or 'dashboard.html'
        return os.path.join(WORKSPACE, rel)

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith('/api/list-images'):
            files=[]
            for n in sorted(os.listdir(UPLOAD_DIR)):
                p=os.path.join(UPLOAD_DIR,n)
                if os.path.isfile(p) and n.lower().endswith((".jpg",".jpeg",".png",".webp",".gif")): files.append({"name":n,"size":os.path.getsize(p)})
            return self._json(200,{"ok":True,"files":files,"dir":UPLOAD_DIR})
        if self.path.startswith('/api/list-queue'):
            q=sync_queue(load_queue()); save_queue(q); return self._json(200,{"ok":True,"items":q})
        if self.path.startswith('/api/viral-state'):
            return self._json(200,{"ok":True,"state":jload(VIRAL_STATE,{})})

        if self.path.startswith('/api/auto-reply-status'):
            cfg = jload(CONFIG_FILE, {})
            enabled = bool(cfg.get("autoReplyEnabled", False))
            return self._json(200, {"ok": True, "enabled": enabled, "jobs": CRON_JOBS})

        if self.path.startswith('/api/ops-hub'):
            q = load_queue()
            queued = [x for x in q if (x.get("status") or "queued") in ("queued", "processing")]
            done = [x for x in q if (x.get("status") or "") == "done"]
            viral = jload(VIRAL_STATE,{})
            state = jload(os.path.join(WORKSPACE, "social-reply-state.json"), {})
            last_attempt = (state.get("lastQueueAttempt") or {})

            # Simple "crew" model so user can see who is working on what.
            crew = [
                {
                    "name": "Jarvis",
                    "emoji": "🧠",
                    "role": "Mentor / Commander",
                    "status": "online",
                    "task": "Teaching crew and coordinating strategy"
                },
                {
                    "name": "Tony",
                    "emoji": "📮",
                    "role": "Posting Specialist",
                    "status": "busy" if queued else "idle",
                    "task": f"Posting queued URL: {queued[0].get('url')}" if queued else "At lounge, waiting for posting tasks"
                },
                {
                    "name": "Alex",
                    "emoji": "📈",
                    "role": "Viral Analyzer",
                    "status": "active" if viral.get("jobId") else "idle",
                    "task": f"Analyzing trends in job {viral.get('jobId')}" if viral.get("jobId") else "Studying engagement patterns"
                },
                {
                    "name": "Maya",
                    "emoji": "🛠️",
                    "role": "Automation Engineer",
                    "status": "working" if len(done) and len(queued) else "idle",
                    "task": "Optimizing queue flow + cleanup" if len(done) and len(queued) else "Improving workflows in background"
                }
            ]

            return self._json(200,{
                "ok":True,
                "summary": {
                    "queued": len(queued),
                    "done": len(done),
                    "lastAttempt": last_attempt
                },
                "crew": crew
            })
        if self.path.startswith('/uploads/'):
            safe = os.path.basename(self.path[len('/uploads/'):].split('?',1)[0])
            self.path = '/' + os.path.relpath(os.path.join(UPLOAD_DIR, safe), WORKSPACE)
            return super().do_GET()
        return super().do_GET()

    def do_POST(self):
        n=int(self.headers.get('Content-Length','0')); body=self.rfile.read(n).decode('utf-8') if n>0 else '{}'
        payload=json.loads(body or '{}') if body else {}

        if self.path.startswith('/api/upload-images'):
            up=[]
            for it in payload.get('files',[]):
                name=os.path.basename(str(it.get('name',''))); data=str(it.get('data',''))
                if not name.lower().endswith((".jpg",".jpeg",".png",".webp",".gif")): continue
                if ',' in data: data=data.split(',',1)[1]
                with open(os.path.join(UPLOAD_DIR,name),'wb') as f: f.write(base64.b64decode(data))
                up.append(name)
            return self._json(200,{"ok":True,"uploaded":up})

        if self.path.startswith('/api/delete-queue'):
            q = load_queue()
            qid = (payload.get('id') or '').strip()
            qurl = (payload.get('url') or '').strip()

            before = len(q)
            if qid:
                q = [x for x in q if (x.get('id') or '') != qid]
            elif qurl:
                # Backward compatibility: older queue rows may not have id
                removed = False
                new_q = []
                for x in q:
                    if not removed and (x.get('url') or '') == qurl:
                        removed = True
                        continue
                    new_q.append(x)
                q = new_q

            save_queue(q)
            return self._json(200,{"ok":True,"removed": before - len(q),"items":q})

        if self.path.startswith('/api/reply-now'):
            url=(payload.get('url') or '').strip(); img=(payload.get('image') or '').strip()
            valid = any(url.startswith(p) for p in ["https://x.com/","http://x.com/","https://twitter.com/","http://twitter.com/","https://mobile.twitter.com/","http://mobile.twitter.com/"])
            if not valid: return self._json(400,{"ok":False,"error":"valid X/Twitter post URL required"})

            item={"id":str(uuid.uuid4()),"url":url,"createdAt":datetime.now(timezone.utc).isoformat(),"status":"queued"}
            if img: item["imagePath"]=os.path.join(UPLOAD_DIR, os.path.basename(img))

            q=load_queue()
            # Keep queue fresh: drop older queued/processing duplicates for the same URL.
            q=[x for x in q if not ((x.get("url") or "")==url and (x.get("status") or "queued") in ("queued","processing"))]
            # Prioritize newest manual request first.
            q.insert(0, item)
            save_queue(q)

            # Trigger immediate processing. If multiple queued items exist, run a short burst
            # so it doesn't stop after only one item.
            queued_count = sum(1 for x in q if (x.get("status") or "queued") in ("queued", "processing"))
            burst_runs = min(max(queued_count, 1), 4)
            last_out = ""
            last_err = ""
            for _ in range(burst_runs):
                run=subprocess.run(["openclaw","cron","run",CRON_TRIGGER_JOB],cwd=WORKSPACE,capture_output=True,text=True,timeout=120)
                last_out = (run.stdout or '')[-1000:]
                last_err = (run.stderr or '')[-500:]
                # Stop burst early on command error.
                if run.returncode != 0:
                    break

            return self._json(200,{"ok":True,"queued":item,"burstRuns":burst_runs,"cronOut":last_out,"cronErr":last_err})

        if self.path.startswith('/api/start-viral-session'):
            # Create temporary 2h / 5m sprint
            msg=(
                "Task: For the next run, find a likely-viral X post (safe, high-engagement), reply with one image from configured image folder, "
                "short flirty engaging caption (non-explicit), and return source+reply URLs."
            )
            add=subprocess.run(["openclaw","cron","add","--name","viral-sprint-2h","--every","5m","--session","isolated","--no-deliver","--message",msg],cwd=WORKSPACE,capture_output=True,text=True,timeout=120)
            if add.returncode!=0: return self._json(500,{"ok":False,"error":add.stderr or add.stdout})
            data=json.loads(add.stdout or '{}'); jid=data.get('id')
            subprocess.Popen(["/bin/sh","-lc",f"sleep 7200; openclaw cron rm {jid} >/dev/null 2>&1"],cwd=WORKSPACE)
            jsave(VIRAL_STATE,{"jobId":jid,"startedAt":datetime.now(timezone.utc).isoformat(),"endsInMinutes":120})
            return self._json(200,{"ok":True,"jobId":jid})

        if self.path.startswith('/api/auto-reply-toggle'):
            enabled = bool(payload.get("enabled", False))
            errs = []
            for jid in CRON_JOBS:
                cmd = ["openclaw", "cron", "enable" if enabled else "disable", jid]
                r = subprocess.run(cmd, cwd=WORKSPACE, capture_output=True, text=True, timeout=60)
                if r.returncode != 0:
                    errs.append((jid, (r.stderr or r.stdout or "unknown")[-240:]))
            cfg = jload(CONFIG_FILE, {})
            cfg["autoReplyEnabled"] = enabled
            jsave(CONFIG_FILE, cfg)
            if errs:
                return self._json(500, {"ok": False, "enabled": enabled, "errors": errs})
            return self._json(200, {"ok": True, "enabled": enabled})

        return self._json(404,{"ok":False,"error":"not found"})


if __name__=='__main__':
    HTTPServer(('127.0.0.1',8765),H).serve_forever()
