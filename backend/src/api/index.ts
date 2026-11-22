import { Router } from 'express';
import authRoutes from './auth/routes';
import gameRoutes from './games/routes';
import teamRoutes from './teams/routes';
import teamCalendarRoutes from './teams/calendar';
import leagueRoutes from './leagues/routes';
import seasonRoutes from './seasons/routes';
import playerRoutes from './players/routes';
import invitationPublicRoutes from './invitations/public-routes';
import invitationRoutes from './invitations/routes';
import joinRoutes from './join/routes';
import statsRoutes from './stats/routes';
import uploadRoutes from './uploads/routes';
import adminRoutes from './admin/routes';
import announcementRoutes from './announcements/routes';
import { practiceRouter, practiceSeriesRouter } from './practices/routes';

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
// Public by-token routes must be mounted before the auth-protected invitation
// router so token-based lookups bypass the authenticate middleware.
router.use('/invitations', invitationPublicRoutes);
router.use('/invitations', invitationRoutes);
// Team join links by token (#210): a public preview and an authenticated
// request; the router applies `authenticate` per route.
router.use('/join', joinRoutes);
router.use('/stats', statsRoutes);
router.use('/uploads', uploadRoutes);
router.use('/admin', adminRoutes);
router.use('/announcements', announcementRoutes);
router.use('/practices', practiceRouter);
router.use('/practice-series', practiceSeriesRouter);

router.get('/', (_req, res) => {
  res.json({ message: 'API v1' });
});

export default router;

