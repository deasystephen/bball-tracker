class Expo {
  static isExpoPushToken(token) {
    return typeof token === 'string' && token.startsWith('ExponentPushToken[');
  }
  chunkPushNotifications(messages) {
    return [messages];
  }
  async sendPushNotificationsAsync(messages) {
    return messages.map(() => ({ status: 'ok', id: 'mock-receipt-id' }));
  }
  chunkPushNotificationReceiptIds(ids) {
    return [ids];
  }
  async getPushNotificationReceiptsAsync(ids) {
    return Object.fromEntries(ids.map((id) => [id, { status: 'ok' }]));
  }
}

module.exports = { Expo };
