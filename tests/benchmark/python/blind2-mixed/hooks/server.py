import hashlib
import hmac
import os

from aiohttp import web

SECRET = os.environ["HOOK_SECRET"].encode()


async def github_hook(request):  # SAFE: S6
    body = await request.read()
    sig = request.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(SECRET, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise web.HTTPForbidden()
    return web.json_response({"ok": True})


async def admin_reset(request):  # EXPECT: S1 unauth-admin
    return web.json_response({"reset": True})


app = web.Application()
app.add_routes([web.post("/hooks/github", github_hook), web.post("/admin/reset", admin_reset)])
