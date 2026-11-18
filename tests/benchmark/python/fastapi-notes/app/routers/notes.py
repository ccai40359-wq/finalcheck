from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..db import Note, get_db

router = APIRouter(prefix="/notes")


@router.get("/")
def list_notes(user=Depends(get_current_user), db: Session = Depends(get_db)):  # SAFE: S1
    return db.query(Note).filter(Note.owner_id == user["id"]).all()


@router.get("/{note_id}")
def read_note(note_id: int, user=Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(Note).get(note_id)  # EXPECT: S7 idor-no-owner


@router.get("/{note_id}/safe")
def read_note_safe(note_id: int, user=Depends(get_current_user), db: Session = Depends(get_db)):
    note = db.query(Note).filter(Note.id == note_id, Note.owner_id == user["id"]).first()  # SAFE: S7
    if not note:
        raise HTTPException(404)
    return note


@router.get("/search/raw")
def search_raw(q: str, user=Depends(get_current_user), db: Session = Depends(get_db)):
    return db.execute(text(f"SELECT id, text FROM notes WHERE text LIKE '%{q}%'")).fetchall()  # EXPECT: S2 sqli


@router.get("/search/safe")
def search_safe(q: str, user=Depends(get_current_user), db: Session = Depends(get_db)):
    return db.execute(text("SELECT id, text FROM notes WHERE text LIKE :q"), {"q": f"%{q}%"}).fetchall()  # SAFE: S2


@router.delete("/purge")  # EXPECT: S1 unauth-delete
def purge_all(db: Session = Depends(get_db)):
    db.query(Note).delete()
    db.commit()
    return {"ok": True}


@router.post("/calc")
def calc(expr: str, user=Depends(get_current_user)):
    return {"result": eval(expr)}  # EXPECT: S2 code-injection
