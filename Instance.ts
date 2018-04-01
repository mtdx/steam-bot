import * as Logger from 'bunyan';
import { resolve as resolvePath } from 'path';
import { IDatabase, IConnected } from 'pg-promise';
import * as OPSkinsAPI from '@opskins/api';

import SteamUser = require('steam-user');
import SteamCommunity = require('steamcommunity');
import SteamTOTP = require('steam-totp');
import TradeOfferManager = require('steam-tradeoffer-manager');

import {
  existsAsync, readFileAsync, writeFileAsync, waitAsync,
  getUserDetailsAsync, sendOfferAsync, confirmOfferAsync, getUserInventoryAsync, failDeposit,
  failWithdrawal, errMessage
} from './utils';

import {
  OpskinsPriceData, DbItemPrices, OpskinsSalesData, OpskinsListItemsResult,
  OpskinsListItemsResultSale, COMPLETABLE_STATES, TradeOfferState, UserDetailsObject, TradeOffer, ToListItem,
  TradeWithdrawalItem, TradeDepositItem, Trade, TradeDeposit, User, Config, OpskinsSearchResult, OpskinsBuyReturn,
  OfferData
} from './interfaces';

const MAX_WITHDRAWAL_SIZE = 3;

export class Instance {
  protected _user: SteamUser;
  protected _community: SteamCommunity;
  protected _manager: TradeOfferManager;
  protected _sessionHasExpired: boolean = false;
  protected _listener: IConnected<any>;
  protected _opskins: OPSkinsAPI;

  constructor(protected _db: IDatabase<any>, protected _config: Config, protected _log: Logger) {
    const log = this._log;

    this._user = new SteamUser({
      promptSteamGuardCode: false
    });

    this._community = new SteamCommunity();

    this._manager = new TradeOfferManager({
      steam: this._user,
      community: this._community,
      language: 'en'
    });

    this._opskins = new OPSkinsAPI(this._config.opskins_key);

    this._user.on('loggedOn', () => {
      log.info('SteamUser logged on');
      this._user.setPersona(SteamUser.Steam.EPersonaState.Online);
    });

    this._user.on('webSession', (sessionId, cookies) => {
      log.info(`SteamUser session ${sessionId} started, configuring TradeManager and SteamCommunity cookies`);

      this._sessionHasExpired = false;
      this._manager.setCookies(cookies);
      this._community.setCookies(cookies);
    });

    this._user.on('disconnected', (eresult, msg) => {
      log.warn('SteamUser disconnected', { eresult, msg });
    });

    this._user.on('error', error => {
      log.error('SteamUser error', { error });
    });

    this._user.on('steamGuard', async (domain, callback) => {
      log.warn('SteamUser requires Steam Guard code, will present new code in 30 seconds...');
      await waitAsync(30);

      callback(SteamTOTP.getAuthCode(this._config.shared_secret));
    });

    this._community.on('error', error => {
      log.error('SteamCommunity error', { error });
    });

    this._community.on('sessionExpired', error => {
      log.debug(`this._community.on('sessionExpired')`, { error });

      if (this._sessionHasExpired) {
        return;
      }

      this._sessionHasExpired = true;
      log.warn('SteamCommunity session has expired, logging SteamUser on again');
      this._user.webLogOn();
    });

    this._manager.on('pollData', async pollData => {
      log.info('TradeManager writing pollData');

      const pollDataFilename = resolvePath(__dirname, `pollData-${this._config.account_name}.json`);
      await writeFileAsync(pollDataFilename, JSON.stringify(pollData));

      log.info('TradeManager wrote pollData');
    });

    this._manager.on('error', error => {
      log.info('TradeManager error', { error });
    });

    this._manager.on('sentOfferChanged', async (offer: TradeOffer, oldState: TradeOfferState) => {
      log.info('TradeManager sent offer changed', { offer, oldState });

      if (offer.itemsToReceive.length) {
        return await this.completeDeposit(offer, oldState);
      }

      return await this.completeWithdrawal(offer, oldState);
    });
  }

  async start() {
    const log = this._log;

    const pollDataFilename = resolvePath(__dirname, `pollData-${this._config.account_name}.json`);
    log.info(`Checking for polling data file ${pollDataFilename}`);

    if (await existsAsync(pollDataFilename)) {
      log.info(`Found polling data file ${pollDataFilename}, restoring TradeOfferManager state`);

      const pollData = await readFileAsync(pollDataFilename);
      this._manager.pollData = JSON.parse(pollData.toString());
    }

    log.info(`Attempting login as '${this._config.account_name}'`);

    this._user.logOn({
      accountName: this._config.account_name,
      password: this._config.account_password,
      twoFactorCode: SteamTOTP.getAuthCode(this._config.shared_secret),
    });

    await this._waitForSteamConnection();
    await this._startListening();
  }

  protected async _waitForSteamConnection() {
    while (true) {
      if (this._user.steamID) {
        this._log.info('SteamUser is now connected');
        return;
      }

      this._log.info('Waiting for SteamUser to be connected');
      await waitAsync(5);
    }
  }

