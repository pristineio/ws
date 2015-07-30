'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

var url = require('url');
var util = require('util');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var stream = require('stream');
var Sender = require('./Sender');
var Receiver = require('./Receiver');
var Extensions = require('./Extensions');
var PerMessageDeflate = require('./PerMessageDeflate');
var EventEmitter = require('events').EventEmitter;

var protocolVersion = 13;
var closeTimeout = 30 * 1000;

function WebSocket(address, protocols, options) {
  if('string' === typeof protocols) {
    protocols = [protocols];
  } else if(!Array.isArray(protocols)) {
    if(typeof protocols === 'object') {
      options = protocols;
      protocols = null;
    } else {
      protocols = [];
    }
  }

  this.socket = null;
  this.closeReceived = false;
  this.bytesReceived = 0;
  this.readyState = null;
  this.supports = {};
  this.extensions = {};

  if(Array.isArray(address)) {
    var args = address.concat(options);
    args.splice(0,0,this);
    initAsServerClient.apply(this, args);
  } else {
    initAsClient(this, address, protocols, options);
  }
}

util.inherits(WebSocket, EventEmitter);

['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(state, i) {
  WebSocket.prototype[state] = WebSocket[state] = i;
});

WebSocket.prototype.close = function close(code, data) {
  switch(this.readyState) {
    case WebSocket.CLOSED:
      return;
    case WebSocket.CONNECTING:
      this.readyState = WebSocket.CLOSED;
      return;
    case WebSocket.CLOSING:
      if(this.closeReceived && this.isServer) {
        this.terminate();
      }
      return;
  }
  var self = this;
  try {
    this.readyState = WebSocket.CLOSING;
    this.closeCode = code;
    this.closeMessage = data;
    var mask = !this.isServer;
    this.sender.close(code, data, mask, function(err) {
      if(err) {
        self.emit('error', err);
      }
      if(self.closeReceived && self.isServer) {
        self.terminate();
      } else {
        clearTimeout(self.closeTimer);
        self.closeTimer = setTimeout(
          cleanupWebsocketResources.bind(self, self, true),
          closeTimeout
        );
      }
    });
  } catch(ex) {
    this.emit('error', ex);
  }
};

WebSocket.prototype.terminate = function terminate() {
  if(this.readyState === WebSocket.CLOSED) {
    return;
  }
  if(!this.socket && this.readyState === WebSocket.CONNECTING) {
    return cleanupWebsocketResources(this, true);
  }
  this.readyState = WebSocket.CLOSING;
  try {
    this.socket.end();
  } catch(e) {
    return cleanupWebsocketResources(this, true);
  }
  if(this.closeTimer) {
    clearTimeout(this.closeTimer);
  }
  this.closeTimer = setTimeout(
    cleanupWebsocketResources.bind(this, this, true),
    closeTimeout
  );
};

WebSocket.prototype.stream = function stream(options, cb) {
  if(typeof options === 'function') {
    cb = options;
    options = {};
  }

  var self = this;

  if(this.readyState !== WebSocket.OPEN) {
    return cb(new Error('not opened'));
  }

  if(this.queue) {
    return this.queue.push(function () {
      self.stream(options, cb);
    });
  }

  options = options || {};

  if(!options.mask) {
    options.mask = !this.isServer;
  }

  if(!options.compress) {
    options.compress = true;
  }

  if(!this.extensions[PerMessageDeflate.extensionName]) {
    options.compress = false;
  }

  startQueue(this);

  function send(data, final) {
    try {
      if(self.readyState !== WebSocket.OPEN) {
        throw new Error('not opened');
      }
      options.fin = final === true;
      self.sender.send(data, options);
      var ok = !final ? process.nextTick(cb.bind(null, null, send)) :
        executeQueueSends(self);
    } catch(e) {
      cb(e);
    }
  }

  process.nextTick(cb.bind(null, null, send));
};

['pause', 'resume'].forEach(function(method) {
  WebSocket.prototype[method] = function() {
    if(this.readyState !== WebSocket.OPEN) {
      throw new Error('not opened');
    }
    return this.socket[method]();
  };
});

