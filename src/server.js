// Entry point: load configuration, start listening, shut down cleanly.

import http from 'node:http';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { log } from './log.js';

// Railway's edge keeps idle connections for up to 60 seconds. Holding them a
// little longer on this side means the edge, not the gateway, is the one that
// closes them, so a request never arrives on a connection that is going away.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

function fatal(message, fields) {
  // Write the line fully before exiting so it is not cut off.
  process.stdout.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`, () => process.exit(1));
}

process.on('uncaughtException', (err) => fatal('Uncaught exception, exiting', { stack: err?.stack ?? String(err) }));
process.on('unhandledRejection', (reason) => fatal('Unhandled promise rejection, exiting', { stack: reason?.stack ?? String(reason) }));

function start(config) {
  for (const warning of config.warnings) log('warn', warning);

  const app = createApp(config);
  let shuttingDown = false;

  const server = http.createServer({ keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS }, (req, res) => {
    // During shutdown, tell the client not to reuse this connection...
    if (shuttingDown) res.setHeader('connection', 'close');
    // ...and close connections whose response was already under way as soon
    // as that response is done. Otherwise each would sit idle for the whole
    // keep-alive timeout and hold the process open with nothing left to do.
    res.on('close', () => {
      if (shuttingDown) server.closeIdleConnections();
    });
    app(req, res);
  });

  server.on('error', (err) => fatal(`Could not listen on port ${config.port}: ${err.message}`));

  // No host given: Node listens on every interface, IPv4 and IPv6, which is
  // what Railway's public and private networking both expect.
  server.listen(config.port, () => {
    log('info', `Gateway listening on port ${config.port}`, {
      port: config.port,
      model: config.model,
      upstream: config.baseUrl,
      gatewayKeys: config.gatewayKeys.length,
    });
  });

  // Railway sends SIGTERM when a newer deployment takes over, then SIGKILL
  // once the service's draining time is up. Stop taking new connections and
  // let requests that are in flight finish.
  const shutDown = (signal) => {
    if (shuttingDown) {
      fatal(`${signal} received again, exiting immediately`);
      return;
    }
    shuttingDown = true;
    log('info', `${signal} received: finishing in-flight requests, then exiting`);
    server.close(() => log('info', 'All requests finished. Exiting.'));
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutDown('SIGTERM'));
  process.on('SIGINT', () => shutDown('SIGINT'));
}

let config = null;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  for (const problem of err.problems) log('error', `Configuration problem: ${problem}`);
  log('error', 'The gateway did not start. Fix the variables listed above, then redeploy.');
  // Setting the exit code (rather than exiting right here) lets the lines
  // above reach the log first.
  process.exitCode = 1;
}

if (config) start(config);
