#!/usr/bin/env node
/**
 * Docker HEALTHCHECK: GET https://127.0.0.1:$DOD_PORT/healthz inside the container.
 * It talks to its own process over the loopback interface, so it does not verify the
 * certificate (which is issued for the public host name). Exit 0 healthy, 1 not.
 */
import { get } from 'node:https';

const port = Number(process.env.DOD_PORT ?? '8443');
const request = get(
  { host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 3000 },
  (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  },
);
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('error', () => {
  process.exitCode = 1;
});
