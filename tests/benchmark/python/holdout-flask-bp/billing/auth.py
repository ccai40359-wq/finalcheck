import functools

import jwt
from flask import abort, current_app, g, request

from .models import User


def token_required(view):
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        try:
            claims = jwt.decode(token, current_app.config["SECRET_KEY"], algorithms=["HS256"])
        except jwt.PyJWTError:
            abort(401)
        g.user = User.query.get_or_404(claims["sub"])
        return view(*args, **kwargs)

    return wrapper
