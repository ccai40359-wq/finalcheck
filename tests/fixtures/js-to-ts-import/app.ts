import express from 'express';
import router from './lib/routes.js';

const app = express();

app.use('/lib', router);

app.listen(3000);
