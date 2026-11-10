const express = require('express');

const auth = (req, res, next) => next();

const app = express();
const router = express.Router();

router.use('/api', auth);
router.get('/api/users', (req, res) => res.json([]));
router.get('/open', (req, res) => res.json({}));

app.use(router);

app.listen(3000);
