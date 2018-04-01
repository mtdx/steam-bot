#!/usr/bin/env node

import * as pgPromise from 'pg-promise';
import * as pgMonitor from 'pg-monitor';
import * as Logger from 'bunyan';
import { scheduleJob } from 'node-schedule';

import { Instance } from './Instance';
import { Config } from './interfaces';

const pgpOptions = {};

const db = pgPromise(pgpOptions)({
  host: process.env.STEAMBOT_DB_HOST || 'localhost',
  user: process.env.STEAMBOT_DB_USER || 'steambot',
  password: process.env.STEAMBOT_DB_PASSWORD || 'password',
  database: process.env.STEAMBOT_DB_DATABASE || 'steambot'
});

const config: Config = {
  account_name: process.env.STEAMBOT_TRADE_BOT_ACCOUNT_NAME,
  account_password: process.env.STEAMBOT_TRADE_BOT_ACCOUNT_PASSWORD,
  identity_secret: process.env.STEAMBOT_TRADE_BOT_IDENTITY_SECRET,
  shared_secret: process.env.STEAMBOT_TRADE_BOT_SHARED_SECRET,
  opskins_key: process.env.STEAMBOT_TRADE_BOT_OPSKINS_KEY,
  app_id: parseInt(process.env.STEAMBOT_TRADE_BOT_APP_ID, 10),
  context_id: parseInt(process.env.STEAMBOT_TRADE_BOT_CONTEXT_ID, 10)
};

const logger = new Logger({ name: 'trade-bot', account_name: config.account_name });

const dbLog = logger.child({ source: 'database' });

pgMonitor.attach(pgpOptions);
pgMonitor.setLog((msg, info) => {
  dbLog.info({ info }, msg);
  info.display = false;
});

const instanceLog = logger.child({ source: 'instance' });

const instance = new Instance(db, config, instanceLog);
instance.start();

/**
 * Relist the opskins items that didn't sold, runs every 4 hours
 */
scheduleJob('0 */1 * * *', async () => {
  instance.relistOpskinsItems();
});
