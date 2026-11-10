const express = require('express');

const router = express.Router();
const verifyToken = (req, res, next) => next();

router.get('/info', verifyToken, (req, res) => res.json({}));

export default router;
