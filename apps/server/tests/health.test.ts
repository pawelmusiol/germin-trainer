import request from 'supertest';
import { createApp } from '../src/app';

describe('Server Health Test', () => {
  const app = createApp();

  it('verifies server is operational and returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('garmin-trainer-server');
  });
});