  protected async _startListening() {
    this._log.info('Establishing listener connections');

    this._listener = await this._db.connect({ direct: true });

    await Promise.all([
      this._listener.none('LISTEN trade_deposit_created'),
      this._listener.none('LISTEN trade_withdrawal_created')
    ]);

    this._listener.client.on('notification', async message => {
      this._log.info(`Received notification on channel '${message.channel}'`);

      const payload = JSON.parse(message.payload);

      if (message.channel === 'trade_deposit_created') {
        const wait = Math.random() * 5;
        this._log.info(`Waiting ${wait} seconds before acknowledging deposit`);
        await waitAsync(wait);

        return this.startDeposit(payload);
      }

      if (message.channel === 'trade_withdrawal_created') {
        const wait = Math.random() * 1;
        await waitAsync(wait);

        return this.startWithdrawal(payload);
      }

      this._log.warn(`Unrecognized channel '${message.channel}', message ignored`);
    });

    this._listener.client.on('error', error => {
      this._log.warn('Listener connection error', { error });
      this._startListening();
    });
  }

  async startDeposit(depositId: string) {
    const log = this._log.child({ depositId });

    if (!this._user.steamID) {
      log.error('SteamUser is not connected, unable to process deposit');
      return;
    }

    const merchantSteamID = this._user.steamID.getSteamID64();
    log.info('Acknowledging deposit and retrieving details');

    const deposit: Trade = await this._db.oneOrNone(
      'UPDATE trade_deposits '
      + 'SET acknowledged_at = CURRENT_TIMESTAMP, merchant_steam_id = $1 '
      + 'WHERE id = $2 AND app_id = $3 AND acknowledged_at IS NULL '
      + 'RETURNING *',
      [merchantSteamID, depositId, this._config.app_id]
    );

    if (!deposit) {
      log.info('Deposit has already been acknowledged by another merchant, ignored');
      return;
    }

    log.info('Retrieved deposit details', { deposit });

    log.info('Retrieving user details');
    const user: User = await this._db.one(
      'SELECT * FROM users WHERE steam_id = $1',
      deposit.user_steam_id
    );

    log.info('Retrieved user details');

    if (!user.trade_link_url) {
      log.error('User does not have a trade link URL set, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Please set your Trade URL to proceed'
      );
    }

    log.info('Retrieving deposit items', { deposit });
    const depositItems: TradeDepositItem[] = await this._db.many(
      'SELECT * FROM trade_deposit_items WHERE trade_deposit_id = $1',
      depositId
    );

    log.info(`Retrieved ${depositItems.length} item(s)`, { depositItems });
    const assetIds = depositItems.map(item => item.steam_asset_id);

    let theirItems: any[];

    try {
      theirItems = await this._fetchInventoryItems(deposit.user_steam_id, assetIds, log);
    } catch (e) {
      return await failDeposit(
        this._db,
        deposit.id,
        e
      );
    }

    log.info('Preparing trade offer');
    const offer: TradeOffer = this._manager.createOffer(user.trade_link_url);

    let userDetails: UserDetailsObject;

    try {
      userDetails = await getUserDetailsAsync(offer, log);
    } catch (e) {
      await this._reconnectToSteam();

      try {
        userDetails = await getUserDetailsAsync(offer, log);
      } catch (e) {
        log.error('Failed to retrieve user details, marking deposit as failed');

        return await failDeposit(
          this._db,
          deposit.id,
          `We were unable to retrieve your details. Please try creating a new deposit. Error: ${e.message}`,
        );
      }
    }

    if (userDetails.them.probation) {
      log.error('User is currently subject to trade probation, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'You are not currently able to trade. Please consult your Steam profile for more information.',
      );
    }

    if (userDetails.them.escrowDays) {
      log.error('User is subject to escrow period, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        `Please enable mobile authenticator and wait for ${userDetails.them.escrowDays} days.`,
      );
    }

    offer.addTheirItems(theirItems);
    // offer.setMessage(`Deposit #${deposit.id}`);

    try {
      const status = await sendOfferAsync(offer, log);
      log.info('Sent Trade Offer', { status });
      log.info('Marking deposit as offered');

      await this._db.none(
        'UPDATE trade_deposits SET offered_at = $1, steam_offer_id = $2 WHERE id = $3',
        [offer.created, offer.id, deposit.id]
      );
    } catch (e) {
      log.info('Marking deposit as failed, with failure details', { failureDetails: e });
      await failDeposit(this._db, deposit.id, e);
    }
  }

