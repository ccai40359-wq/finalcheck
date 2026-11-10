const bcrypt = require('bcrypt');
const express = require('express');
const db = require('./db');
const app = express();

async function verifyLogin(name, pw) {
  const user = await db.findUser(name);
  return bcrypt.compare(pw, user.passwordHash);
}

app.post('/login', (req, res) => {
  res.cookie('sid', req.sessionID, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

module.exports = app;
