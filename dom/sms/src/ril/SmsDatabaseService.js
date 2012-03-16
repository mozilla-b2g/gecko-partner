/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const RIL_SMSDATABASESERVICE_CONTRACTID = "@mozilla.org/sms/rilsmsdatabaseservice;1";
const RIL_SMSDATABASESERVICE_CID = Components.ID("{a1fa610c-eb6c-4ac2-878f-b005d5e89249}");

const DEBUG = true;
const DB_NAME = "sms";
const DB_VERSION = 1;
const STORE_NAME = "sms";

const DELIVERY_SENT = "sent";
const DELIVERY_RECEIVED = "received";

const FILTER_TIMESTAMP = "timestamp";
const FILTER_NUMBERS = "numbers";
const FILTER_DELIVERY = "delivery";

const READ_ONLY = "readonly";
const READ_WRITE = "readwrite";
const PREV = "prev";
const NEXT = "next";

XPCOMUtils.defineLazyServiceGetter(this, "gSmsService",
                                   "@mozilla.org/sms/smsservice;1",
                                   "nsISmsService");

XPCOMUtils.defineLazyServiceGetter(this, "gSmsRequestManager",
                                   "@mozilla.org/sms/smsrequestmanager;1",
                                   "nsISmsRequestManager");

XPCOMUtils.defineLazyServiceGetter(this, "gIDBManager",
                                   "@mozilla.org/dom/indexeddb/manager;1",
                                   "nsIIndexedDatabaseManager");

const GLOBAL_SCOPE = this;

/**
 * SmsDatabaseService
 */
