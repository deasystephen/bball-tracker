import { Router } from 'express';

const router = Router();

// API routes will be registered here
// Example: router.use('/auth', authRoutes);
// Example: router.use('/games', gameRoutes);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

