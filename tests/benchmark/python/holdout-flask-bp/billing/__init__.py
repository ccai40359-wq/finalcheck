import os

from flask import Flask
from flask_cors import CORS


def create_app():
    app = Flask(__name__)
    app.config.from_mapping(SECRET_KEY=os.environ["SECRET_KEY"])  # SAFE: S3
    CORS(app, resources={r"/api/*": {"origins": "*"}})  # EXPECT: S5 cors-wildcard
    from .api import bp as api_bp

    app.register_blueprint(api_bp, url_prefix="/api")
    return app


if __name__ == "__main__":
    create_app().run(debug=os.environ.get("FLASK_DEBUG") == "1")  # SAFE: S5