function SmsDatabaseService() {
  gIDBManager.initWindowless(GLOBAL_SCOPE);

  let that = this;
  this.newTxn(READ_ONLY, function(error, txn, store){
    if (error) {
      return;
    }
    // In order to get the highest key value, we open a key cursor in reverse
    // order and get only the first pointed value.
    let request = store.openCursor(null, PREV);
    request.onsuccess = function onsuccess(event) {
      let cursor = event.target.result;
      if (!cursor) {
        if (DEBUG) {
          debug("Could not get the last key from sms database. " +
                "Probably empty database");
        }
        return;
      }
      that.lastKey = cursor.key || 0;
      if (DEBUG) debug("Last assigned message ID was " + that.lastKey);
    };
    request.onerror = function onerror(event) {
      if (DEBUG) {
        debug("Could not get the last key from sms database " +
              event.target.errorCode);
      }
    };
  });

  this.messageLists = {};
}
SmsDatabaseService.prototype = {

  classID:   RIL_SMSDATABASESERVICE_CID,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISmsDatabaseService,
                                         Ci.nsIObserver]),

  /**
   * Cache the DB here.
   */
  db: null,

  /**
   * This object keeps the message lists associated with each search. Each
   * message list is stored as an array of primary keys.
   */
  messageLists: null,

  lastMessageListId: 0,

  /**
   * Last key value stored in the database.
   */
  lastKey: 0,

  /**
   * nsIObserver
   */
  observe: function observe() {},

  /**
   * Prepare the database. This may include opening the database and upgrading
   * it to the latest schema version.
   *
   * @param callback
   *        Function that takes an error and db argument. It is called when
   *        the database is ready to use or if an error occurs while preparing
   *        the database.
   *
   * @return (via callback) a database ready for use.
   */
  ensureDB: function ensureDB(callback) {
    if (this.db) {
      if (DEBUG) debug("ensureDB: already have a database, returning early.");
      callback(null, this.db);
      return;
    }

    let self = this;
    function gotDB(db) {
      self.db = db;
      callback(null, db);
    }

    let request = GLOBAL_SCOPE.mozIndexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = function (event) {
      if (DEBUG) debug("Opened database:", DB_NAME, DB_VERSION);
      gotDB(event.target.result);
    };
    request.onupgradeneeded = function (event) {
      if (DEBUG) {
        debug("Database needs upgrade:", DB_NAME,
              event.oldVersion, event.newVersion);
        debug("Correct new database version:", event.newVersion == DB_VERSION);
      }

      let db = event.target.result;

      switch (event.oldVersion) {
        case 0:
          if (DEBUG) debug("New database");
          self.createSchema(db);
          break;

        default:
          event.target.transaction.abort();
          callback("Old database version: " + event.oldVersion, null);
          break;
      }
    };
    request.onerror = function (event) {
      //TODO look at event.target.Code and change error constant accordingly
      callback("Error opening database!", null);
    };
    request.onblocked = function (event) {
      callback("Opening database request is blocked.", null);
    };
  },

  /**
   * Start a new transaction.
   *
   * @param txn_type
   *        Type of transaction (e.g. READ_WRITE)
   * @param callback
   *        Function to call when the transaction is available. It will
   *        be invoked with the transaction and the 'sms' object store.
   */
  newTxn: function newTxn(txn_type, callback) {
    this.ensureDB(function (error, db) {
      if (error) {
        if (DEBUG) debug("Could not open database: " + error);
        callback(error);
        return;
      }
      let txn = db.transaction([STORE_NAME], txn_type);
      if (DEBUG) debug("Started transaction " + txn + " of type " + txn_type);
      if (DEBUG) {
        txn.oncomplete = function oncomplete(event) {
          debug("Transaction " + txn + " completed.");
        };
        txn.onerror = function onerror(event) {
          //TODO check event.target.errorCode and show an appropiate error
          //     message according to it.
          debug("Error occurred during transaction: " + event.target.errorCode);
        };
      }
      if (DEBUG) debug("Retrieving object store", STORE_NAME);
      let store = txn.objectStore(STORE_NAME);
      callback(null, txn, store);
    });
  },

  /**
   * Create the initial database schema.
   *
   * TODO need to worry about number normalization somewhere...
   * TODO full text search on body???
   * TODO We probably want to add a 'read' index
   */
  createSchema: function createSchema(db) {
    let objectStore = db.createObjectStore(STORE_NAME, { keyPath: "id" });
    objectStore.createIndex("id", "id", { unique: true });
    objectStore.createIndex("delivery", "delivery", { unique: false });
    objectStore.createIndex("sender", "sender", { unique: false });
    objectStore.createIndex("receiver", "receiver", { unique: false });
    objectStore.createIndex("timestamp", "timestamp", { unique:false });
    if (DEBUG) debug("Created object stores and indexes");
  },

  /**
   * Helper function to make the intersection of the partial result arrays
   * obtained within createMessageList.
   *
   * @param keys
   *        Object containing the partial result arrays.
   * @param fiter
   *        Object containing the filter search criteria used to retrieved the
   *        partial results.
   *
   * return Array of keys containing the final result of createMessageList.
   */
  keyIntersection: function keyIntersection(keys, filter) {
    let result = keys[FILTER_TIMESTAMP];
    if (keys[FILTER_NUMBERS].length || filter.numbers) {
      result = keys[FILTER_NUMBERS].filter(function(i) {
        return result.indexOf(i) != -1;
      });
    }
    if (keys[FILTER_DELIVERY].length || filter.delivery) {
      result = keys[FILTER_DELIVERY].filter(function(i) {
        return result.indexOf(i) != -1;
      });
    }
    return result;
  },

  /**
   * Helper function called after createMessageList gets the final result array
   * containing the list of primary keys of records that matches the provided
   * search criteria. This function retrieves from the store the message with
   * the primary key matching the first one in the message list array and keeps
   * the rest of this array in memory. It also notifies via gSmsRequestManager.
   *
   * @param messageList
   *        Array of primary keys retrieved within createMessageList.
   * @param requestId
   *        Id used by the SmsRequestManager
   */
  onMessageListCreated: function onMessageListCreated(messageList, requestId) {
    if (DEBUG) debug("Message list created: " + messageList);
    let self = this;
    self.newTxn(READ_ONLY, function (error, txn, store) {
      if (error) {
        gSmsRequestManager.notifyReadMessageListFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
        return;
      }

      let messageId = messageList.shift();
      if (DEBUG) debug ("Fetching message " + messageId);
      let request = store.get(messageId);
      let message;
      request.onsuccess = function (event) {
        message = request.result;
      };

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        if (!message) {
          gSmsRequestManager.notifyReadMessageListFailed(
            requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
          return;
        }
        self.lastMessageListId += 1;
        self.messageLists[self.lastMessageListId] = messageList;
        let sms = gSmsService.createSmsMessage(message.id,
                                               message.delivery,
                                               message.sender,
                                               message.receiver,
                                               message.body,
                                               message.timestamp);
        gSmsRequestManager.notifyCreateMessageList(requestId,
                                                   self.lastMessageListId,
                                                   sms);
      };
    });
  },

  saveMessage: function saveMessage(message) {
    this.lastKey += 1;
    message.id = this.lastKey;
    if (DEBUG) debug("Going to store " + JSON.stringify(message));
    this.newTxn(READ_WRITE, function(error, txn, store) {
      if (error) {
        return;
      }
      let request = store.put(message);
    });
    // We return the key that we expect to store in the db
    return message.id;
  },


  /**
   * nsISmsDatabaseService API
   */

  saveReceivedMessage: function saveReceivedMessage(sender, body, date) {
    let message = {delivery:  DELIVERY_RECEIVED,
                   sender:    sender,
                   receiver:  null,  //TODO see bug 733266
                   body:      body,
                   timestamp: date};
    return this.saveMessage(message);
  },

  saveSentMessage: function saveSentMessage(receiver, body, date) {
    let message = {delivery:  DELIVERY_SENT,
                   sender:    null, //TODO see bug 733266
                   receiver:  receiver,
                   body:      body,
                   timestamp: date};
    return this.saveMessage(message);
  },

  getMessage: function getMessage(messageId, requestId) {
    if (DEBUG) debug("Retrieving message with ID " + messageId);
    this.newTxn(READ_ONLY, function (error, txn, store) {
      if (error) {
        if (DEBUG) debug(error);
        gSmsRequestManager.notifyGetSmsFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
        return;
      }
      let request = store.getAll(messageId);

      txn.oncomplete = function oncomplete() {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        if (request.result.length > 1) {
          if (DEBUG) debug("Got too many results for id " + messageId);
          gSmsRequestManager.notifyGetSmsFailed(
            requestId, Ci.nsISmsRequestManager.UNKNOWN_ERROR);
          return;
        }
        let data = request.result[0];
        if (!data) {
          if (DEBUG) debug("Message ID " + messageId + " not found");
          gSmsRequestManager.notifyGetSmsFailed(
            requestId, Ci.nsISmsRequestManager.NOT_FOUND_ERROR);
          return;
        }
        if (data.id != messageId) {
          if (DEBUG) {
            debug("Requested message ID (" + messageId + ") is " +
                  "different from the one we got");
          }
          gSmsRequestManager.notifyGetSmsFailed(
            requestId, Ci.nsISmsRequestManager.UNKNOWN_ERROR);
          return;
        }
        let message = gSmsService.createSmsMessage(data.id,
                                                   data.delivery,
                                                   data.sender,
                                                   data.receiver,
                                                   data.body,
                                                   data.timestamp);
        gSmsRequestManager.notifyGotSms(requestId, message);
      };

      txn.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on transaction", event.target.errorCode);
        //TODO look at event.target.errorCode, pick appropriate error constant
        gSmsRequestManager.notifyGetSmsFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
      };
    });
  },

  deleteMessage: function deleteMessage(messageId, requestId) {
    let self = this;
    this.newTxn(READ_WRITE, function (error, txn, store) {
      if (error) {
        gSmsRequestManager.notifySmsDeleteFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
        return;
      }
      let request = store.delete(messageId);

      request.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on request ", event.target.errorCode);
        //TODO look at event.target.errorCode
        gSmsRequestManager.notifySmsDeleteFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
      };

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        // Once we transaction is done, we need to check if we actually deleted
        // the message. As IndexedDB does not provide the affected records info,
        // we need to try to get the message from the database again to check
        // that it is actually gone.
        self.newTxn(READ_ONLY, function (error, txn, store) {
          let request = store.getAll(messageId);
          request.onsuccess = function onsuccess(event) {
            let deleted = (event.target.result.length == 0);
            gSmsRequestManager.notifySmsDeleted(requestId, deleted);
          };
          request.onerror = function onerror(event) {
            if (DEBUG) {
              debug("Error checking the message deletion " +
                    event.target.errorCode);
            }
            //TODO should we notify here as an internal error? The failed check
            //     does not mean that the deletion has failed, so maybe we
            //     should notify successfully.
            gSmsRequestManager.notifySmsDeleteFailed(
              requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
          };
        });
      };

      txn.onerror = function onerror(event) {
        if (DEBUG) debug("Caught error on transaction", event.target.errorCode);
        //TODO look at event.target.errorCode, pick appropriate error constant
        gSmsRequestManager.notifySmsDeleteFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
      };
    });
  },

  createMessageList: function createMessageList(filter, reverse, requestId) {
    if (DEBUG) {
      debug("Creating a message list. Filters:" +
            " startDate: " + filter.startDate +
            " endDate: " + filter.endDate +
            " delivery: " + filter.delivery +
            " numbers: " + filter.numbers +
            " reverse: " + reverse);
    }
    // This object keeps the lists of keys retrieved by the search specific to
    // each nsIMozSmsFilter. Once all the keys have been retrieved from the
    // store, the final intersection of this arrays will contain all the
    // keys for the message list that we are creating.
    let filteredKeys = {};
    filteredKeys[FILTER_TIMESTAMP] = [];
    filteredKeys[FILTER_NUMBERS] = [];
    filteredKeys[FILTER_DELIVERY] = [];

    // Callback function to iterate through request results via IDBCursor.
    let successCb = function onsuccess(result, filter) {
      // Once the cursor has retrieved all keys that matches its key range,
      // the filter search is done.
      if (!result) {
        if (DEBUG) {
          debug("These messages match the " + filter + " filter: " +
                filteredKeys[filter]);
      }
        return;
      }
      // The cursor primaryKey is stored in its corresponding partial array
      // according to the filter parameter.
      let primaryKey = result.primaryKey;
      filteredKeys[filter].push(primaryKey);
      result.continue();
    };

    let errorCb = function onerror(event) {
      //TODO look at event.target.errorCode, pick appropriate error constant.
      if (DEBUG) debug("IDBRequest error " + event.target.errorCode);
      gSmsRequestManager.notifyReadMessageListFailed(
        requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
      return;
    };

    let self = this;
    this.newTxn(READ_ONLY, function (error, txn, store) {
      if (error) {
        errorCb(error);
        return;
      }

      // In first place, we retrieve the keys that match the filter.startDate
      // and filter.endDate search criteria.
      let timeKeyRange = null;
      if (filter.startDate != null && filter.endDate != null) {
        timeKeyRange = IDBKeyRange.bound(filter.startDate.getTime(),
                                         filter.endDate.getTime());
      } else if (filter.startDate != null) {
        timeKeyRange = IDBKeyRange.lowerBound(filter.startDate.getTime());
      } else if (filter.endDate != null) {
        timeKeyRange = IDBKeyRange.upperBound(filter.endDate.getTime());
      }
      let direction = reverse ? PREV : NEXT;
      let timeRequest = store.index("timestamp").openKeyCursor(timeKeyRange,
                                                               direction);

      timeRequest.onsuccess = function onsuccess(event) {
        successCb(event.target.result, FILTER_TIMESTAMP);
      };
      timeRequest.onerror = errorCb;

      // Retrieve the keys from the 'delivery' index that matches the
      // value of filter.delivery.
      if (filter.delivery) {
        let deliveryKeyRange = IDBKeyRange.only(filter.delivery);
        let deliveryRequest = store.index("delivery")
                                   .openKeyCursor(deliveryKeyRange);
        deliveryRequest.onsuccess = function onsuccess(event) {
          successCb(event.target.result, FILTER_DELIVERY);
        };
        deliveryRequest.onerror = errorCb;
      }

      // Retrieve the keys from the 'sender' and 'receiver' indexes that
      // match the values of filter.numbers
      if (filter.numbers) {
        for (let i = 0; i < filter.numbers.length; i++) {
          let numberKeyRange = IDBKeyRange.only(filter.numbers[i]);
          let senderRequest = store.index("sender")
                                   .openKeyCursor(numberKeyRange);
          let receiverRequest = store.index("receiver")
                                     .openKeyCursor(numberKeyRange);
          senderRequest.onsuccess = receiverRequest.onsuccess =
            function onsuccess(event){
              successCb(event.target.result, FILTER_NUMBERS);
            };
          senderRequest.onerror = receiverRequest.onerror = errorCb;
        }
      }

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        // We need to get the intersection of all the partial searches to
        // get the final result array.
        let result =  self.keyIntersection(filteredKeys, filter);
        if (!result.length) {
          if (DEBUG) debug("No messages matching the filter criteria");
          gSmsRequestManager.notifyNoMessageInList(requestId);
          return;
        }

        // At this point, filteredKeys should have all the keys that matches
        // all the search filters. So we take the first key and retrieve the
        // corresponding message. The rest of the keys are added to the
        // messageLists object as a new list.
        self.onMessageListCreated(result, requestId);
      };

      txn.onerror = function onerror(event) {
        errorCb(event);
      };
    });
  },

  getNextMessageInList: function getNextMessageInList(listId, requestId) {
    if (DEBUG) debug("Getting next message in list " + listId);
    let messageId;
    let list = this.messageLists[listId];
    if (!list) {
      if (DEBUG) debug("Wrong list id");
      gSmsRequestManager.notifyReadMessageListFailed(
        requestId, Ci.nsISmsRequestManager.NOT_FOUND_ERROR);
      return;
    }
    messageId = list.shift();
    if (messageId == null) {
      if (DEBUG) debug("Reached the end of the list!");
      gSmsRequestManager.notifyNoMessageInList(requestId);
      return;
    }
    this.newTxn(READ_ONLY, function (error, txn, store) {
      if (DEBUG) debug("Fetching message " + messageId);
      let request = store.get(messageId);
      let message;
      request.onsuccess = function onsuccess(event) {
        message = request.result;
      };

      txn.oncomplete = function oncomplete(event) {
        if (DEBUG) debug("Transaction " + txn + " completed.");
        if (!message) {
          if (DEBUG) debug("Could not get message id " + messageId);
          gSmsRequestManager.notifyReadMessageListFailed(
            requestId, Ci.nsISmsRequestManager.NOT_FOUND_ERROR);
        }
        let sms = gSmsService.createSmsMessage(message.id,
                                               message.delivery,
                                               message.sender,
                                               message.receiver,
                                               message.body,
                                               message.timestamp);
        gSmsRequestManager.notifyGotNextMessage(requestId, sms);
      };

      txn.onerror = function onerror(event) {
        //TODO check event.target.errorCode
        if (DEBUG) {
          debug("Error retrieving message id: " + messageId +
                ". Error code: " + event.target.errorCode);
        }
        gSmsRequestManager.notifyReadMessageListFailed(
          requestId, Ci.nsISmsRequestManager.INTERNAL_ERROR);
      };
    });
  },

  clearMessageList: function clearMessageList(listId) {
    if (DEBUG) debug("Clearing message list: " + listId);
    delete this.messageLists[listId];
  }

};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([SmsDatabaseService]);

function debug() {
  dump("SmsDatabaseService: " + Array.slice(arguments).join(" ") + "\n");
}
