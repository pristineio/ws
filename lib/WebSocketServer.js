/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var crypto = require('crypto');
var Options = require('options');
var WebSocket = require('./WebSocket');
var Extensions = require('./Extensions');
var PerMessageDeflate = require('./PerMessageDeflate');
var tls = require('tls');
var url = require('url');;

function WebSocketServer(options, callback) {
  if(this instanceof WebSocketServer === false) {
    throw new TypeError("Classes can't be function-called");
  }

  EventEmitter.call(this);

  options = new Options({
    host: '0.0.0.0',
    port: null,
    server: null,
    verifyClient: null,
    handleProtocols: null,
    path: null,
    noServer: false,
    clientTracking: true,
    perMessageDeflate: true
  }).merge(options);

  if(!options.isDefinedAndNonNull('port') && !options.isDefinedAndNonNull('server') && !options.value.noServer) {
    throw new TypeError('`port` or a `server` must be provided');
  }

  var self = this;

  if(options.isDefinedAndNonNull('port')) {
    this._server = http.createServer(function (req, res) {
      var body = http.STATUS_CODES[426];
      res.writeHead(426, {
        'Content-Length': body.length,
        'Content-Type': 'text/plain'
      });
      res.end(body);
    });
    this._server.listen(options.value.port, options.value.host, callback);
    this._closeServer = function() { if(self._server) self._server.close(); };
  }
  else if(options.value.server) {
    this._server = options.value.server;
    if(options.value.path) {
      // take note of the path, to avoid collisions when multiple websocket servers are
      // listening on the same http server
      if(this._server._webSocketPaths && options.value.server._webSocketPaths[options.value.path]) {
        throw new Error('two instances of WebSocketServer cannot listen on the same http server path');
      }
      if(typeof this._server._webSocketPaths !== 'object') {
        this._server._webSocketPaths = {};
      }
      this._server._webSocketPaths[options.value.path] = 1;
    }
  }
  if(this._server) this._server.once('listening', function() { self.emit('listening'); });

  if(typeof this._server != 'undefined') {
    this._server.on('error', function(error) {
      self.emit('error', error)
    });
    this._server.on('upgrade', function(req, socket, upgradeHead) {
      //copy upgradeHead to avoid retention of large slab buffers used in node core
      var head = new Buffer(upgradeHead.length);
      upgradeHead.copy(head);

      self.handleUpgrade(req, socket, head, function(client) {
        self.emit('connection'+req.url, client);
        self.emit('connection', client);
      });
    });
  }

  this.options = options.value;
  this.path = options.value.path;
  this.clients = [];
}

util.inherits(WebSocketServer, EventEmitter);

/**
 * Immediately shuts down the connection.
 *
 * @api public
 */

 WebSocketServer.prototype.close = function() {
  // terminate all associated clients
  var error = null;
  try {
    for (var i = 0, l = this.clients.length; i < l; ++i) {
      this.clients[i].terminate();
    }
  }
  catch (e) {
    error = e;
  }

  // remove path descriptor, if any
  if(this.path && this._server._webSocketPaths) {
    delete this._server._webSocketPaths[this.path];
    if(Object.keys(this._server._webSocketPaths).length == 0) {
      delete this._server._webSocketPaths;
    }
  }

  // close the http server if it was internally created
  try {
    if(typeof this._closeServer !== 'undefined') {
      this._closeServer();
    }
  }
  finally {
    delete this._server;
  }
  if(error) throw error;
}

