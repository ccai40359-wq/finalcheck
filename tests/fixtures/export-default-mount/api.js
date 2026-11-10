const express = require('express');

const router = express.Router();

router.get('/alive', (req, res) => res.json({ ok: true }));

export default router;
