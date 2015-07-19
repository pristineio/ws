'use strict';

/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var url = require('url');
var util = require('util');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var stream = require('stream');
var Ultron = require('ultron');
var Sender = require('./Sender');
var Receiver = require('./Receiver');
var Extensions = require('./Extensions');
var PerMessageDeflate = require('./PerMessageDeflate');
var EventEmitter = require('events').EventEmitter;

var protocolVersion = 13;
var closeTimeout = 30 * 1000;

function WebSocket(address, protocols, options) {
  if(this instanceof WebSocket === false) {
    throw new TypeError("Classes can't be function-called");
  }

  EventEmitter.call(this);

  if(protocols && !Array.isArray(protocols) && 'object' === typeof protocols) {
    options = protocols;
    protocols = null;
  }

  if('string' === typeof protocols) {
    protocols = [ protocols ];
  }

  if(!Array.isArray(protocols)) {
    protocols = [];
  }

  this._socket = null;
  this._ultron = null;
  this._closeReceived = false;
  this.bytesReceived = 0;
  this.readyState = null;
  this.supports = {};
  this.extensions = {};

  if(Array.isArray(address)) {
    initAsServerClient.apply(this, address.concat(options));
  } else {
    initAsClient.apply(this, [address, protocols, options]);
  }
}

util.inherits(WebSocket, EventEmitter);

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function each(state, i) {
  WebSocket.prototype[state] = WebSocket[state] = i;
});


WebSocket.prototype.close = function close(code, data) {
  if(this.readyState === WebSocket.CLOSED) return;
  if(this.readyState === WebSocket.CONNECTING) {
    this.readyState = WebSocket.CLOSED;
    return;
  }
  if(this.readyState === WebSocket.CLOSING) {
    if(this._closeReceived && this._isServer) {
      this.terminate();
    }
    return;
  }

  var self = this;
  try {
    this.readyState = WebSocket.CLOSING;
    this._closeCode = code;
    this._closeMessage = data;
    var mask = !this._isServer;
    this._sender.close(code, data, mask, function(err) {
      if(err) self.emit('error', err);

      if(self._closeReceived && self._isServer) {
        self.terminate();
      } else {
        // ensure that the connection is cleaned up even when no response of closing handshake.
        clearTimeout(self._closeTimer);
        self._closeTimer = setTimeout(cleanupWebsocketResources.bind(self, true), closeTimeout);
      }
    });
  } catch (e) {
    this.emit('error', e);
  }
};

WebSocket.prototype.terminate = function terminate() {
  if(this.readyState === WebSocket.CLOSED) return;

  if(this._socket) {
    this.readyState = WebSocket.CLOSING;

    // End the connection
    try { this._socket.end(); }
    catch (e) {
      // Socket error during end() call, so just destroy it right now
      cleanupWebsocketResources.call(this, true);
      return;
    }

    // Add a timeout to ensure that the connection is completely
    // cleaned up within 30 seconds, even if the clean close procedure
    // fails for whatever reason
    // First cleanup any pre-existing timeout from an earlier "terminate" call,
    // if one exists.  Otherwise terminate calls in quick succession will leak timeouts
    // and hold the program open for `closeTimout` time.
    if(this._closeTimer) { clearTimeout(this._closeTimer); }
    this._closeTimer = setTimeout(cleanupWebsocketResources.bind(this, true), closeTimeout);
  } else if(this.readyState === WebSocket.CONNECTING) {
    cleanupWebsocketResources.call(this, true);
  }
};

