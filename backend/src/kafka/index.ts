/**
 * Kafka producer and consumer setup
 */

// Kafka configuration and setup will be implemented here

export const kafkaConfig = {
  clientId: process.env.KAFKA_CLIENT_ID || 'bball-tracker-backend',
  brokers: process.env.KAFKA_BROKERS?.split(',') || [],
};