['ping', 'pong'].forEach(function(method) {
  WebSocket.prototype[method] = function(data, options, dontFailWhenClosed) {
    if(this.readyState !== WebSocket.OPEN) {
      if(dontFailWhenClosed) {
        return;
      }
      throw new Error('not opened');
    }
    options = options || {};
    if(!options.mask) {
      options.mask = !this.isServer;
    }
    this.sender[method](data, options);
  };
});


WebSocket.prototype.send = function send(data, options, cb) {
  var self = this;
  if(typeof options === 'function') {
    cb = options;
    options = {};
  }

  if(this.readyState !== WebSocket.OPEN) {
    if(typeof cb === 'function') {
      cb(new Error('not opened'));
    } else {
      throw new Error('not opened');
    }
    return;
  }

  if(!data) {
    data = '';
  }

  if(this.queue) {
    return this.queue.push(function() {
      self.send(data, options, cb);
    });
  }

  options = options || {};
  options.fin = true;

  if(!options.binary) {
    options.binary = (
      data instanceof ArrayBuffer ||
      data instanceof Buffer ||
      data instanceof Uint8Array ||
      data instanceof Uint16Array ||
      data instanceof Uint32Array ||
      data instanceof Int8Array ||
      data instanceof Int16Array ||
      data instanceof Int32Array ||
      data instanceof Float32Array ||
      data instanceof Float64Array
    );
  }

  if(!options.mask) {
    options.mask = !this.isServer;
  }

  if(!options.compress) {
    options.compress = true;
  }

  if(!this.extensions[PerMessageDeflate.extensionName]) {
    options.compress = false;
  }

  var readable = typeof stream.Readable === 'function' ?
    stream.Readable :
    stream.Stream;

  if(data instanceof readable) {
    startQueue(this);
    sendStream(this, data, options, function(error) {
      process.nextTick(function() {
        executeQueueSends(self);
      });
      if(typeof cb === 'function') {
        cb(error);
      }
    });
  } else {
    this.sender.send(data, options, cb);
  }
};

Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
  get: function get() {
    return !this.socket ? 0 : this.socket.bufferSize;
  }
});

function buildHostHeader(isSecure, hostname, port) {
  var headerHost = hostname;
  if(hostname) {
    if((isSecure && port !== 443) || (!isSecure && port !== 80)) {
      headerHost = headerHost + ':' + port;
    }
  }
  return headerHost;
}

function initAsServerClient(self, req, socket, upgradeHead, opts) {
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

  self.protocol = options.protocol;
  self.protocolVersion = options.protocolVersion;
  self.extensions = options.extensions;
  self.supports.binary = (self.protocolVersion !== 'hixie-76');
  self.upgradeReq = req;
  self.readyState = WebSocket.CONNECTING;
  self.isServer = true;

  establishConnection(self, Receiver, Sender, socket, upgradeHead);
}


