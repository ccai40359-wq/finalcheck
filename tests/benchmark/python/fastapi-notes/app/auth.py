import os

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer

oauth2 = OAuth2PasswordBearer(tokenUrl="/token")
JWT_SECRET = os.environ["JWT_SECRET"]  # SAFE: S3


def get_current_user(token: str = Depends(oauth2)):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])  # SAFE: S8
    except jwt.PyJWTError:
        raise HTTPException(status_code=401)


def get_user_unverified(token: str = Depends(oauth2)):
    return jwt.decode(token, options={"verify_signature": False})  # EXPECT: S8 jwt-no-verify