WebSocket.prototype.stream = function stream(options, cb) {
  if(typeof options === 'function') {
    cb = options;
    options = {};
  }

  var self = this;

  if(typeof cb !== 'function') throw new Error('callback must be provided');

  if(this.readyState !== WebSocket.OPEN) {
    if(typeof cb === 'function') cb(new Error('not opened'));
    else throw new Error('not opened');
    return;
  }

  if(this._queue) {
    this._queue.push(function () { self.stream(options, cb); });
    return;
  }

  options = options || {};

  if(typeof options.mask === 'undefined') options.mask = !this._isServer;
  if(typeof options.compress === 'undefined') options.compress = true;
  if(!this.extensions[PerMessageDeflate.extensionName]) {
    options.compress = false;
  }

  startQueue(this);

  function send(data, final) {
    try {
      if(self.readyState !== WebSocket.OPEN) throw new Error('not opened');
      options.fin = final === true;
      self._sender.send(data, options);
      if(!final) process.nextTick(cb.bind(null, null, send));
      else executeQueueSends(self);
    } catch (e) {
      if(typeof cb === 'function') cb(e);
      else {
        delete self._queue;
        self.emit('error', e);
      }
    }
  }

  process.nextTick(cb.bind(null, null, send));
};

WebSocket.prototype.pause = function pauser() {
  if(this.readyState !== WebSocket.OPEN) throw new Error('not opened');

  return this._socket.pause();
};

WebSocket.prototype.resume = function resume() {
  if(this.readyState !== WebSocket.OPEN) throw new Error('not opened');

  return this._socket.resume();
};

WebSocket.prototype.ping = function ping(data, options, dontFailWhenClosed) {
  if(this.readyState !== WebSocket.OPEN) {
    if(dontFailWhenClosed === true) return;
    throw new Error('not opened');
  }

  options = options || {};

  if(typeof options.mask === 'undefined') options.mask = !this._isServer;

  this._sender.ping(data, options);
};

WebSocket.prototype.pong = function(data, options, dontFailWhenClosed) {
  if(this.readyState !== WebSocket.OPEN) {
    if(dontFailWhenClosed === true) return;
    throw new Error('not opened');
  }

  options = options || {};

  if(typeof options.mask === 'undefined') options.mask = !this._isServer;

  this._sender.pong(data, options);
};

WebSocket.prototype.send = function send(data, options, cb) {
  if(typeof options === 'function') {
    cb = options;
    options = {};
  }

  if(this.readyState !== WebSocket.OPEN) {
    if(typeof cb === 'function') cb(new Error('not opened'));
    else throw new Error('not opened');
    return;
  }

  if(!data) data = '';
  if(this._queue) {
    var self = this;
    this._queue.push(function() { self.send(data, options, cb); });
    return;
  }

  options = options || {};
  options.fin = true;

  if(typeof options.binary === 'undefined') {
    options.binary = (data instanceof ArrayBuffer || data instanceof Buffer ||
      data instanceof Uint8Array ||
      data instanceof Uint16Array ||
      data instanceof Uint32Array ||
      data instanceof Int8Array ||
      data instanceof Int16Array ||
      data instanceof Int32Array ||
      data instanceof Float32Array ||
      data instanceof Float64Array);
  }

  if(typeof options.mask === 'undefined') options.mask = !this._isServer;
  if(typeof options.compress === 'undefined') options.compress = true;
  if(!this.extensions[PerMessageDeflate.extensionName]) {
    options.compress = false;
  }

  var readable = typeof stream.Readable === 'function'
    ? stream.Readable
    : stream.Stream;

  if(data instanceof readable) {
    startQueue(this);
    var self = this;

    sendStream(this, data, options, function send(error) {
      process.nextTick(function tock() {
        executeQueueSends(self);
      });

      if(typeof cb === 'function') cb(error);
    });
  } else {
    this._sender.send(data, options, cb);
  }
};

Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
  get: function get() {
    var amount = 0;
    if(this._socket) {
      amount = this._socket.bufferSize || 0;
    }
    return amount;
  }
});

function buildHostHeader(isSecure, hostname, port) {
  var headerHost = hostname;
  if(hostname) {
    if((isSecure && (port != 443)) || (!isSecure && (port != 80))){
      headerHost = headerHost + ':' + port;
    }
  }
  return headerHost;
}


