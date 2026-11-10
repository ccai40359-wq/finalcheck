import express from 'express';
import router from './api.js';

const app = express();

app.use(router);

app.listen(3000);
