const express = require('express');

const auth = (req, res, next) => req.user ? next() : res.sendStatus(401);

const app = express();
const router = express.Router();

router.route('/items').get(auth, (req, res) => res.json([])).post((req, res) => res.json({}));
router.route('/things/:id').put((req, res) => res.json({}));

app.use(router);

app.listen(3000);
