from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Document(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, index=True)
    title = db.Column(db.String)
