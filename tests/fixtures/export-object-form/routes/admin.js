const express = require('express');

const router = express.Router();
const ensureLoggedIn = (req, res, next) => next();

router.get('/dashboard', ensureLoggedIn, (req, res) => res.json({}));

module.exports = { router };
