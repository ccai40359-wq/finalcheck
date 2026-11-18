import hashlib
import os
import pickle
import sqlite3
import subprocess

import bcrypt
import requests
import yaml
from flask import Flask, abort, jsonify, render_template, render_template_string, request, send_file, send_from_directory
from flask_cors import CORS
from flask_login import current_user, login_required
from werkzeug.utils import secure_filename

from .models import Order, db

app = Flask(__name__)
app.config["SECRET_KEY"] = "flask-shop-prod-secret-9f8e7d6c5b4a"  # EXPECT: S3 hardcoded-secret
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///shop.db")  # SAFE: S3
STRIPE_KEY = os.environ["STRIPE_SECRET_KEY"]  # SAFE: S3
CORS(app, origins="*", supports_credentials=True)  # EXPECT: S5 cors-wildcard
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")


def get_db():
    return sqlite3.connect("shop.db")


@app.route("/health")
def health():
    return {"ok": True}


@app.route("/admin/users")  # EXPECT: S1 unauth-admin
def admin_list_users():
    rows = get_db().execute("SELECT id, email FROM users").fetchall()
    return jsonify(rows)


@app.route("/api/orders")
@login_required
def list_orders():  # SAFE: S1
    orders = Order.query.filter_by(user_id=current_user.id).all()
    return jsonify([o.to_dict() for o in orders])


@app.route("/api/orders/<int:order_id>")
@login_required
def get_order(order_id):
    order = Order.query.get(order_id)  # EXPECT: S7 idor-no-owner
    return jsonify(order.to_dict())


@app.route("/api/orders/<int:order_id>/safe")
@login_required
def get_order_safe(order_id):
    order = Order.query.filter_by(id=order_id, user_id=current_user.id).first_or_404()  # SAFE: S7
    return jsonify(order.to_dict())


@app.route("/api/search")
@login_required
def search():
    name = request.args.get("q", "")
    cur = get_db().cursor()
    cur.execute(f"SELECT id, name FROM products WHERE name LIKE '%{name}%'")  # EXPECT: S2 sqli
    return jsonify(cur.fetchall())


@app.route("/api/search/safe")
@login_required
def search_safe():
    name = request.args.get("q", "")
    cur = get_db().cursor()
    cur.execute("SELECT id, name FROM products WHERE name LIKE ?", (f"%{name}%",))  # SAFE: S2
    return jsonify(cur.fetchall())


@app.route("/api/ping")
@login_required
def ping():
    host = request.args["host"]
    out = subprocess.run(f"ping -c 1 {host}", shell=True, capture_output=True)  # EXPECT: S2 cmdi
    return out.stdout


@app.route("/api/ping/safe")
@login_required
def ping_safe():
    host = request.args["host"]
    out = subprocess.run(["ping", "-c", "1", host], capture_output=True, timeout=5)  # SAFE: S2
    return out.stdout


@app.route("/api/files")
@login_required
def download():
    name = request.args["f"]
    return send_file(os.path.join(UPLOAD_DIR, name))  # EXPECT: S2 path-traversal


@app.route("/api/files/safe")
@login_required
def download_safe():
    name = secure_filename(request.args["f"])
    return send_from_directory(UPLOAD_DIR, name)  # SAFE: S2


@app.route("/hello")
def hello():
    name = request.args.get("name", "guest")
    return render_template_string("<h1>Hello " + name + "</h1>")  # EXPECT: S2 ssti


@app.route("/hello/safe")
def hello_safe():
    name = request.args.get("name", "guest")
    return render_template("hello.html", name=name)  # SAFE: S2


@app.route("/api/cart/import", methods=["POST"])
@login_required
def import_cart():
    cart = pickle.loads(request.data)  # EXPECT: S2 deserialization
    return jsonify(cart)


@app.route("/api/config/import", methods=["POST"])
@login_required
def import_config():
    cfg = yaml.load(request.data)  # EXPECT: S2 yaml-load
    safe = yaml.safe_load(request.data)  # SAFE: S2
    return jsonify({"cfg": cfg, "safe": safe})


@app.route("/api/preview")
@login_required
def preview():
    url = request.args["url"]
    r = requests.get(url, timeout=5)  # EXPECT: S2 ssrf
    return r.text


@app.route("/api/rates")
@login_required
def rates():
    r = requests.get("https://api.exchangerate.example.com/latest", timeout=5)  # SAFE: S2
    return r.json()


@app.route("/api/register", methods=["POST"])
def register():
    pw = request.json["password"]
    weak = hashlib.md5(pw.encode()).hexdigest()  # EXPECT: S8 weak-password-hash
    strong = bcrypt.hashpw(pw.encode(), bcrypt.gensalt())  # SAFE: S8
    return {"weak": weak, "strong": strong.decode()}


@app.route("/api/files/etag")
@login_required
def etag():
    data = open(os.path.join(UPLOAD_DIR, "catalog.json"), "rb").read()
    return {"etag": hashlib.md5(data, usedforsecurity=False).hexdigest()}  # SAFE: S8


@app.route("/api/admin/delete/<int:order_id>", methods=["POST"])
@login_required
def admin_delete(order_id):
    if not current_user.is_admin:
        abort(403)
    db.session.delete(Order.query.get_or_404(order_id))  # SAFE: S7
    db.session.commit()
    return {"ok": True}


if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=True)  # EXPECT: S5 debug-mode