function initAsClient(self, address, protocols, opts) {
  var options = {
    protocolVersion: protocolVersion,
    perMessageDeflate: true
  };

  if(opts) {
    Object.keys(opts).forEach(function(k) {
      options[k] = opts[k];
    });
  }

  if(options.protocolVersion !== 8 && options.protocolVersion !== 13) {
    throw new Error('unsupported protocol version');
  }

  var serverUrl = url.parse(address);

  var isUnixSocket = serverUrl.protocol === 'ws+unix:';
  if(!serverUrl.host && !isUnixSocket) {
    throw new Error('invalid url');
  }
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
      typeof options.perMessageDeflate === 'object' ?
        options.perMessageDeflate :
        {},
      false
    );
    extensionsOffer[PerMessageDeflate.extensionName] =
      perMessageDeflate.offer();
  }

  // expose state properties
  self.isServer = false;
  self.url = address;
  self.protocolVersion = options.protocolVersion;
  self.supports.binary = self.protocolVersion !== 'hixie-76';

  // begin handshake
  var key = !options.clientKey ?
    new Buffer(options.protocolVersion + '-' + Date.now())
      .toString('base64') :
    options.clientKey;

  var expectedServerKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

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

  if(auth) {
    requestOptions.headers.Authorization = 'Basic ' +
      new Buffer(auth).toString('base64');
  }

  if(options.protocol) {
    requestOptions.headers['Sec-WebSocket-Protocol'] = options.protocol;
  } else if(protocols) {
    requestOptions.headers['Sec-WebSocket-Protocol'] = protocols.join(',');
    options.protocol = protocols.join(',');
  }

  if(options.host) {
    requestOptions.headers.Host = options.host;
  }

  if(options.headers) {
    for(var header in options.headers) {
       if(options.headers.hasOwnProperty(header)) {
        requestOptions.headers[header] = options.headers[header];
       }
    }
  }

  if(Object.keys(extensionsOffer).length) {
    requestOptions.headers['Sec-WebSocket-Extensions'] =
      Extensions.format(extensionsOffer);
  }

  ['pfx', 'key', 'passphrase', 'cert', 'ca', 'ciphers', 'rejectUnauthorized']
    .forEach(function(k) {
      if(k in options && options[k]) {
        requestOptions[k] = options[k];
      }
    }
  );

  requestOptions.path = serverUrl.path || '/';

  if(isUnixSocket) {
    requestOptions.socketPath = serverUrl.pathname;
  }

  if(options.origin) {
    if(options.protocolVersion < 13) {
      requestOptions.headers['Sec-WebSocket-Origin'] = options.origin;
    } else {
      requestOptions.headers.Origin = options.origin;
    }
  }

  var req = httpObj.request(requestOptions);

  req.on('error', function onerror(error) {
    self.emit('error', error);
    cleanupWebsocketResources(self, error);
  });

  req.once('response', function response(res) {
    var error;
    if(!self.emit('unexpected-response', req, res)) {
      error = new Error('unexpected server response (' + res.statusCode + ')');
      req.abort();
      self.emit('error', error);
    }
    cleanupWebsocketResources(self, error);
  });

  req.once('upgrade', function upgrade(res, socket, upgradeHead) {
    if(self.readyState === WebSocket.CLOSED) {
      self.emit('close');
      self.removeAllListeners();
      return socket.end();
    }

    var serverKey = res.headers['sec-websocket-accept'];
    if(!serverKey || serverKey !== expectedServerKey) {
      self.emit('error', 'invalid server key');
      self.removeAllListeners();
      return socket.end();
    }

    var serverProt = res.headers['sec-websocket-protocol'];
    var protList = (options.protocol || '').split(/, */);
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

    var serverExtensions = Extensions.parse(
      res.headers['sec-websocket-extensions']
    );

    if(perMessageDeflate && serverExtensions[PerMessageDeflate.extensionName]) {
      try {
        perMessageDeflate.accept(
          serverExtensions[PerMessageDeflate.extensionName]
        );
      } catch(err) {
        self.emit('error', 'invalid extension parameter');
        self.removeAllListeners();
        return socket.end();
      }
      self.extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
    }
    establishConnection(self, Receiver, Sender, socket, upgradeHead);
    req.removeAllListeners();
    req = null;
  });
  req.end();
  self.readyState = WebSocket.CONNECTING;
}


