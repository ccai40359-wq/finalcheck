import { Router } from 'express';

const router = Router();
const requireAuth = (req: unknown, res: unknown, next: () => void) => next();

router.get('/data', requireAuth, (req, res) => res.json({}));

export default router;