function initAsServerClient(req, socket, upgradeHead, opts) {
  var options = {
    protocolVersion: protocolVersion,
    protocol: null,
    extensions: {}
  };
  if(opts) {
    Object.keys(opts).forEach(function(k) {
      options[k] = opts[k];
    });
  }

  // expose state properties
  this.protocol = options.protocol;
  this.protocolVersion = options.protocolVersion;
  this.extensions = options.extensions;
  this.supports.binary = (this.protocolVersion !== 'hixie-76');
  this.upgradeReq = req;
  this.readyState = WebSocket.CONNECTING;
  this._isServer = true;

  establishConnection.call(this, Receiver, Sender, socket, upgradeHead);
}


function initAsClient(address, protocols, opts) {
  var options = {
    origin: null,
    protocolVersion: protocolVersion,
    protocol: protocols.join(','),
    perMessageDeflate: true,
    host: null,
    headers: null,
    pfx: null,
    key: null,
    passphrase: null,
    cert: null,
    ca: null,
    ciphers: null,
    rejectUnauthorized: null,
  };

  if(opts) {
    Object.keys(opts).forEach(function(k) {
      options[k] = opts[k];
    });
  }

  if(options.protocolVersion !== 8 && options.protocolVersion !== 13) {
    throw new Error('unsupported protocol version');
  }

  // verify URL and establish http class
  var serverUrl = url.parse(address);
  var isUnixSocket = serverUrl.protocol === 'ws+unix:';
  if(!serverUrl.host && !isUnixSocket) throw new Error('invalid url');
  var isSecure = serverUrl.protocol === 'wss:' || 
    serverUrl.protocol === 'https:';
  var httpObj = isSecure ? https : http;
  var port = serverUrl.port || (isSecure ? 443 : 80);
  var auth = serverUrl.auth;

  // prepare extensions
  var extensionsOffer = {};
  var perMessageDeflate;
  if(options.perMessageDeflate) {
    perMessageDeflate = new PerMessageDeflate(
      typeof options.perMessageDeflate !== true ? 
        options.perMessageDeflate : {}, 
      false
    );
    extensionsOffer[PerMessageDeflate.extensionName] = perMessageDeflate.offer();
  }

  // expose state properties
  this._isServer = false;
  this.url = address;
  this.protocolVersion = options.protocolVersion;
  this.supports.binary = this.protocolVersion !== 'hixie-76';

  // begin handshake
  var key = new Buffer(options.protocolVersion + '-' + Date.now()).toString('base64');
  var shasum = crypto.createHash('sha1');
  shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  var expectedServerKey = shasum.digest('base64');

  var requestOptions = {
    port: port,
    host: serverUrl.hostname,
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Host': buildHostHeader(isSecure, serverUrl.hostname, port),
      'Sec-WebSocket-Version': options.protocolVersion,
      'Sec-WebSocket-Key': key
    }
  };

  // If we have basic auth.
  if(auth) {
    requestOptions.headers.Authorization = 'Basic ' + new Buffer(auth).toString('base64');
  }

  if(options.protocol) {
    requestOptions.headers['Sec-WebSocket-Protocol'] = options.protocol;
  }

  if(options.host) {
    requestOptions.headers.Host = options.host;
  }

  if(options.headers) {
    for (var header in options.headers) {
       if(options.headers.hasOwnProperty(header)) {
        requestOptions.headers[header] = options.headers[header];
       }
    }
  }

  if(Object.keys(extensionsOffer).length) {
    requestOptions.headers['Sec-WebSocket-Extensions'] = Extensions.format(extensionsOffer);
  }

  if(options.pfx ||
    options.key ||
    options.passphrase ||
    options.cert ||
    options.ca ||
    options.ciphers ||
    options.rejectUnauthorized) {

    if(options.pfx) requestOptions.pfx = options.pfx;
    if(options.key) requestOptions.key = options.key;
    if(options.passphrase) requestOptions.passphrase = options.passphrase;
    if(options.cert) requestOptions.cert = options.cert;
    if(options.ca) requestOptions.ca = options.ca;
    if(options.ciphers) requestOptions.ciphers = options.ciphers;
    if(options.rejectUnauthorized) requestOptions.rejectUnauthorized = options.rejectUnauthorized;
  }

  requestOptions.path = serverUrl.path || '/';

  if(isUnixSocket) {
    requestOptions.socketPath = serverUrl.pathname;
  }
  if(options.origin) {
    if(options.protocolVersion < 13) requestOptions.headers['Sec-WebSocket-Origin'] = options.origin;
    else requestOptions.headers.Origin = options.origin;
  }

  var self = this;
  var req = httpObj.request(requestOptions);

  req.on('error', function onerror(error) {
    self.emit('error', error);
    cleanupWebsocketResources.call(self, error);
  });

  req.once('response', function response(res) {
    var error;

    if(!self.emit('unexpected-response', req, res)) {
      error = new Error('unexpected server response (' + res.statusCode + ')');
      req.abort();
      self.emit('error', error);
    }

    cleanupWebsocketResources.call(self, error);
  });

  req.once('upgrade', function upgrade(res, socket, upgradeHead) {
    if(self.readyState === WebSocket.CLOSED) {
      // client closed before server accepted connection
      self.emit('close');
      self.removeAllListeners();
      socket.end();
      return;
    }

    var serverKey = res.headers['sec-websocket-accept'];
    if(typeof serverKey === 'undefined' || serverKey !== expectedServerKey) {
      self.emit('error', 'invalid server key');
      self.removeAllListeners();
      socket.end();
      return;
    }

    var serverProt = res.headers['sec-websocket-protocol'];
    var protList = (options.protocol || "").split(/, */);
    var protError = null;

    if(!options.protocol && serverProt) {
      protError = 'server sent a subprotocol even though none requested';
    } else if(options.protocol && !serverProt) {
      protError = 'server sent no subprotocol even though requested';
    } else if(serverProt && protList.indexOf(serverProt) === -1) {
      protError = 'server responded with an invalid protocol';
    }

    if(protError) {
      self.emit('error', protError);
      self.removeAllListeners();
      socket.end();
      return;
    } else if(serverProt) {
      self.protocol = serverProt;
    }

    var serverExtensions = Extensions.parse(res.headers['sec-websocket-extensions']);
    if(perMessageDeflate && serverExtensions[PerMessageDeflate.extensionName]) {
      try {
        perMessageDeflate.accept(serverExtensions[PerMessageDeflate.extensionName]);
      } catch (err) {
        self.emit('error', 'invalid extension parameter');
        self.removeAllListeners();
        socket.end();
        return;
      }
      self.extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
    }

    establishConnection.call(self, Receiver, Sender, socket, upgradeHead);

    // perform cleanup on http resources
    req.removeAllListeners();
    req = null;
  });

  req.end();
  this.readyState = WebSocket.CONNECTING;
}