function establishConnection(self, ReceiverClass, SenderClass, socket, u) {
  var upgradeHead = u;
  var called = false;

  socket.setTimeout(0);
  socket.setNoDelay(true);

  self.receiver = new ReceiverClass(self.extensions);
  self.socket = socket;

  // socket cleanup handlers
  socket.on('end', cleanupWebsocketResources.bind(self, self));
  socket.on('close', cleanupWebsocketResources.bind(self, self));
  socket.on('error', cleanupWebsocketResources.bind(self, self));

  // ensure that the upgradeHead is added to the receiver
  function firstHandler(data) {
    if(called || self.readyState === WebSocket.CLOSED) {
      return;
    }
    called = true;

    socket.removeListener('data', firstHandler);
    socket.on('data', realHandler);

    if(upgradeHead && upgradeHead.length > 0) {
      realHandler(upgradeHead);
      upgradeHead = null;
    }

    if(data) {
      realHandler(data);
    }
  }

  // subsequent packets are pushed straight to the receiver
  function realHandler(data) {
    self.bytesReceived += data.length;
    self.receiver.add(data);
  }

  socket.on('data', firstHandler);

  // if data was passed along with the http upgrade,
  // this will schedule a push of that on to the receiver.
  // this has to be done on next tick, since the caller
  // hasn't had a chance to set event handlers on this client
  // object yet.
  process.nextTick(firstHandler);

  // receiver event handlers
  self.receiver.ontext = function ontext(data, flags) {
    flags = flags || {};
    self.emit('message', data, flags);
  };

  self.receiver.onbinary = function onbinary(data, flags) {
    flags = flags || {};
    flags.binary = true;
    self.emit('message', data, flags);
  };

  self.receiver.onping = function onping(data, flags) {
    flags = flags || {};
    self.pong(data, {
      mask: !self.isServer,
      binary: flags.binary === true
    }, true);
    self.emit('ping', data, flags);
  };

  self.receiver.onpong = function onpong(data, flags) {
    self.emit('pong', data, flags || {});
  };

  self.receiver.onclose = function onclose(code, data, flags) {
    flags = flags || {};
    self.closeReceived = true;
    self.close(code, data);
  };

  self.receiver.onerror = function onerror(reason, errorCode) {
    self.close(!errorCode ? 1002 : errorCode, '');
    self.emit('error', reason, errorCode);
  };

  // finalize the client
  self.sender = new SenderClass(socket, self.extensions);
  self.sender.on('error', function onerror(error) {
    self.close(1002, '');
    self.emit('error', error);
  });

  self.readyState = WebSocket.OPEN;
  self.emit('open');
}

function startQueue(instance) {
  instance.queue = instance.queue || [];
}

function executeQueueSends(instance) {
  var queue = instance.queue;
  if(!queue) {
    return;
  }
  delete instance.queue;
  for (var i = 0, l = queue.length; i < l; ++i) {
    queue[i]();
  }
}

function sendStream(instance, stream, options, cb) {
  stream.on('data', function incoming(data) {
    if(instance.readyState !== WebSocket.OPEN) {
      if(typeof cb === 'function') {
        cb(new Error('not opened'));
      } else {
        delete instance.queue;
        instance.emit('error', new Error('not opened'));
      }
      return;
    }
    options.fin = false;
    instance.sender.send(data, options);
  });

  stream.on('end', function end() {
    if(instance.readyState !== WebSocket.OPEN) {
      if(typeof cb === 'function') {
        cb(new Error('not opened'));
      } else {
        delete instance.queue;
        instance.emit('error', new Error('not opened'));
      }
      return;
    }

    options.fin = true;
    instance.sender.send(null, options);

    if(typeof cb === 'function') {
      cb(null);
    }
  });
}

function cleanupWebsocketResources(self, error) {
  if(self.readyState === WebSocket.CLOSED) {
    return;
  }

  var emitClose = self.readyState !== WebSocket.CONNECTING;
  self.readyState = WebSocket.CLOSED;
  clearTimeout(self.closeTimer);
  self.closeTimer = null;

  if(emitClose) {
    self.emit('close', self.closeCode || 1000, self.closeMessage || '');
  }

  if(self.socket) {
    self.socket.on('error', function onerror() {
      try { self.destroy(); } catch(e) {}
    });

    try {
      if(!error) {
        self.socket.end();
      } else {
        self.socket.destroy();
      }
    } catch(e) {
      // Ignore termination errors
    }
    self.socket = null;
  }

  if(self.sender) {
    self.sender.removeAllListeners();
    self.sender = null;
  }

  if(self.receiver) {
    self.receiver.cleanup();
    self.receiver = null;
  }

  self.removeAllListeners();
  self.on('error', function onerror() {});
  delete self.queue;
}

module.exports = WebSocket;