/**
 * Handle a HTTP Upgrade request.
 *
 * @api public
 */

 WebSocketServer.prototype.handleUpgrade = function(req, socket, upgradeHead, cb) {
  // check for wrong path
  if(this.options.path) {
    var u = url.parse(req.url);
    if(u && u.pathname !== this.options.path) return;
  }

  if(typeof req.headers.upgrade === 'undefined' || req.headers.upgrade.toLowerCase() !== 'websocket') {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  handleHybiUpgrade.apply(this, arguments);
}

module.exports = WebSocketServer;

/**
 * Entirely private apis,
 * which may or may not be bound to a sepcific WebSocket instance.
 */

 function handleHybiUpgrade(req, socket, upgradeHead, cb) {
  // handle premature socket errors
  var errorHandler = function() {
    try { socket.destroy(); } catch (e) {}
  }
  socket.on('error', errorHandler);

  // verify key presence
  if(!req.headers['sec-websocket-key']) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  // verify version
  var version = parseInt(req.headers['sec-websocket-version']);
  if([8, 13].indexOf(version) === -1) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  // verify protocol
  var protocols = req.headers['sec-websocket-protocol'];

  // verify client
  var origin = version < 13 ?
  req.headers['sec-websocket-origin'] :
  req.headers['origin'];

  // handle extensions offer
  var extensionsOffer = Extensions.parse(req.headers['sec-websocket-extensions']);

  // handler to call when the connection sequence completes
  var self = this;
  var completeHybiUpgrade2 = function(protocol) {

    // calc key
    var key = req.headers['sec-websocket-key'];
    var shasum = crypto.createHash('sha1');
    shasum.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    key = shasum.digest('base64');

    var headers = [
    'HTTP/1.1 101 Switching Protocols'
    , 'Upgrade: websocket'
    , 'Connection: Upgrade'
    , 'Sec-WebSocket-Accept: ' + key
    ];

    if(typeof protocol != 'undefined') {
      headers.push('Sec-WebSocket-Protocol: ' + protocol);
    }

    var extensions = {};
    try {
      extensions = acceptExtensions.call(self, extensionsOffer);
    } catch (err) {
      abortConnection(socket, 400, 'Bad Request');
      return;
    }

    if(Object.keys(extensions).length) {
      var serverExtensions = {};
      Object.keys(extensions).forEach(function(token) {
        serverExtensions[token] = [extensions[token].params]
      });
      headers.push('Sec-WebSocket-Extensions: ' + Extensions.format(serverExtensions));
    }

    // allows external modification/inspection of handshake headers
    self.emit('headers', headers);

    socket.setTimeout(0);
    socket.setNoDelay(true);
    try {
      socket.write(headers.concat('', '').join('\r\n'));
    }
    catch (e) {
      // if the upgrade write fails, shut the connection down hard
      try { socket.destroy(); } catch (e) {}
      return;
    }

    var client = new WebSocket([req, socket, upgradeHead], {
      protocolVersion: version,
      protocol: protocol,
      extensions: extensions
    });

    if(self.options.clientTracking) {
      self.clients.push(client);
      client.on('close', function() {
        var index = self.clients.indexOf(client);
        if(index != -1) {
          self.clients.splice(index, 1);
        }
      });
    }

    // signal upgrade complete
    socket.removeListener('error', errorHandler);
    cb(client);
  }

  // optionally call external protocol selection handler before
  // calling completeHybiUpgrade2
  var completeHybiUpgrade1 = function() {
    // choose from the sub-protocols
    if(typeof self.options.handleProtocols == 'function') {
      var protList = (protocols || "").split(/, */);
      var callbackCalled = false;
      var res = self.options.handleProtocols(protList, function(result, protocol) {
        callbackCalled = true;
        if(!result) abortConnection(socket, 401, 'Unauthorized');
        else completeHybiUpgrade2(protocol);
      });
      if(!callbackCalled) {
            // the handleProtocols handler never called our callback
            abortConnection(socket, 501, 'Could not process protocols');
          }
          return;
        } else {
          if(typeof protocols !== 'undefined') {
            completeHybiUpgrade2(protocols.split(/, */)[0]);
          }
          else {
            completeHybiUpgrade2();
          }
        }
      }

  // optionally call external client verification handler
  if(typeof this.options.verifyClient == 'function') {
    var info = {
      origin: origin,
      secure: typeof req.connection.authorized !== 'undefined' || typeof req.connection.encrypted !== 'undefined',
      req: req
    };
    if(this.options.verifyClient.length == 2) {
      this.options.verifyClient(info, function(result, code, name) {
        if(typeof code === 'undefined') code = 401;
        if(typeof name === 'undefined') name = http.STATUS_CODES[code];

        if(!result) abortConnection(socket, code, name);
        else completeHybiUpgrade1();
      });
      return;
    }
    else if(!this.options.verifyClient(info)) {
      abortConnection(socket, 401, 'Unauthorized');
      return;
    }
  }

  completeHybiUpgrade1();
}

function acceptExtensions(offer) {
  var extensions = {};
  var options = this.options.perMessageDeflate;
  if(options && offer[PerMessageDeflate.extensionName]) {
    var perMessageDeflate = new PerMessageDeflate(options !== true ? options : {}, true);
    perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
    extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
  }
  return extensions;
}

function abortConnection(socket, code, name) {
  try {
    socket.write([
      'HTTP/1.1 ' + code + ' ' + name,
      'Content-type: text/html'
    ].concat('', '').join('\r\n'));
  } catch (e) { /* ignore errors - we've aborted this connection */
  } finally {
    // ensure that an early aborted connection is shut down completely
    try { socket.destroy(); } catch (e) {}
  }
}
