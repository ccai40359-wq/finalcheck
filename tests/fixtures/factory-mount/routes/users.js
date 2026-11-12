const express = require('express');

function makeUsersRouter() {
  const r = express.Router();
  const requireAuth = (req, res, next) => req.user ? next() : res.sendStatus(401);
  r.get('/:id', requireAuth, (req, res) => res.json({}));
  r.post('/', (req, res) => res.json({}));
  return r;
}

module.exports = { makeUsersRouter };
