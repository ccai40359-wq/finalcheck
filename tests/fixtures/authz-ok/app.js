const express = require('express');
const db = require('./db');
const app = express();

app.get('/users/:id', (req, res) => {
  const user = db.users.findOne({ id: req.params.id, userId: req.user.id });
  res.json(user);
});

app.put('/users/:id', (req, res) => {
  db.users.update({ where: { id: req.params.id, ownerId: req.user.id } }, req.body);
  res.json({ ok: true });
});

app.post('/notes', (req, res) => {
  db.notes.create({ data: { text: req.body.text, user_id: req.user.id } });
  res.json({ ok: true });
});

module.exports = app;