function establishConnection(ReceiverClass, SenderClass, socket, upgradeHead) {
  var ultron = this._ultron = new Ultron(socket);
  var called = false;
  var self = this;

  socket.setTimeout(0);
  socket.setNoDelay(true);

  this._receiver = new ReceiverClass(this.extensions);
  this._socket = socket;

  // socket cleanup handlers
  ultron.on('end', cleanupWebsocketResources.bind(this));
  ultron.on('close', cleanupWebsocketResources.bind(this));
  ultron.on('error', cleanupWebsocketResources.bind(this));

  // ensure that the upgradeHead is added to the receiver
  function firstHandler(data) {
    if(called || self.readyState === WebSocket.CLOSED) return;

    called = true;
    socket.removeListener('data', firstHandler);
    ultron.on('data', realHandler);

    if(upgradeHead && upgradeHead.length > 0) {
      realHandler(upgradeHead);
      upgradeHead = null;
    }

    if(data) realHandler(data);
  }

  // subsequent packets are pushed straight to the receiver
  function realHandler(data) {
    self.bytesReceived += data.length;
    self._receiver.add(data);
  }

  ultron.on('data', firstHandler);

  // if data was passed along with the http upgrade,
  // this will schedule a push of that on to the receiver.
  // this has to be done on next tick, since the caller
  // hasn't had a chance to set event handlers on this client
  // object yet.
  process.nextTick(firstHandler);

  // receiver event handlers
  self._receiver.ontext = function ontext(data, flags) {
    flags = flags || {};

    self.emit('message', data, flags);
  };

  self._receiver.onbinary = function onbinary(data, flags) {
    flags = flags || {};

    flags.binary = true;
    self.emit('message', data, flags);
  };

  self._receiver.onping = function onping(data, flags) {
    flags = flags || {};

    self.pong(data, {
      mask: !self._isServer,
      binary: flags.binary === true
    }, true);

    self.emit('ping', data, flags);
  };

  self._receiver.onpong = function onpong(data, flags) {
    self.emit('pong', data, flags || {});
  };

  self._receiver.onclose = function onclose(code, data, flags) {
    flags = flags || {};

    self._closeReceived = true;
    self.close(code, data);
  };

  self._receiver.onerror = function onerror(reason, errorCode) {
    // close the connection when the receiver reports a HyBi error code
    self.close(typeof errorCode !== 'undefined' ? errorCode : 1002, '');
    self.emit('error', reason, errorCode);
  };

  // finalize the client
  this._sender = new SenderClass(socket, this.extensions);
  this._sender.on('error', function onerror(error) {
    self.close(1002, '');
    self.emit('error', error);
  });

  this.readyState = WebSocket.OPEN;
  this.emit('open');
}

