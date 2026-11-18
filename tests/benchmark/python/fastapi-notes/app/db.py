import os

from sqlalchemy import Column, ForeignKey, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

engine = create_engine(os.environ.get("DATABASE_URL", "sqlite:///notes.db"))
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class Note(Base):
    __tablename__ = "notes"
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey("users.id"), index=True)
    text = Column(String)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
