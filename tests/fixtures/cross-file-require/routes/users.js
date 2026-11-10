const express = require('express');

const router = express.Router();
const requireAuth = (req, res, next) => next();

router.get('/:id', requireAuth, (req, res) => res.json({}));
router.post('/', (req, res) => res.json({}));

module.exports = router;
