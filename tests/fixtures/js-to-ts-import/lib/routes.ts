import { Router } from 'express';

const router = Router();
const requireAuth = (req: { user?: unknown }, res: { sendStatus(code: number): void }, next: () => void) => req.user ? next() : res.sendStatus(401);

router.get('/data', requireAuth, (req, res) => res.json({}));

export default router;
