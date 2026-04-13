import { Router } from 'express';
import authRoutes from './auth/routes';
import gameRoutes from './games/routes';
import teamRoutes from './teams/routes';
import teamCalendarRoutes from './teams/calendar';
import leagueRoutes from './leagues/routes';
import seasonRoutes from './seasons/routes';
import playerRoutes from './players/routes';
import invitationRoutes from './invitations/routes';
import statsRoutes from './stats/routes';
import uploadRoutes from './uploads/routes';
import sentryTestRoutes from './__sentry_test';

const router = Router();

// API routes
router.use('/auth', authRoutes);
router.use('/games', gameRoutes);
// Calendar routes must be mounted before `/teams` so the public GET
// /teams/:id/calendar.ics (token-auth) bypasses the authenticate middleware
// used by the main teams router.
router.use('/teams', teamCalendarRoutes);
router.use('/teams', teamRoutes);
router.use('/leagues', leagueRoutes);
router.use('/seasons', seasonRoutes);
router.use('/players', playerRoutes);
router.use('/invitations', invitationRoutes);
router.use('/stats', statsRoutes);
router.use('/uploads', uploadRoutes);
router.use('/', sentryTestRoutes);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

