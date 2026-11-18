import base64
import hashlib
import os
import pickle
import subprocess

from fastapi import FastAPI, HTTPException
from sqlmodel import Field, SQLModel

from .deps import CurrentUser, SessionDep

app = FastAPI()


class Item(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    owner_id: int
    name: str


@app.get("/items/{item_id}")
def read_item(item_id: int, user: CurrentUser, session: SessionDep):  # SAFE: S1
    return session.get(Item, item_id)  # EXPECT: S7 idor-no-owner


@app.get("/items/{item_id}/checked")
def read_item_checked(item_id: int, user: CurrentUser, session: SessionDep):
    item = session.get(Item, item_id)
    if item is None or item.owner_id != user["id"]:  # SAFE: S7
        raise HTTPException(404)
    return item


@app.delete("/items/{item_id}")  # EXPECT: S1 unauth-delete  # EXPECT: S7 idor-no-owner
def delete_item(item_id: int, session: SessionDep):
    session.delete(session.get(Item, item_id))
    session.commit()
    return {"ok": True}


@app.get("/tools/dns")
def dns(domain: str, user: CurrentUser):
    out = subprocess.check_output("nslookup " + domain, shell=True, timeout=5)  # EXPECT: S2 cmdi
    return {"out": out.decode()}


@app.post("/session/restore")
def restore(blob: str, user: CurrentUser):
    state = pickle.loads(base64.b64decode(blob))  # EXPECT: S2 deserialization
    return {"keys": list(state)}


@app.post("/password/hash")
def hash_pw(password: str, user: CurrentUser):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310000)  # SAFE: S8
    return {"hash": dk.hex(), "salt": salt.hex()}


@app.get("/fetch")
def fetch(url: str, user: CurrentUser):
    import httpx

    return httpx.get(url, timeout=5).text  # EXPECT: S2 ssrf
