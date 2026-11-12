const express = require('express');

const router = express.Router();
const ensureLoggedIn = (req, res, next) => req.user ? next() : res.sendStatus(401);

router.get('/dashboard', ensureLoggedIn, (req, res) => res.json({}));

module.exports = { router };
