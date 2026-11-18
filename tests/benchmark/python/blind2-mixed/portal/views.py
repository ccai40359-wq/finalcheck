import hashlib
import subprocess
import xml.etree.ElementTree as ET

import requests
from flask import Flask, jsonify, request
from flask.views import MethodView
from flask_login import current_user, login_required

from .store import Document, db

app = Flask(__name__)


class DocumentAPI(MethodView):
    decorators = [login_required]

    def get(self, doc_id):
        doc = db.session.get(Document, doc_id)  # EXPECT: S7 idor-no-owner
        return jsonify(title=doc.title)

    def delete(self, doc_id):
        doc = Document.query.filter_by(id=doc_id, owner_id=current_user.id).first_or_404()  # SAFE: S7
        db.session.delete(doc)
        db.session.commit()
        return "", 204


class AdminStats(MethodView):  # EXPECT: S1 unauth-admin
    def get(self):
        return jsonify(users=db.session.execute(db.text("select count(*) from users")).scalar())


app.add_url_rule("/docs/<int:doc_id>", view_func=DocumentAPI.as_view("doc"))
app.add_url_rule("/admin/stats", view_func=AdminStats.as_view("admin_stats"))


@app.post("/import/xml")
@login_required
def import_xml():
    root = ET.fromstring(request.data)  # EXPECT: S2 xxe
    return jsonify(n=len(root))


@app.get("/thumb")
@login_required
def thumb():
    name = request.args["name"]
    subprocess.Popen("convert %s -resize 64x64 /tmp/t.png" % name, shell=True)  # EXPECT: S2 cmdi
    return "ok"


@app.get("/mirror")
@login_required
def mirror():
    r = requests.get("https://cdn.example.com/feed.json", verify=False, timeout=5)  # EXPECT: S2 tls-verify-off
    return r.text


@app.post("/legacy-login")
def legacy_login():
    digest = hashlib.new("md5", request.form["password"].encode()).hexdigest()  # EXPECT: S8 weak-password-hash
    return {"ok": digest == "x"}


@app.get("/search")
@login_required
def search():
    q = request.args.get("q", "")
    rows = db.session.execute(db.text(f"select id from documents where title like '%{q}%'"))  # EXPECT: S2 sqli
    return jsonify([r.id for r in rows])
