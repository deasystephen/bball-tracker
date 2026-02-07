/**
 * Basketball-themed SVG illustrations for empty states
 */

import React from 'react';
import Svg, { Circle, Rect, Line, Path, G } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';

const SIZE = 120;

export const NoTeamsIllustration: React.FC = () => {
  const { colors } = useTheme();
  const stroke = colors.textTertiary;
  const accent = colors.accent;

  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 120 120">
      {/* Court outline */}
      <Rect x="10" y="20" width="100" height="80" rx="4" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Center line */}
      <Line x1="60" y1="20" x2="60" y2="100" stroke={stroke} strokeWidth="1" strokeDasharray="4,3" />
      {/* Center circle */}
      <Circle cx="60" cy="60" r="15" stroke={stroke} strokeWidth="1" fill="none" />
      {/* Dotted player outlines */}
      <Circle cx="35" cy="50" r="8" stroke={accent} strokeWidth="1.5" strokeDasharray="3,2" fill="none" />
      <Circle cx="85" cy="50" r="8" stroke={accent} strokeWidth="1.5" strokeDasharray="3,2" fill="none" />
      <Circle cx="35" cy="75" r="8" stroke={accent} strokeWidth="1.5" strokeDasharray="3,2" fill="none" />
      <Circle cx="85" cy="75" r="8" stroke={accent} strokeWidth="1.5" strokeDasharray="3,2" fill="none" />
    </Svg>
  );
};

export const NoGamesIllustration: React.FC = () => {
  const { colors } = useTheme();
  const stroke = colors.textTertiary;
  const accent = colors.accent;

  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 120 120">
      {/* Backboard */}
      <Rect x="35" y="10" width="50" height="30" rx="3" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Rim */}
      <Circle cx="60" cy="48" r="10" stroke={accent} strokeWidth="2" fill="none" />
      {/* Net lines */}
      <Line x1="52" y1="55" x2="48" y2="68" stroke={stroke} strokeWidth="1" />
      <Line x1="60" y1="58" x2="60" y2="70" stroke={stroke} strokeWidth="1" />
      <Line x1="68" y1="55" x2="72" y2="68" stroke={stroke} strokeWidth="1" />
      {/* Calendar */}
      <Rect x="25" y="78" width="70" height="32" rx="4" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Calendar header bar */}
      <Line x1="25" y1="88" x2="95" y2="88" stroke={stroke} strokeWidth="1" />
      {/* Calendar dots (empty) */}
      <Circle cx="40" cy="97" r="2" stroke={stroke} strokeWidth="1" fill="none" />
      <Circle cx="55" cy="97" r="2" stroke={stroke} strokeWidth="1" fill="none" />
      <Circle cx="70" cy="97" r="2" stroke={stroke} strokeWidth="1" fill="none" />
      <Circle cx="85" cy="97" r="2" stroke={stroke} strokeWidth="1" fill="none" />
    </Svg>
  );
};

export const NoStatsIllustration: React.FC = () => {
  const { colors } = useTheme();
  const stroke = colors.textTertiary;
  const accent = colors.accent;

  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 120 120">
      {/* Clipboard */}
      <Rect x="25" y="15" width="70" height="90" rx="6" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Clipboard clip */}
      <Rect x="45" y="10" width="30" height="12" rx="4" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Stat lines (blank) */}
      <Line x1="35" y1="40" x2="85" y2="40" stroke={stroke} strokeWidth="1.5" strokeDasharray="4,3" />
      <Line x1="35" y1="55" x2="75" y2="55" stroke={stroke} strokeWidth="1.5" strokeDasharray="4,3" />
      <Line x1="35" y1="70" x2="80" y2="70" stroke={stroke} strokeWidth="1.5" strokeDasharray="4,3" />
      <Line x1="35" y1="85" x2="65" y2="85" stroke={stroke} strokeWidth="1.5" strokeDasharray="4,3" />
      {/* Basketball accent */}
      <Circle cx="90" cy="95" r="12" stroke={accent} strokeWidth="1.5" fill="none" />
      <Path d="M82,87 Q90,95 82,103" stroke={accent} strokeWidth="1" fill="none" />
      <Path d="M98,87 Q90,95 98,103" stroke={accent} strokeWidth="1" fill="none" />
    </Svg>
  );
};

export const NoInvitationsIllustration: React.FC = () => {
  const { colors } = useTheme();
  const stroke = colors.textTertiary;
  const accent = colors.accent;

  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 120 120">
      {/* Mailbox body */}
      <Rect x="35" y="30" width="50" height="40" rx="4" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Mailbox flag */}
      <Line x1="85" y1="40" x2="95" y2="40" stroke={accent} strokeWidth="2" />
      <Line x1="95" y1="35" x2="95" y2="45" stroke={accent} strokeWidth="2" />
      {/* Mailbox post */}
      <Line x1="60" y1="70" x2="60" y2="100" stroke={stroke} strokeWidth="2" />
      {/* Base */}
      <Line x1="45" y1="100" x2="75" y2="100" stroke={stroke} strokeWidth="2" />
      {/* Net pattern on mailbox */}
      <Line x1="42" y1="38" x2="48" y2="55" stroke={stroke} strokeWidth="0.75" strokeDasharray="2,2" />
      <Line x1="52" y1="38" x2="52" y2="58" stroke={stroke} strokeWidth="0.75" strokeDasharray="2,2" />
      <Line x1="62" y1="38" x2="62" y2="58" stroke={stroke} strokeWidth="0.75" strokeDasharray="2,2" />
      <Line x1="72" y1="38" x2="68" y2="55" stroke={stroke} strokeWidth="0.75" strokeDasharray="2,2" />
      {/* Mailbox opening */}
      <Path d="M35,30 L60,18 L85,30" stroke={stroke} strokeWidth="1.5" fill="none" />
    </Svg>
  );
};

export const NoEventsIllustration: React.FC = () => {
  const { colors } = useTheme();
  const stroke = colors.textTertiary;
  const accent = colors.accent;

  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 120 120">
      {/* Mini court */}
      <Rect x="15" y="25" width="90" height="70" rx="4" stroke={stroke} strokeWidth="1.5" fill="none" />
      {/* Center line */}
      <Line x1="60" y1="25" x2="60" y2="95" stroke={stroke} strokeWidth="1" />
      {/* Center circle */}
      <Circle cx="60" cy="60" r="12" stroke={stroke} strokeWidth="1" fill="none" />
      {/* Basketball at center (tip-off) */}
      <Circle cx="60" cy="60" r="6" stroke={accent} strokeWidth="2" fill="none" />
      {/* Basketball seam lines */}
      <Line x1="54" y1="60" x2="66" y2="60" stroke={accent} strokeWidth="1" />
      <Path d="M60,54 Q63,60 60,66" stroke={accent} strokeWidth="1" fill="none" />
      {/* Arrow up (tip-off) */}
      <Path d="M60,42 L56,48 M60,42 L64,48" stroke={accent} strokeWidth="1.5" fill="none" />
      <Line x1="60" y1="42" x2="60" y2="50" stroke={accent} strokeWidth="1.5" />
    </Svg>
  );
};
