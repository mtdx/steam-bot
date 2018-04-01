import {
    getUserDetailsAsync, sendOfferAsync, confirmOfferAsync, getUserInventoryAsync, tagValue, fail
  } from './utils';
  
  const log: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => log
  };
  
  const offer = {
    getUserDetails: jest.fn(cb => {
      cb(null, 'us', 'them');
    }),
  
    send: jest.fn(cb => {
      cb(null, 'sent');
    })
  };
  
  const manager = {
    getUserInventoryContents: jest.fn((steamId, appId, contextId, tradableOnly, cb) => {
      cb(null, [{
        assetid: 'item 1'
      }, {
        assetid: 'item 2'
      }]);
    })
  };
  
  const community = {
    acceptConfirmationForObject: jest.fn((identitySecret, id, cb) => {
      cb(null);
    })
  };
  
  describe('getUserDetailsAsync', () => {
    it('resolves `us` and `them` from TradeOffer#getUserDetails()`', async () => {
      const { us, them } = await getUserDetailsAsync(offer as any, log);
      expect(us).toBe('us');
      expect(them).toBe('them');
    });
  
    it('throws with an error', async () => {
      expect.assertions(1);
  
      offer.getUserDetails.mockImplementation(cb => {
        cb(new Error('could not get user details'));
      });
  
      try {
        await getUserDetailsAsync(offer as any, log);
      } catch (e) {
        expect(e).toEqual(new Error('could not get user details'));
      }
    });
  });
  
  describe('sendOfferAsync', () => {
    it('resolves `status` from TradeOffer#send()`', async () => {
      const status = await sendOfferAsync(offer as any, log);
  
      expect(status).toBe('sent');
    });
  
    it('throws with an error', async () => {
      expect.assertions(1);
  
      offer.send.mockImplementation(cb => {
        cb(new Error('failed to send'));
      });
  
      try {
        await sendOfferAsync(offer as any, log);
      } catch (e) {
        expect(e).toEqual(new Error('failed to send'));
      }
    });
  });
  
  describe('confirmOfferAsync', () => {
    it('passes `identitySecret` and `id` to SteamCommunity#acceptConfirmationForObject()', async () => {
      await confirmOfferAsync(community as any, 's3cr3t', '1234', log);
  
      expect(community.acceptConfirmationForObject).toHaveBeenCalledWith(
        's3cr3t',
        '1234',
        jasmine.any(Function)
      );
    });
  
    it('throws with an error', async () => {
      expect.assertions(1);
  
      community.acceptConfirmationForObject.mockImplementation((identitySecret, id, cb) => {
        cb(new Error('failed to confirm'));
      });
  
      try {
        await confirmOfferAsync(community, 's3cr3t', '1234', log);
      } catch (e) {
        expect(e).toEqual(new Error('failed to confirm'));
      }
    });
  });
  
  describe('getUserInventoryAsync', () => {
    it('resolves `items` from TradeOfferManager#getUserInventoryContents()', async () => {
      const items = await getUserInventoryAsync(manager as any, '1234', 730, 2, log);
  
      expect(manager.getUserInventoryContents).toHaveBeenCalledWith(
        '1234',
        730,
        2,
        true,
        jasmine.any(Function)
      );
  
      expect(items).toEqual([{
        assetid: 'item 1'
      }, {
        assetid: 'item 2'
      }]);
    });
  
    it('throws with an error', async () => {
      expect.assertions(1);
  
      manager.getUserInventoryContents.mockImplementation((steamId, appId, contextId, tradableOnly, cb) => {
        cb(new Error('failed to load'));
      });
  
      try {
        await getUserInventoryAsync(manager as any, '1234', 730, 2, log);
      } catch (e) {
        expect(e).toEqual(new Error('failed to load'));
      }
    });
  });
  
  describe('tagValue', () => {
    describe('when `item.tags` is not an array', () => {
      it('returns nothing', () => {
        const item = {
          name: 'a gun',
          tags: 'none'
        };
  
        expect(tagValue(item, 'Exterior')).toBeUndefined();
      });
    });
  
    describe('when `items.tags` does not contain a match', () => {
      it('returns nothing', () => {
        const item = {
          name: 'super-cool pistol',
          tags: [{
            category_name: 'Quality',
            name: 'bruised'
          }]
        };
  
        expect(tagValue(item, 'Exterior')).toBeUndefined();
      });
    });
  
    describe('when `item.tags` contains a match', () => {
      it('returns the tag name', () => {
        const item = {
          name: 'super-cool rifle',
          tags: [{
            category_name: 'Quality',
            name: 'bruised'
          }, {
            category_name: 'Exterior',
            name: 'go-faster stripes'
          }]
        };
  
        expect(tagValue(item, 'Exterior')).toBe('go-faster stripes');
      });
    });
  });
  
  describe('fail', () => {
    const db = {
      none: jest.fn()
    };
  
    describe('when `e` is an Error', () => {
      it('sets `failure_details` to `e.message`', async () => {
        await fail('trade_deposits', db as any, 1234, new Error('whoops'));
  
        expect(db.none).toHaveBeenCalledWith(
          'UPDATE trade_deposits SET failed_at = $1, failure_details = $2 WHERE id = $3',
          [jasmine.any(Date), 'whoops', 1234]
        );
      });
    });
  
    describe('when `e` is a String', () => {
      it('sets `failure_details` to `e`', async () => {
        await fail('trade_deposits', db as any, 1234, 'oh no');
  
        expect(db.none).toHaveBeenCalledWith(
          'UPDATE trade_deposits SET failed_at = $1, failure_details = $2 WHERE id = $3',
          [jasmine.any(Date), 'oh no', 1234]
        );
      });
    });
  
    describe('when `e` is any other type', () => {
      it('sets `failure_details` to JSON-stringified representation of `e`', async () => {
        await fail('trade_deposits', db as any, 1234, { foo: 'bar' });
  
        expect(db.none).toHaveBeenCalledWith(
          'UPDATE trade_deposits SET failed_at = $1, failure_details = $2 WHERE id = $3',
          [jasmine.any(Date), '{"foo":"bar"}', 1234]
        );
      });
    });
  });
  