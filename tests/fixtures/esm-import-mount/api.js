const express = require('express');

const router = express.Router();
const verifyToken = (req, res, next) => req.user ? next() : res.sendStatus(401);

router.get('/info', verifyToken, (req, res) => res.json({}));

export default router;
