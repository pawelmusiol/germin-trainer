import request from 'supertest';
import { createApp } from '../app';

describe('App Health Endpoint', () => {
  const app = createApp();

  it('GET /health returns 200 with status ok and metadata', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('service', 'garmin-trainer-server');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta.defaultDistance).toBe('10K');
  });
});