  async completeDeposit(offer: TradeOffer, oldState: TradeOfferState) {
    const log = this._log.child({ offerId: offer.id });

    if (COMPLETABLE_STATES.indexOf(oldState) === -1) {
      log.warn(
        'Previous Trade Offer state was not `Active` or `CreatedNeedsConfirmation`, update ignored',
        { oldState }
      );

      return;
    }

    const deposit = await this._db.one<TradeDeposit>(
      'SELECT * FROM trade_deposits WHERE steam_offer_id = $1',
      offer.id
    );

    log.info('Retrieved deposit details', { deposit });

    if (offer.state === TradeOfferState.Countered) {
      log.warn('Trade Offer was countered, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'A counter-offer was made. Counter-offers are not currently accepted.'
      );
    }

    if (offer.state === TradeOfferState.Expired) {
      log.warn('Trade Offer expired, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Trade offer expired'
      );
    }

    if (offer.state === TradeOfferState.Cancelled) {
      log.warn('Trade Offer was cancelled, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Trade offer cancelled'
      );
    }

    if (offer.state === TradeOfferState.Declined) {
      log.warn('Trade Offer was declined, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Trade offer declined'
      );
    }

    if (offer.state === TradeOfferState.InvalidItems) {
      log.warn('Trade Offer contains invalid items, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Trade contained invalid items'
      );
    }

    if (offer.state === TradeOfferState.CanceledBySecondFactor) {
      log.warn('Trade Offer cancelled by second factor, marking deposit as failed');

      return await failDeposit(
        this._db,
        deposit.id,
        'Trade offer cancelled by second factor'
      );
    }

    if (offer.state === TradeOfferState.Accepted) {
      log.info('Trade Offer was accepted');

      log.info('Incrementing user balance', {
        total: deposit._total,
        bonus: deposit._bonus,
        user: deposit.user_steam_id
      });

      await this._db.none(
        'UPDATE users SET balance = balance + $1 + $2, last_balance_change_reason = $3 WHERE steam_id = $4',
        [
          deposit._total,
          deposit._bonus,
          { type: 'trade_deposit_completed', id: deposit.id },
          deposit.user_steam_id
        ]
      );

      log.info('Marking deposit as complete');
      await this._db.none(
        'UPDATE trade_deposits SET completed_at = $1 WHERE id = $2',
        [new Date(), deposit.id]
      );

      const merchantSteamID = this._user.steamID.getSteamID64();

      let items = [];
      try {
        items = await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
          this._config.context_id, log);
      } catch (err) {
        await this._reconnectToSteam();
        try {
          items = await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
            this._config.context_id, log);
        } catch (err2) {
          log.error({ error: errMessage(err2) }, 'Failed to fetch all inventory items');
          return;
        }
      }

      const withdrawalsItems = await this._currentWithdrawalsItems(merchantSteamID, log);
      if (withdrawalsItems.length) {
        for (const witem of withdrawalsItems) {
          items = items.filter(e => e.market_hash_name !== witem);
        }
      }

