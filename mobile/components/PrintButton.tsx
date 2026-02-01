/**
 * Print button component (web only)
 * Triggers browser print dialog and injects print-friendly styles
 */

import React, { useEffect } from 'react';
import { Platform, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from './ThemedText';
import { useTheme } from '../hooks/useTheme';
import { spacing } from '../theme';

interface PrintButtonProps {
  title?: string;
  showLabel?: boolean;
}

const PRINT_STYLES = `
@media print {
  /* Hide navigation and non-essential elements */
  .hide-on-print,
  [data-hide-on-print="true"],
  nav,
  header,
  footer,
  button:not([data-print-show="true"]) {
    display: none !important;
  }

  /* Reset backgrounds and colors for printing */
  body {
    background: white !important;
    color: black !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Optimize tables for print */
  table, .box-score-table {
    font-size: 10pt !important;
    page-break-inside: avoid;
  }

  /* Ensure stats are readable */
  .stats-container {
    page-break-inside: avoid;
  }

  /* Remove shadows and borders that don't print well */
  * {
    box-shadow: none !important;
  }

  /* Ensure proper page margins */
  @page {
    margin: 0.5in;
  }
}
`;

export const PrintButton: React.FC<PrintButtonProps> = ({
  title = 'Print',
  showLabel = true,
}) => {
  const { colors } = useTheme();

  // Only render on web
  if (Platform.OS !== 'web') {
    return null;
  }

  // Inject print styles on mount
  useEffect(() => {
    if (Platform.OS === 'web') {
      const styleId = 'print-styles';
      let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;

      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        styleEl.textContent = PRINT_STYLES;
        document.head.appendChild(styleEl);
      }

      return () => {
        // Don't remove styles on unmount as other PrintButtons may need them
      };
    }
  }, []);

  const handlePrint = () => {
    if (Platform.OS === 'web') {
      window.print();
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePrint}
      style={[styles.button, { borderColor: colors.border }]}
      activeOpacity={0.7}
      // @ts-ignore - web-specific prop
      data-print-show="true"
    >
      <Ionicons name="print-outline" size={20} color={colors.primary} />
      {showLabel && (
        <ThemedText variant="body" color="primary" style={styles.label}>
          {title}
        </ThemedText>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing.xs,
  },
  label: {
    marginLeft: spacing.xs,
  },
});
