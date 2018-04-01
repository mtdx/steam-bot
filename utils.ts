import { exists, readFile, writeFile } from 'fs';
import * as Logger from 'bunyan';
import { whereEq } from 'ramda';
import { IDatabase } from 'pg-promise';

import TradeOfferManager = require('steam-tradeoffer-manager');
import SteamCommunity = require('steamcommunity');

import { UserDetailsObject, TradeOffer } from './interfaces';

export const existsAsync = (path: string | Buffer) =>
  new Promise<boolean>((resolve, reject) => {
    exists(path, ex => {
      resolve(ex);
    });
  });

export const readFileAsync = (filename: string) =>
  new Promise<Buffer>((resolve, reject) => {
    readFile(filename, (err, data) => {
      if (err) {
        return reject(err);
      }

      resolve(data);
    });
  });

export const writeFileAsync = (filename: string, data: any) =>
  new Promise((resolve, reject) => {
    writeFile(filename, data, err => {
      if (err) {
        return reject(err);
      }

      resolve();
    });
  });

export const waitAsync = (seconds: number) =>
  new Promise(resolve => {
    setTimeout(resolve, seconds * 1000);
  });

export const errMessage = (err: any): string => {
  if (err instanceof Error) {
    return err.message;
  } else if (typeof err === 'string') {
    return err;
  } else {
    return JSON.stringify(err);
  }
};

export const getUserDetailsAsync = (offer: TradeOffer, log: Logger) =>
  new Promise<UserDetailsObject>((resolve, reject) => {
    log.info('Getting user details');

    offer.getUserDetails((error, us, them) => {
      if (error) {
        log.error('Failed to get user details', { error });
        return reject(error);
      }

      log.info('Retrieved user details', { us, them });
      resolve({ us, them });
    });
  });

export const sendOfferAsync = (offer: TradeOffer, log: Logger) =>
  new Promise<string>((resolve, reject) => {
    log.info('Sending trade offer');

    offer.send((error, status) => {
      if (error) {
        log.error('Failed to send trade offer', { error });
        return reject(error);
      }

      log.info('Trade offer sent', { status, offerId: offer.id, offeredAt: offer.created });
      resolve(status);
    });
  });

export const confirmOfferAsync = (community: SteamCommunity, identitySecret: string, id: string, log: Logger) =>
  new Promise<void>((resolve, reject) => {
    log.info('Accepting confirmation', { id });

    community.acceptConfirmationForObject(identitySecret, id, error => {
      if (error) {
        log.error('Failed to accept confirmation', { error });
        return reject(error);
      }

      resolve();
    });
  });

export const getUserInventoryAsync = (manager: TradeOfferManager, steamId: string, appId: number, contextId: number,
                                      log: Logger) =>
  new Promise<any[]>((resolve, reject) => {
    log = log.child({ steamId });

    manager.getUserInventoryContents(steamId, appId, contextId, true, (error, items) => {
      if (error) {
        log.error('Failed to load user inventory', { error });
        return reject(error);
      }

      resolve(items);
    });
  });

export const tagValue = (item: any, category_name: string): string | undefined => {
  if (!(item.tags instanceof Array)) {
    return;
  }

  const tag = item.tags.find(whereEq({ category_name }));

  if (!tag) {
    return;
  }

  return tag.name;
};

export const fail = async (
  table: 'trade_deposits' | 'trade_withdrawals',
  db: IDatabase<any>,
  id: number,
  e: Error | string | {}
) => {
  const now = new Date();
  let message: string;

  if (e instanceof Error) {
    message = e.message;
  } else if (typeof e === 'string') {
    message = e;
  } else {
    message = JSON.stringify(e);
  }

  await db.none(
    `UPDATE ${table} SET failed_at = $1, failure_details = $2 WHERE id = $3`,
    [now, message, id]
  );
};

export const failDeposit = async (db: IDatabase<any>, id: number, e: Error | string | {}) =>
  fail('trade_deposits', db, id, e);

export const failWithdrawal = async (db: IDatabase<any>, id: number, e: Error | string | {}) =>
  fail('trade_withdrawals', db, id, e);
