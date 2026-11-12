const express = require('express');

const router = express.Router();
const requireAuth = (req, res, next) => req.user ? next() : res.sendStatus(401);

router.get('/:id', requireAuth, (req, res) => res.json({}));
router.post('/', (req, res) => res.json({}));

module.exports = router;
