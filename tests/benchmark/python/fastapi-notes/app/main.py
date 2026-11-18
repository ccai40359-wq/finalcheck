from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import notes

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://notes.example.com"],  # SAFE: S5
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
)
app.include_router(notes.router)


@app.get("/healthz")
def healthz():
    return {"ok": True}
