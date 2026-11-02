import mongoose from 'mongoose';
import { config } from './index';

export async function connectDatabase(): Promise<void> {
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[Database] MongoDB connected successfully to: ${config.MONGODB_URI}`);
  } catch (error) {
    console.error('[Database] MongoDB connection failed:', error);
    // Don't kill the process immediately if running in offline development mode
    if (config.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  mongoose.connection.on('error', (err) => {
    console.error('[Database] MongoDB runtime error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[Database] MongoDB disconnected. Waiting for reconnect...');
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  console.log('[Database] MongoDB disconnected gracefully.');
}

