import React, { ReactNode } from 'react';
import { useHasFeature } from '../store/entitlements-store';
import { UpgradePrompt } from './UpgradePrompt';
import { Feature, SubscriptionTier } from '../../shared/types';

interface FeatureGateProps {
  feature: Feature;
  requiredTier: SubscriptionTier;
  featureDescription?: string;
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Declarative component that shows children if the user has access to a feature,
 * or renders a fallback (defaulting to UpgradePrompt) if they don't.
 */
export function FeatureGate({
  feature,
  requiredTier,
  featureDescription,
  fallback,
  children,
}: FeatureGateProps) {
  const hasAccess = useHasFeature(feature);

  if (hasAccess) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <UpgradePrompt
      requiredTier={requiredTier}
      featureDescription={featureDescription}
    />
  );
}
