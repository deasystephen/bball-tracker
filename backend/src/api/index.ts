import { Router } from 'express';
import authRoutes from './auth/routes';

const router = Router();

// API routes
router.use('/auth', authRoutes);
// Example: router.use('/games', gameRoutes);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