      if (items.length) {
        this._listItemsToOpskins(items, log);
      }
    }
  }

  async startWithdrawal(withdrawalId: string) {
    const log = this._log.child({ withdrawalId });

    if (!this._user.steamID) {
      log.error('SteamUser is not connected, unable to process withdrawal');
      return;
    }

    const merchantSteamID = this._user.steamID.getSteamID64();

    const locked = await this._lockWithdrawal(withdrawalId, merchantSteamID, log);
    if (!locked) {
      log.info('Withdrawal must be processed by another merchant, ignored (1)');
      return;
    }

    log.info('Retrieving withdrawal details');
    const withdrawal: Trade = await this._db.oneOrNone(
      'SELECT * FROM trade_withdrawals WHERE id = $1 AND merchant_steam_id = $2',
      [withdrawalId, merchantSteamID]
    );

    if (!withdrawal) {
      log.info('Withdrawal must be processed by another merchant, ignored (2)');
      return;
    }

    log.info('Retrieved withdrawal details', { withdrawal });

    log.info('Retrieving user details');
    const user: User = await this._db.one(
      'SELECT * FROM users WHERE steam_id = $1',
      withdrawal.user_steam_id
    );

    log.info('Retrieved user details');

    if (!user.trade_link_url) {
      log.error('User does not have a trade link URL set, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Please set your Trade URL to proceed'
      );
    }

    log.info('Preparing trade offer');
    const offer = this._manager.createOffer(user.trade_link_url);

    let userDetails: UserDetailsObject;

    try {
      userDetails = await getUserDetailsAsync(offer, log);
    } catch (e) {
      await this._reconnectToSteam();

      try {
        userDetails = await getUserDetailsAsync(offer, log);
      } catch (e) {
        log.error('Failed to retrieve user details, marking withdrawal as failed');

        return await failWithdrawal(
          this._db,
          withdrawal.id,
          `You are not currently able to trade. `
          + `Please consult your Steam profile for more information. Error: ${e.message}`,
        );
      }
    }

    if (userDetails.them.probation) {
      log.error('User is currently subject to trade probation, marking deposit as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'You are not currently able to trade. Please consult your Steam profile for more information.',
      );
    }

    if (userDetails.them.escrowDays) {
      log.error('User is subject to escrow period, marking deposit as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        `You are currently subject to a trade hold for ${userDetails.them.escrowDays} days.`,
      );
    }

    log.info('Retrieving withdrawal items', { withdrawal });
    const withdrawalItems: TradeWithdrawalItem[] = await this._db.many(
      'SELECT * FROM trade_withdrawal_items WHERE trade_withdrawal_id = $1',
      withdrawalId
    );

    if (!withdrawalItems.length) {
      log.error(`Error Retrieved no item(s)`, { withdrawalItems });

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        `Could not retrieve the items. Please try again later.`,
      );
    }

    if (withdrawalItems.length > MAX_WITHDRAWAL_SIZE) {
      log.error(`To many withdrawal items`, { length: withdrawalItems.length });

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        `Please choose a maximum of ${MAX_WITHDRAWAL_SIZE} items.`,
      );
    }

    const myItems = await this._buyPlaceholderItems(withdrawalItems, withdrawalId, withdrawal, merchantSteamID, log);
    if (!myItems.length) {
      log.error({ withdrawalItems }, 'Failed to buy placeholder item(s)');

      await failWithdrawal(
        this._db,
        withdrawal.id,
        'Failed to complete withdrawal, please try again later.',
      );

      await this._checkOpskinsUserInventory(withdrawal._item_names, log);
      this._listAgainItems(withdrawal._item_names, log);
      return;
    }

    offer.addMyItems(myItems);

    try {
      const status = await sendOfferAsync(offer, log);
      log.info('Sent Trade Offer', { status });

      await confirmOfferAsync(this._community, this._config.identity_secret, offer.id, log);
      log.info('Confirmed trade offer & Marking withdrawal as offered');

      await this._db.none(
        'UPDATE trade_withdrawals SET offered_at = $1, steam_offer_id = $2 WHERE id = $3',
        [offer.created, offer.id, withdrawal.id]
      );
    } catch (e) {
      log.info('Marking withdrawal as failed, with failure details', { failureDetails: e });

      await failWithdrawal(this._db, withdrawal.id, e);
    }
  }

  async completeWithdrawal(offer: TradeOffer, oldState: TradeOfferState) {
    const log = this._log.child({ offerId: offer.id });

    if (COMPLETABLE_STATES.indexOf(oldState) === -1) {
      log.warn(
        'Previous Trade Offer state was not `Active` or `CreatedNeedsConfirmation`, update ignored',
        { oldState }
      );
      return;
    }

    const withdrawal = await this._db.one<Trade>(
      'SELECT * FROM trade_withdrawals WHERE steam_offer_id = $1',
      offer.id
    );

    log.info('Retrieved withdrawal details', { withdrawal });

    if (offer.state === TradeOfferState.Countered) {
      log.warn('Trade Offer was countered, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'A counter-offer was made. Counter-offers are not currently accepted.'
      );
    }

    if (offer.state === TradeOfferState.Expired) {
      log.warn('Trade Offer expired, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Trade offer expired'
      );
    }

    if (offer.state === TradeOfferState.Cancelled) {
      log.warn('Trade Offer was cancelled, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Trade offer cancelled'
      );
    }

    if (offer.state === TradeOfferState.Declined) {
      log.warn('Trade Offer was declined, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Trade offer declined'
      );
    }

    if (offer.state === TradeOfferState.InvalidItems) {
      log.warn('Trade Offer contains invalid items, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Trade contained invalid items'
      );
    }

    if (offer.state === TradeOfferState.CanceledBySecondFactor) {
      log.warn('Trade Offer cancelled by second factor, marking withdrawal as failed');

      return await failWithdrawal(
        this._db,
        withdrawal.id,
        'Trade offer cancelled by second factor'
      );
    }

    if (offer.state === TradeOfferState.Accepted) {
      log.info('Trade Offer was accepted, marking withdrawal as complete');

      await this._db.none(
        'UPDATE trade_withdrawals SET completed_at = $1 WHERE id = $2',
        [new Date(), withdrawal.id]
      );
    }
  }

  protected _buyPlaceholderItems(withdrawalItems: TradeWithdrawalItem[], withdrawalId: string, withdrawal: Trade,
                                 merchantSteamID: string, log: Logger):
    Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (!this._config.opskins_key) {
        this._log.warn('Missing opskins key');
        resolve([]);
        return;
      }
      log.info('Placeholder withdrawal, trying to lock it', { withdrawal });
      this._opskins.getBalance(async (err: any, balance: number) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Failed to get the Opskins user balance');
          resolve([]);
          return;
        }

        const spPriceData = await this._getDbCentPrices(0, 10000, log);
        if (spPriceData == null) {
          log.error('Failed to fetch safe prices');
          resolve([]);
          return;
        }

        let searches = 0;
        const RPM = 20; // 20
        const purchases: number[] = [];

        for (let i = 0; i < withdrawalItems.length && searches < RPM * 4; i++) {
          const item = withdrawal._item_names[i];
          let results: OpskinsSearchResult[] = [];
          if (spPriceData[item] == null) {
            log.error('Failed to safe price item');
            resolve([]);
            return;
          }

          try {
            results = await this._searchOpskins(item, 100000, log);
            searches++;
          } catch (err) {
            log.error({ error: errMessage(err.message) }, 'Failed to search on Opsskins (1)');
            await waitAsync(1);
            try {
              results = await this._searchOpskins(item, 100000, log);
              searches++;
            } catch (err) {
              log.error({ error: errMessage(err.message) }, 'Failed to search on Opsskins (2)');
              await waitAsync(2);
              try {
                results = await this._searchOpskins(item, 100000, log);
                searches++;
              } catch (err) {
                log.error({ error: errMessage(err.message) }, 'Failed to search on Opsskins (3)');
                continue;
              }
            }
          }

          if (results[0].amount >= 4 * 100 && results[0].amount >= spPriceData[item].price * 1.05) {
            log.error('Item to expensive');
            resolve([]);
            return;
          }

          if (results.length && balance >= results[0].amount
            && results[0].market_name === item) {
            try {
              const result: OpskinsBuyReturn =
                await this._buyOpskinsItem([results[0].id], results[0].amount, results[0].market_name, log);
              purchases.push(result.new_itemid);
              balance = result.balance;
            } catch (err) {
              log.error({ error: errMessage(err.message) }, 'Failed to buy on Opsskins (1)');
              try {
                if (results.length >= 2 && balance >= results[1].amount
                  && results[1].market_name === item) {
                  const result: OpskinsBuyReturn =
                    await this._buyOpskinsItem([results[1].id], results[1].amount, results[1].market_name, log);
                  purchases.push(result.new_itemid);
                  balance = result.balance;
                }
              } catch (err) {
                log.error({ error: errMessage(err.message) }, 'Failed to buy on Opsskins (2)');
                try {
                  if (results.length >= 3 && balance >= results[2].amount
                    && results[2].market_name === item) {
                    const result: OpskinsBuyReturn =
                      await this._buyOpskinsItem([results[2].id], results[2].amount, results[2].market_name, log);
                    purchases.push(result.new_itemid);
                    balance = result.balance;
                  }
                } catch (err) {
                  log.error({ error: errMessage(err.message) }, 'Failed to buy on Opsskins (3)');
                }
              }
            }
          }

          if (searches === RPM) {
            await waitAsync(60);
          }
        }

        if (purchases.length && withdrawalItems.length === purchases.length) {

          let success = await this._withdrawOpskinsItems(purchases, log);
          if (!success) {
            await waitAsync(2);
            success = await this._withdrawOpskinsItems(purchases, log);
            if (!success) {
              await waitAsync(2);
              success = await this._withdrawOpskinsItems(purchases, log);
            }
          }

          let items = [];
          await waitAsync(2);

          try {
            items = (await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
              this._config.context_id, log));
          } catch (e) {
            log.error({ error: errMessage(e) }, 'Failed to Fetch inventory items, retry');

            await this._reconnectToSteam();
            items = (await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
              this._config.context_id, log));
          }

          if (!items.length) {
            await waitAsync(2);
            await this._withdrawOpskinsItems(purchases, log);

            try {
              items = (await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
                this._config.context_id, log));
            } catch (e) {
              log.error({ error: errMessage(e) }, 'Failed to Fetch inventory items, retry (2)');

              await this._reconnectToSteam();
              items = (await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
                this._config.context_id, log));
            }
          }

          const itemsfiltred: any[] = [];
          for (const item of items) {
            if (withdrawal._item_names.find((name: any) => name === item.market_hash_name) != null) {
              itemsfiltred.push(item);
              withdrawal._item_names = withdrawal._item_names.filter(
                (name: any) => name !== item.market_hash_name
              );
            }
          }
          if (!itemsfiltred.length || withdrawalItems.length !== itemsfiltred.length) {
            log.error({ itemsfiltred, withdrawalItems }, 'Failed get withdrawal items from inventory');
            resolve([]);
            return;
          }

          resolve(itemsfiltred);
          return;
        }

        resolve([]);
      });
    });
  }

  async relistOpskinsItems() {
    if (!this._config.opskins_key) {
      this._log.warn('Missing opskins key');
      return;
    }

    const log = this._log.child({ opskins: this._config.opskins_key.substring(0, 6) });
    const editMax = 500; // opskins limit

    this._opskins.getLowestPrices(this._config.app_id, (errp: any, opPriceData: OpskinsPriceData) => {
      if (errp != null) {
        log.error({ error: errMessage(errp) }, 'Failed to fetch Opskins price data');
        return;
      }
      log.info('Fetched Opskins price data', { count: Object.keys(opPriceData).length });

      this._opskins.getSales({ type: 2 }, (err, totalPages, sales) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Failed to fetch Opskins sales');
          return;
        }

        log.info({ count: sales.length }, 'Fetched Opskins sales data');
        const items: OpskinsSalesData = {};
        let willEdit = 0;

        for (const sale of sales) {
          if (willEdit === editMax) {
            break;
          }
          const updated = sale.last_updated > 0 ? sale.last_updated : sales.list_time;
          const timestamp = Math.floor(Date.now() / 1000);
          const diff = timestamp - updated;
          if (diff >= 3600) { // 1 hour
            if (opPriceData[sale.name] != null && opPriceData[sale.name].price !== sale.price) {
              items[sale.id] = opPriceData[sale.name].price - 1;
              willEdit++;
            }
          }
        }
        if (willEdit > 0) {
          this._opskins.editPrices(items, erred => {
            if (erred != null) {
              log.error({ error: errMessage(erred.message) }, 'Failed to lower Opskins items prices');
              return;
            }
            log.info('Relisted Opskins Items', { items });
          });
        }
      });
    });

  }

  protected async _fetchInventoryItems(steamId: string, assetIds: string[], log: Logger, retry = true) {
    log = log.child({ assetIds });

    let items = [];

    try {
      items = (await getUserInventoryAsync(this._manager, steamId, this._config.app_id,
        this._config.context_id, log))
        .filter(item => assetIds.indexOf(item.assetid) > -1);
    } catch (e) {
      log.error({ error: errMessage(e) }, 'Failed to Fetch inventory items, retry');

      await this._reconnectToSteam();
      if (!retry) {
        throw e;
      }

      await this._fetchInventoryItems(steamId, assetIds, log, false);
    }

    if (items.length !== assetIds.length) {
      log.error('One or more requested items do not exist in inventory', {
        inventoryAssetIds: items.map(item => item.assetid)
      });

      throw Error('One or more requested items do not exist in inventory');
    }

    log.info('Loaded all deposit items from user inventory');

    return items;
  }

  protected _reconnectToSteam(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this._log.info('Starting new SteamUser session...');

      this._user.webLogOn();

      this._user.once('webSession', (sessionId, cookies) => {
        this._log.info(`Successfully started new session ${sessionId}`);

        this._manager.setCookies(cookies);
        this._community.setCookies(cookies);

        resolve(true);
      });
    });
  }

  private async _listItemsToOpskins(items: any[], log: Logger) {
    this._opskins.getLowestPrices(this._config.app_id, (err: any, opPriceData: OpskinsPriceData) => {
      if (err != null) {
        log.error({ error: errMessage(err) }, 'Failed to fetch Opskins price data');
        return;
      }
      log.info('Fetched Opskins price data', { count: Object.keys(opPriceData).length });

      this._opskins.getListingLimit(async (errll, liimt) => {
        if (errll != null || liimt <= 0) {
          log.error({ error: errMessage(errll), liimt }, 'Failed to fetch Opskins list items limit');
          return;
        }
        const spPriceData = await this._getDbCentPrices(0, 10000, log);
        if (spPriceData == null) {
          log.error('Failed to fetch safe prices');
          return;
        }
        const listItems: ToListItem[] = [];

        for (let i = 0; i < items.length && listItems.length < liimt; i++) {
          const key = items[i].market_hash_name;
          const multiplier = opPriceData[key].quantity <= 12 ? 1.05 : 1;
          if (!opPriceData[key] || !spPriceData[key]) {
            continue;
          }
          listItems.push({
            appid: this._config.app_id,
            contextid: this._config.context_id,
            assetid: items[i].assetid,
            price: (opPriceData[key].price <= spPriceData[key].price * 0.65) ?
              spPriceData[key].price :
              Math.ceil(opPriceData[key].price * multiplier),
          });
        }

        if (listItems.length) {
          await this._listItems(listItems, log);
        }
      });
    });
  }

  private async _listItems(listItems: ToListItem[], log: Logger) {
    this._opskins.listItems(listItems, (errli: any, result: OpskinsListItemsResult) => {
      if (errli != null) {
        if (errMessage(errli).indexOf('already listed for sale.') !== -1) {
          this._retryFailledDeposits(log);
          return;
        }
        log.error({ error: errMessage(errli) }, 'Failed to list items on OPSkins');
        return;
      }
      if (result.tradeoffer_id == null) {
        log.error({ error: result.tradeoffer_error }, 'Did not receive a tradeoffer id from OPSkins');
        return;
      }
      this._manager.getOffer(result.tradeoffer_id, (errof: Error, offer: TradeOffer) => {
        if (errof != null) {
          log.error({ error: errMessage(errof.message) }, 'Failed to create a tradeoffer');
          this._retryFailledDeposits(log);
          return;
        }
        if (offer.message.indexOf(result.security_token) === -1) {
          log.error('Opskins offer declined due security token missmatch',
            { security_token: result.security_token, offer_message: offer.message });
          this._offerDecline(offer, log);
          return;
        }
        this._offerAccept(offer, result.sales, log);
      });
    });
  }

  private _confirmOffer(status: string, offer: TradeOffer, items: OpskinsListItemsResultSale[] | number[],
    // tslint:disable-next-line:align
    log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (status === 'pending') {
        this._community.acceptConfirmationForObject(this._config.identity_secret, offer.id, async (err: Error) => {
          if (err != null && err.message !== 'Could not act on confirmation') {
            log.error({ error: errMessage(err), id: offer.id }, 'Failed to comfirm OPSkins offer');
            await this._retryFailledDeposits(log);
            resolve(false);
          } else {
            log.info('Items transferred on/off Opskins', { status, items });
            resolve(true);
          }
        });
      } else {
        log.info('Items transferred on/off Opskins', { status, items });
        resolve(true);
      }
    });
  }

  private _offerDecline(offer: TradeOffer, log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      offer.decline(err => {
        if (err != null) {
          log.error({ error: errMessage(err.message), offer_message: offer.message },
            'Failed to decline offer');
          resolve(false);
          return;
        }
        log.warn('Offer declined', { offer_message: offer.message });
        resolve(true);
      });
    });
  }

  private _offerAccept(offer: TradeOffer, sales: OpskinsListItemsResultSale[] | number[], log: Logger):
    Promise<boolean> {
    return new Promise((resolve, reject) => {
      offer.accept(async (errac, status) => {
        if (errac != null) {
          if (errMessage(errac.message) === 'Not Logged In') {
            await this._reconnectToSteam();
            offer.accept(async (errac2, status2) => {
              if (errac2 != null) {
                log.error({ error: errMessage(errac2.message) }, 'Error accepting the Opskins trade offer');
                await this._retryFailledDeposits(log);
                resolve(false);
                return;
              }
              await waitAsync(1);
              await this._confirmOffer(status2, offer, sales, log);
            });
          } else {
            log.error({ error: errMessage(errac.message) }, 'Error accepting the Opskins trade offer');
            await this._retryFailledDeposits(log);
            resolve(true);
            return;
          }
        } else {
          await waitAsync(1);
          await this._confirmOffer(status, offer, sales, log);
          resolve(true);
        }
      });
    });
  }

  private async _getDbCentPrices(minPrice: number, maxPrice: number, log: Logger): Promise<DbItemPrices | null> {
    log.info('Retrieving database prices');
    const results: any[] = await this._db.manyOrNone(
      `SELECT market_hash_name, base_price_usd FROM steam_item_price_cache
       WHERE blacklisted = false AND base_price_usd >= $1 AND base_price_usd <= $2`,
      [minPrice, maxPrice]
    );
    if (!results.length) {
      log.error({ count: results.length }, 'Failed to retrive db skin price data');
      return;
    }
    const dbPrices: DbItemPrices = {};
    for (const result of results) {
      const price = Math.round(parseFloat(result.base_price_usd) * 100);
      if (!isNaN(price) && price > 0) {
        dbPrices[result.market_hash_name] = { price };
      }
    }
    return dbPrices;
  }

  private _searchOpskins(marketHashName: string, maxPrice: number, log: Logger): Promise<OpskinsSearchResult[]> {
    return new Promise((resolve, reject) => {
      log.info(`Searching for ${marketHashName} on Opskins`);
      this._opskins.search({
        app: `${this._config.app_id}_${this._config.context_id}`,
        search_item: `"${marketHashName}"`,
        max: maxPrice / 100
      }, (err, results) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Opskins search failed');
          reject(err);
          return;
        }
        resolve(results);
      });
    });
  }

  private _buyOpskinsItem(saleids: number[], total: number, marketHashName: string, log: Logger):
    Promise<OpskinsBuyReturn> {
    return new Promise((resolve, reject) => {
      log.info(`Buying ${saleids[0]} (${marketHashName}) on opskins`);
      this._opskins.buyItems([saleids[0]], total, (err, items, balance) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Opskins purchase failed');
          reject(err);
          return;
        }
        if (items.length !== 1) {
          log.error('Opskins multiple purchases');
        }
        resolve({ ...items[0], balance });
      });
    });
  }

  protected _withdrawOpskinsItems(items: number[], log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      log.info('Withdrawing opskins purchased items');
      this._opskins.withdrawInventoryItems(items, async (err, offers) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'One or more Opskins purchase withdraws failed');
          offers = (err.data.offers && err.data.offers.offers && err.data.offers.offers.length)
            ? err.data.offers.offers : err.data.offers;
          if (offers == null || !offers.length) {
            resolve(false);
            return;
          }
          for (const offer of offers) {
            await this._withdrawOffer(offer, items, log);
          }
          resolve(true);
          return;
        }
        offers = (offers && offers.offers && offers.offers.length) ? offers.offers : offers;
        if (offers == null || !offers.length) {
          resolve(false);
          return;
        }
        for (const offer of offers) {
          await this._withdrawOffer(offer, items, log);
        }
        resolve(true);
      });
    });
  }

  private _withdrawOffer(offerData: OfferData, items: number[], log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (offerData.tradeoffer_id == null) {
        log.error({ error: offerData.tradeoffer_error }, 'Did not receive a Opskins tradeoffer id (withdraw)');
        resolve(false);
        return;
      }
      this._manager.getOffer(offerData.tradeoffer_id, async (errof: Error, offer: TradeOffer) => {
        if (errof != null) {
          log.error({ error: errMessage(errof.message) }, 'Failed to create a tradeoffer (withdraw)');
          resolve(false);
          return;
        }
        if (offer.itemsToGive.length) {
          log.error('Opskins withdraw offer declined due having items to give',
            { itemsToGive: offer.itemsToGive, offer_message: offer.message });
          await this._offerDecline(offer, log);
          resolve(false);
          return;
        }
        await this._offerAccept(offer, items, log);
        resolve(true);
      });
    });
  }

  private async _withdrawFailledOffer(tradeofferId: string, type: string, items: number[], log: Logger) {
    return new Promise((resolve, reject) => {
      this._manager.getOffer(tradeofferId, async (errof: Error, offer: TradeOffer) => {
        if (errof != null) {
          log.error({ error: errMessage(errof.message) },
            'Failed to create a tradeoffer (withdraw failed trade offer)');
          resolve(false);
          return;
        }
        if ((type === 'pickup' && !offer.itemsToGive.length && offer.itemsToReceive.length) ||
          (type === 'return' && offer.itemsToGive.length && !offer.itemsToReceive.length)) {
          log.error('Opskins offer declined due bad type',
            { itemsToGive: offer.itemsToGive, itemsToReceive: offer.itemsToReceive, offer_message: offer.message });
          await this._offerDecline(offer, log);
          resolve(false);
          return;
        }
        await this._offerAccept(offer, items, log);
        resolve(true);
      });
    });
  }

  private _retryFailledDeposits(log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this._opskins.getActiveTradeOffers(async (err, offers) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Failed to get active trade offers');
          resolve(false);
          return;
        }
        const offersIds = Object.keys(offers);
        for (const offerId of offersIds) {
          await this._withdrawFailledOffer(offerId, offers[offerId].type, offers[offerId].saleids, log);
        }
        resolve(true);
      });
    });
  }

  private _lockWithdrawal(withdrawalId: string, merchantSteamID: number, log: Logger): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this._opskins.getBalance(async (err: any, balance: number) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Failed to get the Opskins user balance');
          resolve(false);
          return;
        }
        const tradeId: any = await this._db.oneOrNone(
          `UPDATE trade_withdrawals SET merchant_steam_id = $2 WHERE id = $1 AND merchant_steam_id = 1
         AND _total <= $3 AND app_id = $4 RETURNING id`,
          [withdrawalId, merchantSteamID, balance, this._config.app_id]
        );

        if (!tradeId || tradeId.id !== withdrawalId) {
          log.info('Placeholder withdrawal must be processed by another merchant, ignored');
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  private _currentWithdrawalsItems(merchantSteamID: string, log: Logger): Promise<string[]> {
    return new Promise(async (resolve, reject) => {
      log.info('Retrieving withdrawal details');
      const withdrawals: any[] = await this._db.manyOrNone(
        `SELECT _item_names FROM trade_withdrawals WHERE merchant_steam_id = $1
        AND completed_at IS NULL AND failed_at IS NULL AND cancelled_at IS NULL`,
        merchantSteamID
      );
      const items: string[] = [];
      for (const withdrawal of withdrawals) {
        for (const item of withdrawal._item_names) {
          items.push(item);
        }
      }
      resolve(items);
    });
  }

  private _checkOpskinsUserInventory(withdrawalItems: string[], log: Logger): Promise<boolean> {
    return new Promise(async (resolve, reject) => {
      this._opskins.getInventory(async (err, data) => {
        if (err != null) {
          log.error({ error: errMessage(err.message) }, 'Failed to fetch Opskins user inventory');
          resolve(false);
          return;
        }
        if (!data.items.length) {
          resolve(false);
          return;
        }
        const withdrawItems: number[] = [];
        for (const item of data.items) {
          if (withdrawalItems.find(item_name => item_name === item.market_hash_name) == null) {
            continue;
          }
          if (item.offer_id != null && item.offer_id !== 0 && item.offer_id !== '0') {
            this._manager.getOffer(item.offer_id, (errof: Error, offer: TradeOffer) => {
              if (errof != null) {
                log.error({ error: errMessage(errof.message) }, 'Failed to create a tradeoffer (withdraw)');
                return;
              }
              if (offer.itemsToGive.length) {
                log.error('Opskins withdraw offer declined due having items to give',
                  { itemsToGive: offer.itemsToGive, offer_message: offer.message });
                this._offerDecline(offer, log);
                return;
              }
              this._offerAccept(offer, [item.id], log);
            });
          } else {
            withdrawItems.push(item.id);
          }
        }

        if (withdrawItems.length) {
          let success = await this._withdrawOpskinsItems(withdrawItems, log);
          if (!success) {
            await waitAsync(30);
            success = await this._withdrawOpskinsItems(withdrawItems, log);
            if (!success) {
              await waitAsync(30);
              success = await this._withdrawOpskinsItems(withdrawItems, log);
            }
          }
          resolve(true);
          return;
        }

        resolve(false);
      });
    });
  }

  async _listAgainItems(withdrawalItems: string[], log: Logger) {

    const merchantSteamID = this._user.steamID.getSteamID64();
    let items = [];

    try {
      items = await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
        this._config.context_id, log);
    } catch (err) {
      await this._reconnectToSteam();
      try {
        items = await getUserInventoryAsync(this._manager, merchantSteamID, this._config.app_id,
          this._config.context_id, log);
      } catch (err2) {
        log.error({ error: errMessage(err2) }, 'Failed to fetch all inventory items');
        return;
      }
    }

    if (withdrawalItems.length && items.length) {
      items = items.filter(e => withdrawalItems.find(item_name => item_name === e.market_hash_name) != null);
    }

    if (items.length) {
      this._listItemsToOpskins(items, log);
    }
  }
}
