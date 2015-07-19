'use strict';
var zlib = require('zlib');
var AVAILABLE_WINDOW_BITS = [8, 9, 10, 11, 12, 13, 14, 15];
var DEFAULT_WINDOW_BITS = 15;
var DEFAULT_MEM_LEVEL = 8;

PerMessageDeflate.extensionName = 'permessage-deflate';

function PerMessageDeflate(options, isServer) {
  if(this instanceof PerMessageDeflate === false) {
    throw new TypeError('Classes can\'t be function-called');
  }
  this.options = options || {};
  this.isServer = !!isServer;
  this.inflate = null;
  this.deflate = null;
  this.params = null;
}

PerMessageDeflate.prototype.offer = function() {
  var params = {};
  if(this.options.serverNoContextTakeover) {
    params.server_no_context_takeover = true;
  }
  if(this.options.clientNoContextTakeover) {
    params.client_no_context_takeover = true;
  }
  if(this.options.serverMaxWindowBits) {
    params.server_max_window_bits = this.options.serverMaxWindowBits;
  }
  if(this.options.clientMaxWindowBits) {
    params.client_max_window_bits = this.options.clientMaxWindowBits;
  } else if(this.options.clientMaxWindowBits == null) {
    params.client_max_window_bits = true;
  }
  return params;
};

PerMessageDeflate.prototype.accept = function(paramsList) {
  paramsList = this.normalizeParams(paramsList);
  var params;
  if(this.isServer) {
    params = this.acceptAsServer(paramsList);
  } else {
    params = this.acceptAsClient(paramsList);
  }
  this.params = params;
  return params;
};

PerMessageDeflate.prototype.acceptAsServer = function(paramsList) {
  var accepted = {};
  var result = paramsList.some(function(params) {
    accepted = {};
    if(this.options.serverNoContextTakeover === false && 
      params.server_no_context_takeover) {
      return;
    }
    
    if(this.options.serverMaxWindowBits === false && 
      params.server_max_window_bits) {
      return;
    }
    
    if(typeof this.options.serverMaxWindowBits === 'number' &&
        typeof params.server_max_window_bits === 'number' &&
        this.options.serverMaxWindowBits > params.server_max_window_bits) {
      return;
    }

    if(typeof this.options.clientMaxWindowBits === 'number' && 
      !params.client_max_window_bits) {
      return;
    }

    if(this.options.serverNoContextTakeover || 
      params.server_no_context_takeover) {
      accepted.server_no_context_takeover = true;
    }
    
    if(this.options.clientNoContextTakeover) {
      accepted.client_no_context_takeover = true;
    }
    
    if(this.options.clientNoContextTakeover !== false && 
      params.client_no_context_takeover) {
      accepted.client_no_context_takeover = true;
    }
    
    if(typeof this.options.serverMaxWindowBits === 'number') {
      accepted.server_max_window_bits = this.options.serverMaxWindowBits;
    } else if(typeof params.server_max_window_bits === 'number') {
      accepted.server_max_window_bits = params.server_max_window_bits;
    }
    
    if(typeof this.options.clientMaxWindowBits === 'number') {
      accepted.client_max_window_bits = this.options.clientMaxWindowBits;
    } else if(this.options.clientMaxWindowBits !== false && 
      typeof params.client_max_window_bits === 'number') {
      accepted.client_max_window_bits = params.client_max_window_bits;
    }
    
    return true;
  }, this);

  if(!result) {
    throw new Error('Doesn\'t support the offered configuration');
  }

  return accepted;
};

PerMessageDeflate.prototype.acceptAsClient = function(paramsList) {
  var params = paramsList[0];
  if(this.options.clientNoContextTakeover != null) {
    if(this.options.clientNoContextTakeover === false && 
      params.client_no_context_takeover) {
      throw new Error('Invalid value for "client_no_context_takeover"');
    }
  }
  if(this.options.clientMaxWindowBits != null) {
    if(this.options.clientMaxWindowBits === false && 
      params.client_max_window_bits) {
      throw new Error('Invalid value for "client_max_window_bits"');
    }
    if(typeof this.options.clientMaxWindowBits === 'number' &&
        (!params.client_max_window_bits || params.client_max_window_bits > 
          this.options.clientMaxWindowBits)) {
      throw new Error('Invalid value for "client_max_window_bits"');
    }
  }
  return params;
};

