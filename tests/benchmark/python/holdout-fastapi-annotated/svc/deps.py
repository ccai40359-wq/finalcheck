from typing import Annotated

from fastapi import Depends, HTTPException, Header
from sqlmodel import Session, create_engine

engine = create_engine("sqlite:///svc.db")


def get_session():
    with Session(engine) as session:
        yield session


def get_current_user(authorization: Annotated[str, Header()]):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401)
    return {"id": 1}


SessionDep = Annotated[Session, Depends(get_session)]
CurrentUser = Annotated[dict, Depends(get_current_user)]
