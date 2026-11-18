from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class Order(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, nullable=False, index=True)
    total = db.Column(db.Numeric(10, 2), nullable=False)

    def to_dict(self):
        return {"id": self.id, "user_id": self.user_id, "total": str(self.total)}
