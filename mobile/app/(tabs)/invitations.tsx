/**
 * Invitations list screen - View and manage team invitations
 */

import React from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ThemedView, ThemedText, Card, LoadingSpinner, EmptyState, ErrorState, Button } from '../../components';
import { useToast } from '../../components/Toast';
import { usePlayerInvitations, useAcceptInvitation, useRejectInvitation, type TeamInvitation } from '../../hooks/useInvitations';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { spacing } from '../../theme';
import { getHorizontalPadding } from '../../utils/responsive';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../store/auth-store';

export default function InvitationsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const padding = getHorizontalPadding();
  const { user, accessToken } = useAuthStore();

  const {
    data: invitationsData,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = usePlayerInvitations('PENDING');

  const acceptInvitation = useAcceptInvitation();
  const rejectInvitation = useRejectInvitation();
  const toast = useToast();

  const invitations = invitationsData?.invitations || [];

  const handleAccept = async (invitation: TeamInvitation) => {
    try {
      await acceptInvitation.mutateAsync(invitation.id);
      toast.showToast(`You've been added to ${invitation.team.name}!`, 'success');
    } catch (error) {
      toast.showToast(
        error instanceof Error ? error.message : 'Failed to accept invitation',
        'error'
      );
    }
  };

  const handleReject = (invitation: TeamInvitation) => {
    Alert.alert(
      'Reject Invitation',
      `Reject invitation from ${invitation.team.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            try {
              await rejectInvitation.mutateAsync(invitation.id);
              toast.showToast('Invitation rejected', 'success');
            } catch (error) {
              toast.showToast(
                error instanceof Error ? error.message : 'Failed to reject invitation',
                'error'
              );
            }
          },
        },
      ]
    );
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING':
        return colors.warning;
      case 'ACCEPTED':
        return colors.success;
      case 'REJECTED':
        return colors.error;
      case 'EXPIRED':
        return colors.textTertiary;
      default:
        return colors.textTertiary;
    }
  };

  const formatExpirationDate = (expiresAt: string) => {
    const date = new Date(expiresAt);
    const now = new Date();
    const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return 'Expired';
    } else if (diffDays === 0) {
      return 'Expires today';
    } else if (diffDays === 1) {
      return 'Expires tomorrow';
    } else {
      return `Expires in ${diffDays} days`;
    }
  };

  const renderInvitation = ({ item }: { item: TeamInvitation }) => {
    const isExpired = new Date(item.expiresAt) < new Date();
    const isPending = item.status === 'PENDING';
    const canAccept = isPending && !isExpired;
    const canReject = isPending; // Can always reject pending invitations

    return (
      <Card variant="elevated" style={styles.invitationCard}>
        <View style={styles.invitationHeader}>
          <View style={styles.invitationInfo}>
            <ThemedText variant="h4">{item.team.name}</ThemedText>
            <ThemedText variant="caption" color="textSecondary">
              {item.team.season.league.name} - {item.team.season.name}
            </ThemedText>
          </View>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: getStatusColor(item.status) + '20' },
            ]}
          >
            <ThemedText
              variant="captionBold"
              style={{ color: getStatusColor(item.status) }}
            >
              {item.status}
            </ThemedText>
          </View>
        </View>

        {item.message && (
          <ThemedText variant="body" color="textSecondary" style={styles.message}>
            {item.message}
          </ThemedText>
        )}

        <View style={styles.invitationDetails}>
          <View style={styles.detailRow}>
            <Ionicons name="person-outline" size={16} color={colors.textTertiary} />
            <ThemedText variant="caption" color="textSecondary">
              Invited by {item.invitedBy.name}
            </ThemedText>
          </View>
          {item.jerseyNumber && (
            <View style={styles.detailRow}>
              <Ionicons name="shirt-outline" size={16} color={colors.textTertiary} />
              <ThemedText variant="caption" color="textSecondary">
                Jersey #{item.jerseyNumber}
              </ThemedText>
            </View>
          )}
          {item.position && (
            <View style={styles.detailRow}>
              <Ionicons name="location-outline" size={16} color={colors.textTertiary} />
              <ThemedText variant="caption" color="textSecondary">
                {item.position}
              </ThemedText>
            </View>
          )}
          <View style={styles.detailRow}>
            <Ionicons name="time-outline" size={16} color={colors.textTertiary} />
            <ThemedText variant="caption" color="textSecondary">
              {formatExpirationDate(item.expiresAt)}
            </ThemedText>
          </View>
        </View>

        {__DEV__ && (
          <View style={styles.debugBlock}>
            <ThemedText variant="captionBold" color="textSecondary" selectable>
              Debug
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" selectable>
              invitationId: {item.id}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" selectable>
              playerId: {item.playerId}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" selectable>
              invitedById: {item.invitedById}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" selectable>
              expiresAt: {item.expiresAt}
            </ThemedText>
            <ThemedText variant="caption" color="textTertiary" selectable>
              deviceNow: {new Date().toISOString()}
            </ThemedText>
            <ThemedText variant="caption" color={isExpired ? 'error' : 'success'} selectable>
              isExpired: {String(isExpired)} | canAccept: {String(canAccept)}
            </ThemedText>
          </View>
        )}

        {isPending && (
          <View style={styles.actionButtons}>
            {canAccept && (
              <Button
                title="Accept"
                onPress={() => handleAccept(item)}
                loading={acceptInvitation.isPending}
                style={styles.acceptButton}
                fullWidth
              />
            )}
            {isExpired && (
              <ThemedText variant="caption" color="error" style={styles.expiredText}>
                This invitation has expired
              </ThemedText>
            )}
            <Button
              title="Reject"
              variant="outline"
              onPress={() => handleReject(item)}
              loading={rejectInvitation.isPending}
              style={styles.rejectButton}
              fullWidth
            />
          </View>
        )}
      </Card>
    );
  };

  if (isLoading) {
    return <LoadingSpinner message={t('common.loading')} fullScreen />;
  }

  if (error) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Failed to load invitations'}
        onRetry={refetch}
      />
    );
  }

  const renderDebugCard = () => {
    if (!__DEV__) {
      return null;
    }

    const deviceTime = new Date().toISOString();

    return (
      <Card variant="default" style={styles.debugCard}>
        <ThemedText variant="captionBold" color="textSecondary" selectable>
          Debug
        </ThemedText>
        <View style={styles.debugRow}>
          <ThemedText variant="caption" color="textTertiary" selectable>
            currentUserId
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" selectable>
            {user?.id ?? 'none'}
          </ThemedText>
        </View>
        <View style={styles.debugRow}>
          <ThemedText variant="caption" color="textTertiary" selectable>
            email
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" selectable>
            {user?.email ?? 'none'}
          </ThemedText>
        </View>
        <View style={styles.debugRow}>
          <ThemedText variant="caption" color="textTertiary" selectable>
            role
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" selectable>
            {user?.role ?? 'none'}
          </ThemedText>
        </View>
        <View style={styles.debugRow}>
          <ThemedText variant="caption" color="textTertiary" selectable>
            token
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" selectable>
            {accessToken ? `${accessToken.slice(0, 8)}...` : 'none'}
          </ThemedText>
        </View>
        <View style={styles.debugRow}>
          <ThemedText variant="caption" color="textTertiary" selectable>
            deviceTime
          </ThemedText>
          <ThemedText variant="caption" color="textSecondary" selectable>
            {deviceTime}
          </ThemedText>
        </View>
      </Card>
    );
  };

  if (invitations.length === 0) {
    return (
      <ThemedView variant="background" style={styles.container}>
        <View style={[styles.header, { paddingHorizontal: padding }]}>
          <ThemedText variant="h1">Invitations</ThemedText>
        </View>
        {renderDebugCard()}
        <EmptyState
          icon="mail-outline"
          title="No Invitations"
          message="You don't have any pending invitations"
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView variant="background" style={styles.container}>
      <View style={[styles.header, { paddingHorizontal: padding }]}>
        <ThemedText variant="h1">Invitations</ThemedText>
        <ThemedText variant="caption" color="textSecondary">
          {invitations.length} {invitations.length === 1 ? 'invitation' : 'invitations'}
        </ThemedText>
      </View>
      <View style={{ paddingHorizontal: padding }}>{renderDebugCard()}</View>

      <FlatList
        data={invitations}
        renderItem={renderInvitation}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingHorizontal: padding,
            paddingTop: spacing.md,
          },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  debugCard: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  debugBlock: {
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  debugRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  invitationCard: {
    marginBottom: spacing.md,
  },
  invitationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  invitationInfo: {
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 4,
    marginLeft: spacing.sm,
  },
  message: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    fontStyle: 'italic',
  },
  invitationDetails: {
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actionButtons: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  acceptButton: {
    marginBottom: 0,
  },
  rejectButton: {
    marginTop: 0,
  },
  expiredText: {
    marginTop: spacing.sm,
    textAlign: 'center',
  },
});
