#!/usr/bin/env python3
"""
Ingest strategy videos: download → transcribe with Whisper → extract metadata via Gemini → upsert.

Runs automatically from auto-trader every 10 min (strategy_videos with null video_heading).

Usage:
  python scripts/ingest_video.py <url>                    # Single URL
  python scripts/ingest_video.py --from-queue              # Process strategy_video_queue (done items)
  python scripts/ingest_video.py --from-strategy-videos    # Process strategy_videos where video_heading is null

Requires: pip install -r scripts/requirements.txt
  (yt-dlp, faster-whisper, requests)

Env: SUPABASE_URL, SUPABASE_ANON_KEY (from auto-trader .env)
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Add project root for imports if needed
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

INSTAGRAM_REEL = re.compile(
    r"instagram\.com/(?:([^/]+)/)?reel/([A-Za-z0-9_-]+)",
    re.I,
)
TWITTER_STATUS = re.compile(
    r"(?:twitter|x)\.com/(?:[^/]+/)?status/(\d+)",
    re.I,
)
YOUTUBE = re.compile(
    r"(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})",
    re.I,
)


def parse_url(url: str) -> dict | None:
    """Return {platform, video_id, handle?} or None."""
    url = url.strip()
    m = INSTAGRAM_REEL.search(url)
    if m:
        return {"platform": "instagram", "video_id": m.group(2), "handle": m.group(1)}
    m = TWITTER_STATUS.search(url)
    if m:
        return {"platform": "twitter", "video_id": m.group(1)}
    m = YOUTUBE.search(url)
    if m:
        return {"platform": "youtube", "video_id": m.group(1)}
    return None


def download_audio(url: str, out_path: str, cookies_file: str | None = None) -> str | None:
    """Download audio from URL using yt-dlp. Returns path to downloaded file or None on failure."""
    # Use python -m yt_dlp so it works when run from venv (yt-dlp may not be in PATH)
    # Use m4a to avoid ffmpeg dependency (Instagram DASH is often m4a; faster-whisper accepts it)
    base = out_path.replace(".wav", "").replace(".m4a", "")
    out_template = base + ".%(ext)s"
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-x",
        "--audio-format",
        "m4a",
        "-o",
        out_template,
        "--no-playlist",
        url,
    ]
    if cookies_file and os.path.isfile(cookies_file):
        cmd.extend(["--cookies", cookies_file])
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120, text=True)
        if result.returncode != 0:
            err = (result.stderr or "").strip() or (result.stdout or "").strip()
            print(f"[ingest] yt-dlp failed: {err[:500] if err else result.returncode}")
            return None
        # yt-dlp outputs base.m4a (or base.m4a from DASH)
        for ext in ("m4a", "webm", "mp3", "opus"):
            p = base + "." + ext
            if os.path.isfile(p):
                return p
        return None
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"[ingest] yt-dlp failed: {e}")
        return None


def transcribe(audio_path: str) -> str:
    """Transcribe audio. Uses Groq Whisper API if GROQ_API_KEY set, else faster-whisper."""
    groq_key = os.environ.get("GROQ_API_KEY")
    if groq_key:
        return _transcribe_groq(audio_path, groq_key)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[ingest] Install: pip install faster-whisper, or set GROQ_API_KEY for API transcribe")
        sys.exit(1)
    model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, language="en", beam_size=1)
    text = " ".join(s.text for s in segments if s.text).strip()
    return text or ""


def _transcribe_groq(audio_path: str, api_key: str) -> str:
    """Transcribe via Groq Whisper API (lighter for serverless)."""
    import requests
    ext = os.path.splitext(audio_path)[1].lower()
    mime = {"m4a": "audio/mp4", "mp3": "audio/mpeg", "wav": "audio/wav", "webm": "audio/webm"}.get(ext, "audio/mp4")
    with open(audio_path, "rb") as f:
        files = {"file": (os.path.basename(audio_path), f, mime)}
        resp = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files=files,
            data={"model": "whisper-large-v3-turbo", "response_format": "text"},
            timeout=60,
        )
    resp.raise_for_status()
    return (resp.text or "").strip()


def set_ingest_status(
    supabase_url: str,
    supabase_key: str,
    video_id: str,
    platform: str,
    status: str,
    error: str | None = None,
) -> None:
    """Update ingest_status for a strategy_video row."""
    import requests

    url = f"{supabase_url}/rest/v1/strategy_videos"
    params = {"video_id": f"eq.{video_id}", "platform": f"eq.{platform}"}
    body = {"ingest_status": status}
    if error is not None:
        body["ingest_error"] = error[:500] if len(error) > 500 else error
    resp = requests.patch(
        url,
        params=params,
        json=body,
        headers={
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        timeout=10,
    )
    resp.raise_for_status()


def call_extract(
    supabase_url: str,
    supabase_key: str,
    video_id: str,
    platform: str,
    transcript: str,
    reel_url: str | None = None,
    canonical_url: str | None = None,
) -> dict:
    """Call extract-strategy-metadata-from-transcript edge function."""
    import requests

    url = f"{supabase_url.rstrip('/')}/functions/v1/extract-strategy-metadata-from-transcript"
    payload = {
        "video_id": video_id,
        "platform": platform,
        "transcript": transcript,
        "reel_url": reel_url,
        "canonical_url": canonical_url,
    }
    resp = requests.post(
        url,
        json=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {supabase_key}",
        },
        timeout=60,
    )
    if resp.status_code >= 400:
        try:
            err_body = resp.json()
            err_msg = err_body.get("error", err_body.get("message", resp.text[:200]))
        except Exception:
            err_msg = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
        raise RuntimeError(f"Extract {resp.status_code}: {err_msg}")
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="Ingest strategy video: download, transcribe, extract metadata")
    parser.add_argument("url", nargs="?", help="Video URL (Instagram, YouTube, Twitter)")
    parser.add_argument("--from-queue", action="store_true", help="Process strategy_video_queue done items")
    parser.add_argument("--from-strategy-videos", action="store_true", help="Process strategy_videos with null video_heading")
    parser.add_argument("--cookies", default="", help="Path to cookies file for Instagram")
    parser.add_argument("--dry-run", action="store_true", help="Skip download/transcribe, only show what would run")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL", os.environ.get("VITE_SUPABASE_URL"))
    supabase_key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("VITE_SUPABASE_ANON_KEY")
    )
    if not supabase_url or not supabase_key:
        print("[ingest] Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)")
        sys.exit(1)

    urls_to_process: list[dict] = []

    if args.url:
        parsed = parse_url(args.url)
        if not parsed:
            print(f"[ingest] Invalid URL: {args.url}")
            sys.exit(1)
        urls_to_process.append({"url": args.url.strip(), **parsed})
    elif args.from_queue or args.from_strategy_videos:
        try:
            import requests
        except ImportError:
            print("[ingest] Install: pip install requests")
            sys.exit(1)

        if args.from_strategy_videos:
            resp = requests.get(
                f"{supabase_url}/rest/v1/strategy_videos",
                params={
                    "video_heading": "is.null",
                    "status": "eq.tracked",
                    "select": "video_id,platform,reel_url,canonical_url",
                },
                headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"},
                timeout=10,
            )
            resp.raise_for_status()
            rows = resp.json()
            for r in rows:
                url = r.get("reel_url") or r.get("canonical_url") or ""
                if url:
                    parsed = parse_url(url)
                    if parsed:
                        urls_to_process.append({"url": url, **parsed})
        else:
            resp = requests.get(
                f"{supabase_url}/rest/v1/strategy_video_queue",
                params={"status": "eq.done", "select": "url"},
                headers={"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"},
                timeout=10,
            )
            resp.raise_for_status()
            rows = resp.json()
            for r in rows:
                url = r.get("url", "")
                if url:
                    parsed = parse_url(url)
                    if parsed:
                        urls_to_process.append({"url": url, **parsed})

        if not urls_to_process:
            print("[ingest] No URLs to process")
            return
    else:
        parser.print_help()
        sys.exit(1)

    cookies = args.cookies.strip() or None

    for item in urls_to_process:
        url = item["url"]
        platform = item["platform"]
        video_id = item["video_id"]
        print(f"\n[ingest] {platform}/{video_id}")

        if args.dry_run:
            print(f"  Would process: {url}")
            continue

        try:
            set_ingest_status(supabase_url, supabase_key, video_id, platform, "transcribing")
        except Exception as e:
            print(f"  Warning: could not set transcribing status: {e}")

        with tempfile.TemporaryDirectory() as tmp:
            audio_path = os.path.join(tmp, "audio")
            downloaded = download_audio(url, audio_path, cookies)
            if not downloaded:
                print("  Skip: download failed")
                try:
                    set_ingest_status(supabase_url, supabase_key, video_id, platform, "failed", "Download failed")
                except Exception:
                    pass
                continue

            transcript = transcribe(downloaded)
            if not transcript:
                print("  Skip: empty transcript")
                try:
                    set_ingest_status(supabase_url, supabase_key, video_id, platform, "failed", "Empty transcript")
                except Exception:
                    pass
                continue

            print(f"  Transcript length: {len(transcript)} chars")

            reel_url = url if platform == "instagram" else None
            canonical_url = url if platform != "instagram" else None

            try:
                result = call_extract(
                    supabase_url,
                    supabase_key,
                    video_id,
                    platform,
                    transcript,
                    reel_url=reel_url,
                    canonical_url=canonical_url,
                )
                print(f"  OK: {result.get('extracted', {})}")
            except Exception as e:
                print(f"  Extract failed: {e}")
                try:
                    set_ingest_status(supabase_url, supabase_key, video_id, platform, "failed", str(e))
                except Exception:
                    pass


if __name__ == "__main__":
    main()
