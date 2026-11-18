import hashlib
import os
import secrets
import subprocess
import urllib.request
from hashlib import sha1

from flask import Blueprint, abort, g, jsonify, redirect, request, send_from_directory

from .auth import token_required
from .models import Invoice, User, db

bp = Blueprint("api", __name__)
PDF_DIR = "/srv/billing/pdfs"
PAYMENT_API_SECRET = "pay-prod-7c1e9a4f2b8d6e0a3c5f7b9d1e2a4c6f8b0d"  # EXPECT: S3 hardcoded-secret


@bp.get("/invoices/<int:invoice_id>")
@token_required
def invoice(invoice_id):  # SAFE: S1
    inv = Invoice.query.filter_by(id=invoice_id).first_or_404()  # EXPECT: S7 idor-no-owner
    return jsonify(id=inv.id, amount=str(inv.amount))


@bp.get("/invoices/<int:invoice_id>/checked")
@token_required
def invoice_checked(invoice_id):
    inv = Invoice.query.get_or_404(invoice_id)
    if inv.user_id != g.user.id:  # SAFE: S7
        abort(403)
    return jsonify(id=inv.id, amount=str(inv.amount))


@bp.get("/invoices/<path:name>/pdf")
@token_required
def invoice_pdf(name):
    with open(os.path.join(PDF_DIR, name), "rb") as fh:  # EXPECT: S2 path-traversal
        return fh.read()


@bp.get("/invoices/<path:name>/pdf-safe")
@token_required
def invoice_pdf_safe(name):
    return send_from_directory(PDF_DIR, name)  # SAFE: S2


@bp.get("/users/lookup")
@token_required
def lookup():
    uid = request.args.get("id")
    rows = db.session.execute("SELECT email FROM user WHERE id = {}".format(uid))  # EXPECT: S2 sqli
    by_mail = db.session.execute("SELECT id FROM user WHERE email = '%s'" % request.args["email"])  # EXPECT: S2 sqli
    return jsonify([r[0] for r in rows] + [r[0] for r in by_mail])


@bp.post("/invoices/<int:invoice_id>/render")
@token_required
def render(invoice_id):
    fmt = request.json["format"]
    os.system(f"wkhtmltopdf /tmp/{invoice_id}.html /tmp/{invoice_id}.{fmt}")  # EXPECT: S2 cmdi
    rev = subprocess.check_output(["git", "rev-parse", "HEAD"], timeout=5)  # SAFE: S2
    return {"rev": rev.decode()}


@bp.post("/webhooks/register")
@token_required
def register_webhook():
    target = request.json.get("callback")
    urllib.request.urlopen(target, timeout=5)  # EXPECT: S2 ssrf
    return {"ok": True}


@bp.get("/login/done")
def login_done():
    return redirect(request.args.get("next", "/"))  # EXPECT: S2 open-redirect


@bp.get("/echo")
def echo():
    return f"<p>{request.args['msg']}</p>"  # EXPECT: S2 xss


@bp.post("/signup")
def signup():
    pw = request.json["password"]
    user = User(email=request.json["email"], pw_hash=sha1(pw.encode()).hexdigest())  # EXPECT: S8 weak-password-hash
    db.session.add(user)
    db.session.commit()
    return {"id": user.id, "api_token": secrets.token_urlsafe(32)}  # SAFE: S3


@bp.get("/catalog/etag")
def catalog_etag():
    return {"etag": hashlib.sha256(open("catalog.json", "rb").read()).hexdigest()}  # SAFE: S8