PerMessageDeflate.prototype.normalizeParams = function(paramsList) {
  return paramsList.map(function(params) {
    Object.keys(params).forEach(function(key) {
      var value = params[key];
      if(value.length > 1) {
        throw new Error('Multiple extension parameters for ' + key);
      }

      value = value[0];

      switch (key) {
      case 'server_no_context_takeover':
      case 'client_no_context_takeover':
        if(value !== true) {
          throw new Error('invalid extension parameter value for ' + key + 
            ' (' + value + ')');
        }
        params[key] = true;
        break;
      case 'server_max_window_bits':
      case 'client_max_window_bits':
        if(typeof value === 'string') {
          value = parseInt(value, 10);
          if(!~AVAILABLE_WINDOW_BITS.indexOf(value)) {
            throw new Error('invalid extension parameter value for ' + key + 
              ' (' + value + ')');
          }
        }
        if(!this.isServer && value === true) {
          throw new Error('Missing extension parameter value for ' + key);
        }
        params[key] = value;
        break;
      default:
        throw new Error('Not defined extension parameter (' + key + ')');
      }
    }, this);
    return params;
  }, this);
};

PerMessageDeflate.prototype.decompress = function (data, fin, callback) {
  var endpoint = this.isServer ? 'client' : 'server';

  if(!this.inflate) {
    var maxWindowBits = this.params[endpoint + '_max_window_bits'];
    this.inflate = zlib.createInflateRaw({
      windowBits: 'number' === typeof maxWindowBits ? 
        maxWindowBits : 
        DEFAULT_WINDOW_BITS
    });
  }

  var self = this;
  var buffers = [];

  this.inflate.on('error', onError).on('data', onData);
  this.inflate.write(data);
  if(fin) {
    this.inflate.write(new Buffer([0x00, 0x00, 0xff, 0xff]));
  }
  this.inflate.flush(function() {
    cleanup();
    callback(null, Buffer.concat(buffers));
  });

  function onError(err) {
    cleanup();
    callback(err);
  }

  function onData(data) {
    buffers.push(data);
  }

  function cleanup() {
    self.inflate.removeListener('error', onError);
    self.inflate.removeListener('data', onData);
    if(fin && self.params[endpoint + '_no_context_takeover']) {
      self.inflate = null;
    }
  }
};

PerMessageDeflate.prototype.compress = function (data, fin, callback) {
  var endpoint = this.isServer ? 'server' : 'client';

  if(!this.deflate) {
    var maxWindowBits = this.params[endpoint + '_max_window_bits'];
    this.deflate = zlib.createDeflateRaw({
      flush: zlib.Z_SYNC_FLUSH,
      windowBits: 'number' === typeof maxWindowBits ? 
        maxWindowBits : 
        DEFAULT_WINDOW_BITS,
      memLevel: this.options.memLevel || DEFAULT_MEM_LEVEL
    });
  }

  var self = this;
  var buffers = [];

  this.deflate.on('error', onError).on('data', onData);
  this.deflate.write(data);
  this.deflate.flush(function() {
    cleanup();
    var data = Buffer.concat(buffers);
    if(fin) {
      data = data.slice(0, data.length - 4);
    }
    callback(null, data);
  });

  function onError(err) {
    cleanup();
    callback(err);
  }

  function onData(data) {
    buffers.push(data);
  }

  function cleanup() {
    self.deflate.removeListener('error', onError);
    self.deflate.removeListener('data', onData);
    if(fin && self.params[endpoint + '_no_context_takeover']) {
      self.deflate = null;
    }
  }
};

module.exports = PerMessageDeflate;
