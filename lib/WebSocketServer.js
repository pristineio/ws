'use strict';
//
// wsd
// Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
// MIT Licensed
//

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var crypto = require('crypto');
var WebSocket = require('./WebSocket');
var Extensions = require('./Extensions');
var PerMessageDeflate = require('./PerMessageDeflate');
var url = require('url');;

function WebSocketServer(options, callback) {
  options.perMessageDeflate = true;

  if(!('port' in options) && !('server' in options) && !options.noServer) {
    throw new TypeError('`port` or a `server` must be provided');
  }

  var self = this;

  if(options.port) {
    this.server = http.createServer(function (req, res) {
      var body = http.STATUS_CODES[426];
      res.writeHead(426, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain'
      });
      res.end(body);
    });
    this.server.listen(options.port, options.host, callback);
    this.closeServer = function() {
      if(self.server) {
        self.server.close();
      }
    };
  } else if(options.server) {
    this.server = options.server;
    if(options.path) {
      if(this.server.webSocketPaths &&
        options.server.webSocketPaths[options.path]) {
        throw new Error('two instances of WebSocketServer cannot listen on ' +
          'the same http server path');
      }
      if(typeof this.server.webSocketPaths !== 'object') {
        this.server.webSocketPaths = {};
      }
      this.server.webSocketPaths[options.path] = 1;
    }
  }

  if(this.server) {
    this.server.once('listening', function() {
      self.emit('listening');
    });
    this.server.on('error', function(error) {
      self.emit('error', error)
    });
    this.server.on('upgrade', function(req, socket, upgradeHead) {
      //copy upgradeHead to avoid retention of large slab buffers used in node
      var head = new Buffer(upgradeHead.length);
      upgradeHead.copy(head);
      self.handleUpgrade(req, socket, head, function(client) {
        self.emit('connection'+req.url, client);
        self.emit('connection', client);
      });
    });
  }

  this.options = options;
  this.path = options.path;
  this.clients = {};
}

util.inherits(WebSocketServer, EventEmitter);

WebSocketServer.prototype.close = function() {
  try {
    var self = this;
    Object.keys(self.clients).forEach(function(x) {
      if(x in self.clients) {
        self.clients[x].terminate();
      }
    });

    if(this.path && this.server.webSocketPaths) {
      delete this.server.webSocketPaths[this.path];
      if(Object.keys(this.server.webSocketPaths).length == 0) {
        delete this.server.webSocketPaths;
      }
    }

    if(typeof this.closeServer !== 'undefined') {
      this.closeServer();
    }
  } catch (e) {
    throw e;
  } finally {
    delete this.server;
  }
};

WebSocketServer.prototype.handleUpgrade = function(req, socket, u, cb) {
  var upgradeHead = u;
  if(this.options.path) {
    var u = url.parse(req.url);
    if(u && u.pathname !== this.options.path) {
      return;
    }
  }
  if(!req.headers.upgrade ||
    req.headers.upgrade.toLowerCase() !== 'websocket') {
    return abortConnection(socket, 400);
  }

  var errorHandler = function() {
    try {
      socket.destroy();
    } catch (e) {}
  }
  socket.on('error', errorHandler);

  // verify key presence
  if(!req.headers['sec-websocket-key']) {
    abortConnection(socket, 400);
    return;
  }

  // verify version
  var version = parseInt(req.headers['sec-websocket-version']);
  if(version !== 13 && version !== 8) {
    return abortConnection(socket, 400);
  }

  // verify protocol
  var protocols = req.headers['sec-websocket-protocol'];

  // verify client
  var origin = version < 13 ?
    req.headers['sec-websocket-origin'] :
    req.headers['origin'];

  // handle extensions offer
  var extensionsOffer = Extensions.parse(
    req.headers['sec-websocket-extensions']
  );

  // handler to call when the connection sequence completes
  var self = this;
  var completeHybiUpgrade2 = function(protocol) {
    var originalKey = req.headers['sec-websocket-key'];
    var key = crypto
      .createHash('sha1')
      .update(originalKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest('base64');

    var headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + key
    ];

    if(protocol) {
      headers.push('Sec-WebSocket-Protocol: ' + protocol);
    }
    var extensions = {};
    try {
      extensions = acceptExtensions(self.options, extensionsOffer);
    } catch (err) {
      return abortConnection(socket, 400);
    }

    if(Object.keys(extensions).length) {
      var serverExtensions = {};
      Object.keys(extensions).forEach(function(token) {
        serverExtensions[token] = [extensions[token].params]
      });
      headers.push('Sec-WebSocket-Extensions: ' +
        Extensions.format(serverExtensions));
    }

    // allows external modification/inspection of handshake headers
    self.emit('headers', headers);

    socket.setTimeout(0);
    socket.setNoDelay(true);
    try {
      socket.write(headers.concat('', '').join('\r\n'));
    } catch (e) {
      try { socket.destroy(); } catch(e) {}
      return;
    }

    var client = new WebSocket([req, socket, upgradeHead], {
      protocolVersion: version,
      protocol: protocol,
      extensions: extensions
    });

    self.clients[originalKey] = client;
    client.on('close', function() {
      delete self.clients[originalKey];
    });

    socket.removeListener('error', errorHandler);
    cb(client);
  };

  var completeHybiUpgrade1 = function() {
    if(typeof self.options.handleProtocols == 'function') {
      var protList = (protocols || "").split(/, */);
      var callbackCalled = false;
      var res = self.options.handleProtocols(protList,
        function(result, protocol) {
          callbackCalled = true;
          if(!result) abortConnection(socket, 401);
          else completeHybiUpgrade2(protocol);
        }
      );
      if(!callbackCalled) {
        abortConnection(socket, 501);
      }
      return;
    } else {
      if(!protocols) {
        completeHybiUpgrade2();
      } else {
        completeHybiUpgrade2(protocols.split(/, */)[0]);
      }
    }
  };

  if(typeof this.options.verifyClient == 'function') {
    var info = {
      origin: origin,
      secure: !!req.connection.authorized || !!req.connection.encrypted,
      req: req
    };
    if(this.options.verifyClient.length == 2) {
      return this.options.verifyClient(info, function(result, code) {
        if(!code) {
          code = 401;
        }
        if(!result) {
          abortConnection(socket, code);
        } else {
          completeHybiUpgrade1();
        }
      });
    } else if(!this.options.verifyClient(info)) {
      return abortConnection(socket, 401);
    }
  }
  completeHybiUpgrade1();
}

function acceptExtensions(options, offer) {
  var extensions = {};
  var options = options.perMessageDeflate;
  if(options && offer[PerMessageDeflate.extensionName]) {
    var perMessageDeflate = new PerMessageDeflate(
      !options ? options : {},
      true
    );
    perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
    extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
  }
  return extensions;
}

function abortConnection(socket, code) {
  try {
    socket.write([
      'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code],
      'Content-type: text/html'
    ].concat('', '').join('\r\n'));
  } catch (e) {
    // ignore errors - we've aborted this connection
  } finally {
    try { socket.destroy(); } catch (e) {}
  }
}

module.exports = WebSocketServer;
