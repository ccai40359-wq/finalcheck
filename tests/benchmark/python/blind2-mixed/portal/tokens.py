import os

import jwt

KEY = os.environ["JWT_KEY"]  # SAFE: S3


def parse(token):
    return jwt.decode(token, KEY, algorithms=["HS256", "none"])  # EXPECT: S8 jwt-alg-none
