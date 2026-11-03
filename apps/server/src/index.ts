import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const app = createApp();

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] Garmin AI Trainer API listening on http://${HOST}:${PORT} (LAN: http://192.168.1.11:${PORT})`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('[server] Process terminated gracefully');
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    console.log('[server] Process interrupted, shutting down');
  });
});