function startQueue(instance) {
  instance._queue = instance._queue || [];
}

function executeQueueSends(instance) {
  var queue = instance._queue;
  if(typeof queue === 'undefined') return;

  delete instance._queue;
  for (var i = 0, l = queue.length; i < l; ++i) {
    queue[i]();
  }
}

function sendStream(instance, stream, options, cb) {
  stream.on('data', function incoming(data) {
    if(instance.readyState !== WebSocket.OPEN) {
      if(typeof cb === 'function') cb(new Error('not opened'));
      else {
        delete instance._queue;
        instance.emit('error', new Error('not opened'));
      }
      return;
    }

    options.fin = false;
    instance._sender.send(data, options);
  });

  stream.on('end', function end() {
    if(instance.readyState !== WebSocket.OPEN) {
      if(typeof cb === 'function') cb(new Error('not opened'));
      else {
        delete instance._queue;
        instance.emit('error', new Error('not opened'));
      }
      return;
    }

    options.fin = true;
    instance._sender.send(null, options);

    if(typeof cb === 'function') cb(null);
  });
}

function cleanupWebsocketResources(error) {
  if(this.readyState === WebSocket.CLOSED) return;

  var emitClose = this.readyState !== WebSocket.CONNECTING;
  this.readyState = WebSocket.CLOSED;

  clearTimeout(this._closeTimer);
  this._closeTimer = null;

  if(emitClose) {
    this.emit('close', this._closeCode || 1000, this._closeMessage || '');
  }

  if(this._socket) {
    if(this._ultron) this._ultron.destroy();
    this._socket.on('error', function onerror() {
      try { this.destroy(); }
      catch (e) {}
    });

    try {
      if(!error) this._socket.end();
      else this._socket.destroy();
    } catch (e) { /* Ignore termination errors */ }

    this._socket = null;
    this._ultron = null;
  }

  if(this._sender) {
    this._sender.removeAllListeners();
    this._sender = null;
  }

  if(this._receiver) {
    this._receiver.cleanup();
    this._receiver = null;
  }

  this.removeAllListeners();
  this.on('error', function onerror() {}); // catch all errors after this
  delete this._queue;
}

module.exports = WebSocket;
module.exports.buildHostHeader = buildHostHeader;
